"""GCache.aget / GCache.aput -- reading and writing one key directly.

For entries in a cache SHARED with another service, where the key comes from data that is
not some function's parameters. @cached cannot express that.
"""

import json
from typing import Any
from unittest.mock import patch

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


@pytest.mark.asyncio
async def test_aput_respects_a_ramped_down_use_case(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # A ramp of 0 is the kill switch for a use case. CacheController inherited an
    # ungated put, so aput wrote anyway while aget on the same key honoured the ramp --
    # one half of the API caching and the other half not.
    off = GCacheKeyConfig.enabled(60)
    for layer in CacheLayer:
        off.ramp[layer] = 0
    cache_config_provider.configs["off_uc"] = off

    before = {k for k in redis_server.keys()}
    with gcache.enable():
        await gcache.aput(_key(use_case="off_uc"), {"session_id": "abc"})
    assert {k for k in redis_server.keys()} == before, "a ramped-down use case must not be written"


@pytest.mark.asyncio
async def test_aput_writes_nothing_outside_an_enable_block(
    gcache: GCache, redis_server: redislite.Redis, enabled_uc: None
) -> None:
    # Same asymmetry from the other direction: the context switch gates reads, so it
    # has to gate writes.
    before = {k for k in redis_server.keys()}
    await gcache.aput(_key(), {"session_id": "abc"})
    assert {k for k in redis_server.keys()} == before, "aput outside enable() must not write"


@pytest.mark.asyncio
async def test_aput_survives_a_config_that_omits_the_local_layer(
    gcache: GCache, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # LocalCache reads config.ttl_sec[LOCAL] to size its TTLCache, so a config naming
    # only REMOTE raised KeyError straight out of aput. _should_cache now screens it.
    remote_only = GCacheKeyConfig(ttl_sec={CacheLayer.REMOTE: 60}, ramp={CacheLayer.REMOTE: 100})
    cache_config_provider.configs["remote_only_uc"] = remote_only

    with gcache.enable():
        await gcache.aput(_key(use_case="remote_only_uc"), {"session_id": "abc"})

        async def must_not_run() -> dict:
            raise AssertionError("the remote layer should have served this")

        assert await gcache.aget(_key(use_case="remote_only_uc"), must_not_run) == {"session_id": "abc"}


@pytest.mark.asyncio
async def test_aput_writes_redis_even_when_the_local_layer_raises(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # CacheChain.put promises both layers are attempted and the FIRST error is re-raised.
    # Without this, deleting the except/raise left the suite green -- neither half pinned.
    cache_config_provider.configs["both_uc"] = GCacheKeyConfig.enabled(60)
    chain = gcache._cache  # CacheChain over two CacheControllers
    local, remote = chain.wrapped, chain.fallback_cache

    async def local_boom(key: GCacheKey, value: Any) -> None:
        raise RuntimeError("local layer down")

    async def remote_boom(key: GCacheKey, value: Any) -> None:
        raise RuntimeError("remote layer down")

    with patch.object(local, "put", local_boom):
        with gcache.enable():
            with pytest.raises(RuntimeError, match="local layer down"):
                await gcache.aput(_key(use_case="both_uc"), {"session_id": "abc"})

    # The local failure did not stop the remote write -- which is the whole point of aput.
    assert [k for k in redis_server.keys() if b"both_uc" in k], (
        "the remote layer must be written even when the local layer raises"
    )

    # And when BOTH fail, the FIRST error is the one the caller sees.
    with patch.object(local, "put", local_boom), patch.object(remote, "put", remote_boom):
        with gcache.enable():
            with pytest.raises(RuntimeError, match="local layer down"):
                await gcache.aput(_key(use_case="both_uc"), {"session_id": "abc"})


@pytest.mark.asyncio
async def test_invalidation_does_not_reach_a_local_hit(
    gcache: GCache, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # The documented limit, pinned: LocalCache does not read watermarks, so a Go or
    # TypeScript invalidation clears the shared Redis entry but not this process's local
    # copy, which keeps serving until its own TTL runs out. The enabled_uc fixture ramps
    # LOCAL to 0, so every other test here exercises Redis only and cannot see this.
    cache_config_provider.configs["local_uc"] = GCacheKeyConfig.enabled(60)
    key = _key(use_case="local_uc", invalidation_tracking=True)

    with gcache.enable():
        await gcache.aput(key, {"session_id": "abc"})
        await gcache.ainvalidate(key.key_type, key.id)

        async def must_not_run() -> dict:
            raise AssertionError("served from the local layer, so no fallback should run")

        assert await gcache.aget(key, must_not_run) == {"session_id": "abc"}


@pytest.mark.asyncio
async def test_a_key_cannot_claim_the_reserved_watermark_use_case() -> None:
    # With invalidation_tracking the urn would be byte-identical to the key invalidate()
    # writes, so a put would overwrite the watermark with a cache value and silently
    # disable invalidation for every use case on that entity. cached() rejected this name;
    # a directly-built key skipped that check.
    from gcache.exceptions import UseCaseNameIsReserved

    with pytest.raises(UseCaseNameIsReserved):
        _key(use_case="watermark", invalidation_tracking=True)
    with pytest.raises(UseCaseNameIsReserved):
        _key(use_case="watermark")


def test_sync_get_and_put_round_trip(gcache: GCache, enabled_uc: None) -> None:
    # The sync wrappers were the two uncovered lines in gcache.py. They run the coroutine
    # on a worker thread, which is a different path from every async test in this file.
    key = _key()
    with gcache.enable():
        gcache.put(key, {"session_id": "abc"})

        def must_not_run() -> dict:
            raise AssertionError("the entry sync put wrote should have been served")

        async def fallback() -> dict:
            return must_not_run()

        assert gcache.get(key, fallback) == {"session_id": "abc"}


@pytest.mark.asyncio
async def test_sync_get_warns_when_called_from_an_async_context(
    gcache: GCache, enabled_uc: None, caplog: pytest.LogCaptureFixture
) -> None:
    # Calling the sync wrapper from a running loop blocks it. _run_coroutine_in_thread
    # warns rather than raising -- the raise is reserved for reentering from the worker
    # thread's own loop, which the sync path cannot reach from here.
    async def load() -> dict:
        return {"session_id": "abc"}

    with gcache.enable():
        with caplog.at_level("WARNING"):
            assert gcache.get(_key(), load) == {"session_id": "abc"}

    assert any("called from async context" in r.message for r in caplog.records)
