"""GCache.aget / GCache.aput -- reading and writing one key directly.

For entries in a cache SHARED with another service, where the key comes from data that is
not some function's parameters. @cached cannot express that.
"""

import json
from typing import Any, cast
from unittest.mock import patch

import pytest
import redislite
from cachetools import TTLCache

from gcache import CacheLayer, Envelope, GCache, GCacheKey, GCacheKeyConfig, JsonSerializer
from gcache._internal.local_cache import LocalCache
from gcache._internal.wrappers import CacheChain, CacheWrapper
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


async def _local_ttl_cache(gcache: GCache, key: GCacheKey) -> TTLCache:
    """The LocalCache's own TTLCache for ``key``.

    Two levels of ``.wrapped`` with a cast, not a type-ignore: CacheInterface doesn't
    declare ``wrapped``, so asserting the concrete types breaks loudly if the chain's
    shape changes, instead of type-checking silently against Any.
    """
    chain = cast(CacheChain, gcache._cache)
    local_controller = cast(CacheWrapper, chain.wrapped)
    local_cache = cast(LocalCache, local_controller.wrapped)
    return await local_cache._get_ttl_cache(key)


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
    # CacheChain.put writes the SHARED layer first, then local, re-raising the first error:
    # a local failure still leaves the shared entry written (below), while a shared failure
    # skips local entirely (second half). Both halves are needed to catch either regressing.
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

    # When the SHARED layer fails, that error surfaces and the local write is SKIPPED --
    # a failed prime must leave nothing cached anywhere. Writing local anyway gave this
    # process a hit for an entry no other process could read, while aput had raised.
    local_calls: list = []

    async def local_record(key: GCacheKey, value: Any) -> None:
        local_calls.append(key)

    with patch.object(local, "put", local_record), patch.object(remote, "put", remote_boom):
        with gcache.enable():
            with pytest.raises(RuntimeError, match="remote layer down"):
                await gcache.aput(_key(use_case="both_uc"), {"session_id": "abc"})
    assert local_calls == [], "a failed shared write must not leave a local-only copy"


