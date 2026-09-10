"""GCache.aget / GCache.aput -- reading and writing one key directly.

For entries in a cache SHARED with another service, where the key comes from data that is
not some function's parameters. @cached cannot express that.
"""

import json
from typing import Any

import pytest
import redislite

from gcache import CacheLayer, Envelope, GCache, GCacheKey, GCacheKeyConfig, JsonSerializer
from tests.conftest import FakeCacheConfigProvider


def _key(use_case: str = "direct_uc", **kw: Any) -> GCacheKey:
    return GCacheKey(
        key_type="session_id",
        id="p:r:s",
        use_case=use_case,
        envelope=Envelope.JSON,
        serializer=JsonSerializer(),
        **kw,
    )


@pytest.fixture
def enabled_uc(cache_config_provider: FakeCacheConfigProvider) -> None:
    cache_config_provider.configs["direct_uc"] = GCacheKeyConfig.enabled(60)
    cache_config_provider.configs["direct_uc"].ramp[CacheLayer.LOCAL] = 0


@pytest.mark.asyncio
async def test_aget_runs_the_fallback_once_then_serves_from_cache(gcache: GCache, enabled_uc: None) -> None:
    calls = 0

    async def load() -> dict:
        nonlocal calls
        calls += 1
        return {"session_id": "abc"}

    with gcache.enable():
        assert await gcache.aget(_key(), load) == {"session_id": "abc"}
        assert await gcache.aget(_key(), load) == {"session_id": "abc"}

    # The point: the expensive read happens once, not once per caller.
    assert calls == 1


@pytest.mark.asyncio
async def test_aget_lets_the_caller_tell_a_hit_from_a_miss(gcache: GCache, enabled_uc: None) -> None:
    # Why fallback beats a plain get: a miss already fetched the row, so the caller can
    # reuse it instead of reading twice.
    with gcache.enable():
        ran = []

        async def load() -> dict:
            ran.append(True)
            return {"session_id": "abc"}

        await gcache.aget(_key(), load)
        assert ran, "first call must be a miss"

        ran.clear()
        await gcache.aget(_key(), load)
        assert not ran, "second call must be a hit, leaving the caller nothing to reuse"


@pytest.mark.asyncio
async def test_aput_primes_an_entry_no_one_has_read(
    gcache: GCache, redis_server: redislite.Redis, enabled_uc: None
) -> None:
    # Priming: the caller just created the row; nobody should read to discover it.
    with gcache.enable():
        await gcache.aput(_key(), {"session_id": "abc", "created_at": "2026-09-08T02:42:19Z"})

        async def must_not_run() -> dict:
            raise AssertionError("aput did not prime the entry; the fallback ran")

        assert await gcache.aget(_key(), must_not_run) == {
            "session_id": "abc",
            "created_at": "2026-09-08T02:42:19Z",
        }


@pytest.mark.asyncio
async def test_aput_writes_the_cross_language_envelope(
    gcache: GCache, redis_server: redislite.Redis, enabled_uc: None
) -> None:
    # Assert the stored bytes: a round trip would pass for a Python-only framing too.
    with gcache.enable():
        await gcache.aput(_key(), {"session_id": "abc"})

    (redis_key,) = [k for k in redis_server.keys() if b"watermark" not in k]
    stored = json.loads(redis_server.get(redis_key))
    assert stored["version"] == 1
    assert stored["encoding"] == "utf8"
    assert json.loads(stored["payload"]) == {"session_id": "abc"}


@pytest.mark.asyncio
async def test_direct_access_respects_a_disabled_use_case(
    gcache: GCache, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # A disabled use case must degrade to "always call the fallback". Configured
    # explicitly: the test provider returns an ENABLED config for unknown use cases, so
    # leaving it unset would prove nothing.
    disabled = GCacheKeyConfig.enabled(60)
    for layer in CacheLayer:
        disabled.ramp[layer] = 0
    cache_config_provider.configs["disabled_uc"] = disabled
    calls = 0

    async def load() -> dict:
        nonlocal calls
        calls += 1
        return {"session_id": "abc"}

    with gcache.enable():
        assert await gcache.aget(_key(use_case="disabled_uc"), load) == {"session_id": "abc"}
        assert await gcache.aget(_key(use_case="disabled_uc"), load) == {"session_id": "abc"}

    assert calls == 2, "a disabled use case must not cache"


@pytest.mark.asyncio
async def test_invalidate_reaches_an_entry_written_by_aput(gcache: GCache, enabled_uc: None) -> None:
    # The other language's invalidation must land on an entry this path wrote.
    key = _key(invalidation_tracking=True)
    with gcache.enable():
        await gcache.aput(key, {"session_id": "abc"})
        await gcache.ainvalidate(key.key_type, key.id)

        ran = []

        async def load() -> dict:
            ran.append(True)
            return {"session_id": "fresh"}

        assert await gcache.aget(key, load) == {"session_id": "fresh"}
        assert ran, "the invalidated entry must not have been served"