@pytest.mark.asyncio
async def test_invalidation_does_not_reach_a_local_hit(
    gcache: GCache, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # Documented limit, pinned: LocalCache doesn't read watermarks, so a Go/Go
    # invalidation clears Redis but not this process's local copy, which keeps serving
    # until its own TTL. Every other test ramps LOCAL to 0 and can't see this.
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
    # With invalidation_tracking the urn is byte-identical to invalidate()'s watermark key,
    # so a put would overwrite it and silently disable invalidation for the entity.
    # cached() rejected this name; a directly-built key skipped that check.
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


def test_tracked_and_untracked_keys_are_not_the_same_key() -> None:
    # They render DIFFERENT Redis keys, but __hash__/__eq__ omitted invalidation_tracking,
    # so LocalCache (a dict keyed on GCacheKey) served one for the other and the watermark
    # was never consulted.
    tracked = _key(invalidation_tracking=True)
    untracked = _key(invalidation_tracking=False)

    assert tracked.urn != untracked.urn
    assert tracked != untracked
    assert hash(tracked) != hash(untracked)
    assert {tracked: "tracked"}.get(untracked) is None


@pytest.mark.asyncio
async def test_a_direct_key_cannot_contradict_a_decorated_use_case(
    gcache: GCache, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # Same urn, different framing: the decorator writes pickle, the direct key refuses that
    # pickle and writes JSON, the decorator calls the JSON a miss and writes pickle again.
    # They overwrite each other forever inside one process, with nothing raised or logged.
    from gcache.exceptions import EnvelopeMismatchWithRegisteredUseCase

    cache_config_provider.configs["clash_uc"] = GCacheKeyConfig.enabled(60)

    @gcache.cached(key_type="session_id", id_arg="sid", use_case="clash_uc")
    async def decorated(sid: str) -> dict:
        return {"session_id": sid}

    async def load() -> dict:
        return {"session_id": "abc"}

    with gcache.enable():
        # aget fails OPEN -- the README's contract is that a read never breaks the
        # request, and the decorator degrades the same way on a bad key.
        assert await gcache.aget(_key(use_case="clash_uc"), load) == {"session_id": "abc"}
        # aput raises: a silent no-op write is a lie the caller cannot detect.
        with pytest.raises(EnvelopeMismatchWithRegisteredUseCase):
            await gcache.aput(_key(use_case="clash_uc"), {"session_id": "abc"})
        # adelete does NOT. A delete needs only the urn, and both keys render the same one,
        # so rejecting it would break the documented way to delete a decorated entry --
        # test_gcache.py::test_delete_key passes a bare GCacheKey.
        await gcache.adelete(_key(use_case="clash_uc"))


@pytest.mark.asyncio
async def test_a_disabled_context_is_counted_not_silent(gcache: GCache, enabled_uc: None) -> None:
    # The three other skip reasons increment DISABLED_COUNTER; a disabled context didn't --
    # aget/aput were the fully silent path: no exception, no log, no metric, and a caller
    # believing another process could now read the entry.
    from prometheus_client import REGISTRY

    def disabled_count() -> float:
        total = 0.0
        for fam in REGISTRY.collect():
            for s in fam.samples:
                if s.name.endswith("gcache_disabled_counter_total") and s.labels.get("reason") == "context":
                    total += s.value
        return total

    before = disabled_count()
    await gcache.aput(_key(), {"session_id": "abc"})  # no enable() block
    assert disabled_count() > before, "a disabled context must be counted, not silently skipped"


def test_args_are_frozen_so_the_urn_cannot_go_stale() -> None:
    # GCacheKey is frozen=True, but args was a LIST -- so key.args.append(...) left the
    # rendered urn (the Redis key, and now this object's identity) describing the
    # pre-mutation args. Normalising to a tuple makes the freeze real.
    key = GCacheKey(
        key_type="session_id",
        id="p:r:s",
        use_case="direct_uc",
        envelope=Envelope.JSON,
        serializer=JsonSerializer(),
        args=[("a", "1")],
    )
    assert isinstance(key.args, tuple)
    with pytest.raises(AttributeError):
        key.args.append(("b", "2"))  # type: ignore[attr-defined]
    assert key.urn.endswith("?a=1#direct_uc")


@pytest.mark.asyncio
async def test_a_key_built_before_gcache_is_rejected(gcache: GCache, enabled_uc: None) -> None:
    # The prefix is global state GCache() sets from config, so a stale key built before it
    # captures the DEFAULT namespace: value and watermark land in different namespaces and
    # cluster hash slots, and tracked invalidation silently does nothing.
    from gcache._internal.state import _GLOBAL_GCACHE_STATE
    from gcache.exceptions import GCacheKeyPrefixMismatch

    stale = GCacheKey(
        key_type="session_id",
        id="p:r:s",
        use_case="direct_uc",
        envelope=Envelope.JSON,
        serializer=JsonSerializer(),
        invalidation_tracking=True,
    )
    object.__setattr__(stale, "urn_prefix", _GLOBAL_GCACHE_STATE.urn_prefix + ":stale")

    async def load() -> dict:
        return {"session_id": "abc"}

    with gcache.enable():
        # Fails open on read, raises on write -- see the clash test above.
        assert await gcache.aget(stale, load) == {"session_id": "abc"}
        with pytest.raises(GCacheKeyPrefixMismatch):
            await gcache.aput(stale, {"session_id": "abc"})
        # adelete would otherwise delete a urn in the WRONG namespace and return False,
        # which the caller reads as "no entry existed" while the real entry survives.
        with pytest.raises(GCacheKeyPrefixMismatch):
            await gcache.adelete(stale)


@pytest.mark.asyncio
async def test_resetting_the_registry_the_way_consumers_do_still_works(
    gcache: GCache, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # A consumer's conftest does `gcache._use_case_registry = set()` between tests. Making
    # that attribute a dict broke every gcache test there with "'set' object does not
    # support item assignment". It stays a set; the envelope map is separate, keyed off it.
    cache_config_provider.configs["reset_uc"] = GCacheKeyConfig.enabled(60)
    gcache._use_case_registry = set()

    @gcache.cached(key_type="session_id", id_arg="sid", use_case="reset_uc")
    async def decorated(sid: str) -> dict:
        return {"session_id": sid}

    with gcache.enable():
        assert await decorated(sid="abc") == {"session_id": "abc"}

    # And the envelope rule is inert for a name the reset removed, rather than stale.
    async def load() -> dict:
        return {"session_id": "abc"}

    gcache._use_case_registry = set()
    with gcache.enable():
        assert await gcache.aget(_key(use_case="reset_uc"), load) == {"session_id": "abc"}


@pytest.mark.asyncio
async def test_a_direct_key_cannot_contradict_a_decorated_serializer(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # Subtler than the envelope clash and worse, because nothing degrades: the two keys
    # render one urn and share one entry, so the decorated function is handed the raw
    # payload string '{"a": 1}' where it expected a dict. No exception, no log, no metric.
    from gcache.exceptions import SerializerMismatchWithRegisteredUseCase

    cache_config_provider.configs["ser_uc"] = GCacheKeyConfig.enabled(60)

    @gcache.cached(key_type="session_id", id_arg="sid", use_case="ser_uc")
    async def decorated(sid: str) -> dict:
        return {"a": 1}

    # Same use case, same PICKLE envelope, but carrying a serializer the decorator has not.
    clashing = GCacheKey(key_type="session_id", id="p:r:s", use_case="ser_uc", serializer=JsonSerializer())

    with gcache.enable():
        with pytest.raises(SerializerMismatchWithRegisteredUseCase):
            await gcache.aput(clashing, {"a": 1})
        # Deleting is fine -- same urn, and framing is irrelevant to a delete.
        await gcache.adelete(clashing)

    # The mirror -- two DIFFERENT serializer types on one use case. Both keys declare the
    # SAME envelope on purpose: with different envelopes the envelope check fires first and
    # this stops testing the serializer at all, which is how it failed when PROTO landed.
    # Two proto message types, so only the serializer differs.
    from google.protobuf import descriptor_pb2

    from gcache import ProtoSerializer

    cache_config_provider.configs["ser_uc2"] = GCacheKeyConfig.enabled(60)

    @gcache.cached(
        key_type="session_id",
        id_arg="sid",
        use_case="ser_uc2",
        envelope=Envelope.PROTO,
        serializer=ProtoSerializer(descriptor_pb2.FileOptions),
    )
    async def decorated2(sid: str) -> descriptor_pb2.FileOptions:
        return descriptor_pb2.FileOptions(go_package="example/v1")

    other_message_keyed = GCacheKey(
        key_type="session_id",
        id="p:r:s",
        use_case="ser_uc2",
        envelope=Envelope.PROTO,
        serializer=ProtoSerializer(descriptor_pb2.FieldOptions),
    )
    with gcache.enable():
        with pytest.raises(SerializerMismatchWithRegisteredUseCase):
            await gcache.aput(other_message_keyed, descriptor_pb2.FieldOptions())


@pytest.mark.asyncio
async def test_a_matching_serializer_instance_is_accepted(
    gcache: GCache, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # Compared by TYPE, not identity or equality: two JsonSerializer() instances are never
    # ==, so a stricter check would reject every legitimate caller -- which is the whole
    # point of the direct-key API.
    cache_config_provider.configs["ok_uc"] = GCacheKeyConfig.enabled(60)

    @gcache.cached(
        key_type="session_id",
        id_arg="sid",
        use_case="ok_uc",
        envelope=Envelope.JSON,
        serializer=JsonSerializer(),
    )
    async def decorated(sid: str) -> dict:
        return {"a": 1}

    matching = _key(use_case="ok_uc")  # a DIFFERENT JsonSerializer() instance
    assert matching.serializer is not None

    with gcache.enable():
        await gcache.aput(matching, {"a": 1})

        async def must_not_run() -> dict:
            raise AssertionError("the entry aput wrote should have been served")

        assert await gcache.aget(matching, must_not_run) == {"a": 1}


@pytest.mark.asyncio
async def test_a_failed_direct_key_check_is_counted_on_read(
    gcache: GCache, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # aget fails open, so the counter is the only thing standing between "misconfigured"
    # and "silently uncached forever". Same series the decorator uses for a bad key.
    from prometheus_client import REGISTRY

    def error_count() -> float:
        total = 0.0
        for fam in REGISTRY.collect():
            for s in fam.samples:
                if s.name.endswith("gcache_error_counter_total") and s.labels.get("layer") == "direct key check":
                    total += s.value
        return total

    cache_config_provider.configs["counted_uc"] = GCacheKeyConfig.enabled(60)

    @gcache.cached(key_type="session_id", id_arg="sid", use_case="counted_uc")
    async def decorated(sid: str) -> dict:
        return {"a": 1}

    async def load() -> dict:
        return {"a": 1}

    before = error_count()
    with gcache.enable():
        assert await gcache.aget(_key(use_case="counted_uc"), load) == {"a": 1}
    assert error_count() > before, "a fail-open read must still be counted"


@pytest.mark.asyncio
async def test_delete_works_with_a_bare_key_for_a_serializer_use_case(
    gcache: GCache, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # The regression the framing checks introduced: the only way to delete a decorated
    # entry is a hand-built key (test_gcache.py::test_delete_key), and applying the framing
    # checks here broke every use case declaring serializer= for a call needing only the urn.
    cache_config_provider.configs["del_uc"] = GCacheKeyConfig.enabled(60)

    @gcache.cached(key_type="Test", id_arg="test", use_case="del_uc", serializer=JsonSerializer())
    async def cached_func(test: int = 123) -> dict:
        return {"v": next(counter)}

    counter = iter(range(10))

    with gcache.enable():
        first = await cached_func(test=123)
        assert await cached_func(test=123) == first, "second call must be a hit"

        # A bare key: no serializer, default envelope. Same urn.
        await gcache.adelete(GCacheKey(key_type="Test", id="123", use_case="del_uc"))

        assert await cached_func(test=123) != first, "the entry must actually be gone"


@pytest.mark.asyncio
async def test_delete_still_rejects_a_wrong_namespace(gcache: GCache, enabled_uc: None) -> None:
    # The one check a delete must keep: a stale urn_prefix deletes a urn in another
    # namespace and returns False, which a caller reads as "no entry existed" while the
    # real entry survives.
    from gcache._internal.state import _GLOBAL_GCACHE_STATE
    from gcache.exceptions import GCacheKeyPrefixMismatch

    stale = _key()
    object.__setattr__(stale, "urn_prefix", _GLOBAL_GCACHE_STATE.urn_prefix + ":stale")

    with gcache.enable():
        with pytest.raises(GCacheKeyPrefixMismatch):
            await gcache.adelete(stale)


@pytest.mark.asyncio
async def test_two_proto_serializers_for_different_messages_are_not_interchangeable(
    gcache: GCache, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # Comparing by type alone accepted these, and it is the quietest mismatch of all:
    # load() passes ignore_unknown_fields=True, so reading a FileOptions payload as a
    # FieldOptions yields an EMPTY message with no error at all.
    from google.protobuf import descriptor_pb2

    from gcache import ProtoSerializer
    from gcache.exceptions import SerializerMismatchWithRegisteredUseCase

    cache_config_provider.configs["proto_uc"] = GCacheKeyConfig.enabled(60)

    @gcache.cached(
        key_type="session_id",
        id_arg="sid",
        use_case="proto_uc",
        envelope=Envelope.PROTO,
        serializer=ProtoSerializer(descriptor_pb2.FileOptions),
    )
    async def decorated(sid: str) -> object:
        return descriptor_pb2.FileOptions()

    other_message = GCacheKey(
        key_type="session_id",
        id="p:r:s",
        use_case="proto_uc",
        envelope=Envelope.PROTO,
        serializer=ProtoSerializer(descriptor_pb2.FieldOptions),
    )
    same_message = GCacheKey(
        key_type="session_id",
        id="p:r:s",
        use_case="proto_uc",
        envelope=Envelope.PROTO,
        serializer=ProtoSerializer(descriptor_pb2.FileOptions),
    )

    with gcache.enable():
        with pytest.raises(SerializerMismatchWithRegisteredUseCase):
            await gcache.aput(other_message, descriptor_pb2.FieldOptions())
        # A different INSTANCE for the same message is interchangeable, and must pass.
        await gcache.aput(same_message, descriptor_pb2.FileOptions(go_package="x"))


@pytest.mark.asyncio
async def test_a_partial_ramp_drops_some_primes(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # Documented and pinned so it isn't mistaken for a bug: unlike ramp 0 (the kill switch),
    # a partial ramp drops SOME primes while aput returns normally either way. Asserted by
    # fixing the sample, not by sampling, so it can't flake.
    half = GCacheKeyConfig.enabled(60)
    half.ramp[CacheLayer.LOCAL] = 0
    half.ramp[CacheLayer.REMOTE] = 50
    cache_config_provider.configs["half_uc"] = half

    def keys() -> set:
        return {k for k in redis_server.keys() if b"half_uc" in k}

    with patch("gcache._internal.wrappers.random", return_value=0.99):  # above 50/100
        with gcache.enable():
            await gcache.aput(_key(use_case="half_uc"), {"session_id": "abc"})
    assert keys() == set(), "a sample above the ramp drops the prime, silently"

    with patch("gcache._internal.wrappers.random", return_value=0.01):  # below 50/100
        with gcache.enable():
            await gcache.aput(_key(use_case="half_uc"), {"session_id": "abc"})
    assert keys(), "a sample below the ramp writes it"


@pytest.mark.asyncio
async def test_local_promotion_bypasses_the_envelope_expiry_guard(
    gcache: GCache, cache_config_provider: FakeCacheConfigProvider, redis_server: redislite.Redis
) -> None:
    # A promoted local entry gets a fresh local TTL and knows nothing about the envelope's
    # expiresAtMs, so RedisCache.get's expiry guard protects only the remote layer. NOT
    # fixed here (TTLCache has no per-item TTL); bounded by the local TTL, asserted below.
    local_ttl, remote_ttl = 30, 60
    cache_config_provider.configs["promote_uc"] = GCacheKeyConfig(
        ttl_sec={CacheLayer.LOCAL: local_ttl, CacheLayer.REMOTE: remote_ttl},
        ramp={CacheLayer.LOCAL: 100, CacheLayer.REMOTE: 100},
    )
    key = _key(use_case="promote_uc")

    calls = 0

    async def fallback() -> dict:
        nonlocal calls
        calls += 1
        return {"session_id": "fresh"}

    with gcache.enable():
        # Populate both layers, then DROP the local copy, so the next read must reach Redis.
        await gcache.aput(key, {"session_id": "cached"})
        (await _local_ttl_cache(gcache, key)).clear()

        # This read is a remote hit; the local entry it leaves behind arrived by PROMOTION,
        # not the earlier aput -- reading right after aput would leave a put-written local
        # entry, and this test's subject is what promotion stores.
        assert not await _local_ttl_cache(gcache, key), "local layer must be empty before the promoting read"
        assert await gcache.aget(key, fallback) == {"session_id": "cached"}
        assert calls == 0, "the remote layer still held the entry, so nothing should have fallen back"
        assert await _local_ttl_cache(gcache, key), "the remote hit should have promoted the entry into the local layer"

        # Stages the STORED envelope as already-expired while leaving Redis's own TTL alone
        # (the disagreement the guard exists for). keepttl=True is load-bearing: a bare SET
        # would clear the TTL and make every assertion below pass for the wrong reason.
        ttl_before = redis_server.ttl(key.urn)
        assert ttl_before > 0, "the entry should carry a Redis TTL to preserve"
        raw = redis_server.get(key.urn)
        assert raw is not None
        envelope = json.loads(raw)
        envelope["expiresAtMs"] = envelope["createdAtMs"] - 1_000
        redis_server.set(key.urn, json.dumps(envelope), keepttl=True)
        assert redis_server.ttl(key.urn) > 0, "the rewrite must preserve Redis's TTL, not persist the key"

        # With the promoted local copy still present: served, despite the envelope being expired.
        assert await gcache.aget(key, fallback) == {"session_id": "cached"}
        assert calls == 0, "the local layer served an entry whose envelope had expired"

        # Clear ONLY the local layer and read the identical key again. Now the guard is
        # reached and the same bytes are a miss.
        (await _local_ttl_cache(gcache, key)).clear()
        assert await gcache.aget(key, fallback) == {"session_id": "fresh"}
        assert calls == 1, "with no local copy, the expired envelope must be a miss"

    # And the bound, which is what makes the unfixed behaviour tolerable: the local TTL caps
    # how long the bypass can last. A local TTL above the remote TTL would widen it past the
    # entry's own declared lifetime, which is a config-review matter as much as a code one.
    ttl_cache = await _local_ttl_cache(gcache, key)
    assert ttl_cache.ttl == local_ttl
    assert ttl_cache.ttl <= remote_ttl
