import base64
import json
import logging
import pickle
import time
from collections.abc import Iterator
from contextlib import contextmanager

import pytest
import redislite

from gcache import CacheLayer, Envelope, GCache, GCacheKeyConfig, JsonSerializer
from gcache._internal.envelope import (
    ENVELOPE_VERSION,
    EnvelopeDecodeError,
    decode,
    encode_json,
)
from gcache._internal.redis_cache import RedisValue
from tests.conftest import FakeCacheConfigProvider


@contextmanager
def caplog_at_error() -> Iterator[list[str]]:
    """Collect ERROR-level messages from gcache's logger for the duration of the block."""
    records: list[str] = []

    class _Collector(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record.getMessage() + (str(record.exc_info[1]) if record.exc_info else ""))

    handler = _Collector(level=logging.ERROR)
    logger = logging.getLogger("gcache._internal.state")
    logger.addHandler(handler)
    try:
        yield records
    finally:
        logger.removeHandler(handler)


def test_encode_json_shape_matches_typescript_port() -> None:
    # The TS port (packages/gcache-ts/src/internal/redis-cache.ts) already writes this
    # envelope. Python must produce the identical shape or the two silently diverge.
    raw = encode_json(created_at_ms=1_757_308_800_123, ttl_sec=60, payload='{"a":1}')
    assert json.loads(raw) == {
        "version": ENVELOPE_VERSION,
        "createdAtMs": 1_757_308_800_123,
        "expiresAtMs": 1_757_308_800_123 + 60_000,
        "encoding": "utf8",
        "payload": '{"a":1}',
    }


def test_encode_json_base64s_bytes() -> None:
    raw = encode_json(created_at_ms=1, ttl_sec=1, payload=b"\x00\xffbinary")
    envelope = json.loads(raw)
    assert envelope["encoding"] == "base64"
    assert base64.b64decode(envelope["payload"]) == b"\x00\xffbinary"


def test_decode_round_trips_both_envelopes() -> None:
    js = decode(encode_json(created_at_ms=42, ttl_sec=1, payload="hello"))
    assert (js.created_at_ms, js.payload) == (42, "hello")

    pk = decode(pickle.dumps(RedisValue(created_at_ms=7, payload="hello"), protocol=pickle.HIGHEST_PROTOCOL))
    assert (pk.created_at_ms, pk.payload) == (7, "hello")


def test_decode_round_trips_base64_payload() -> None:
    assert decode(encode_json(created_at_ms=1, ttl_sec=1, payload=b"\x00\xff")).payload == b"\x00\xff"


@pytest.mark.parametrize("blob", [b"", b"not an envelope", b"[1,2,3]"])
def test_decode_rejects_unknown_envelopes(blob: bytes) -> None:
    with pytest.raises(EnvelopeDecodeError):
        decode(blob)


def test_decode_discriminates_on_the_leading_byte() -> None:
    # Sniffing is only safe because the two framings can never share a leading byte.
    pickled = pickle.dumps(RedisValue(created_at_ms=1, payload="x"), protocol=pickle.HIGHEST_PROTOCOL)
    assert pickled[0] == 0x80
    assert encode_json(created_at_ms=1, ttl_sec=1, payload="x")[0:1] == b"{"
    assert decode(pickled).payload == "x"
    assert decode(encode_json(created_at_ms=1, ttl_sec=1, payload="x")).payload == "x"


@pytest.mark.asyncio
async def test_json_envelope_is_written_as_plain_json(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # Given: a use case opted into the cross-language envelope.
    cache_config_provider.configs["json_uc"] = GCacheKeyConfig.enabled(60)
    cache_config_provider.configs["json_uc"].ramp[CacheLayer.LOCAL] = 0

    @gcache.cached(
        key_type="Test", id_arg="test", use_case="json_uc", envelope=Envelope.JSON, serializer=JsonSerializer()
    )
    async def cached_func(test: int = 1) -> dict:
        return {"session_id": "abc", "created_at": "2026-09-08T02:42:19Z"}

    with gcache.enable():
        assert await cached_func(1) == {"session_id": "abc", "created_at": "2026-09-08T02:42:19Z"}

        # Then: the stored bytes are readable without Python. This is the whole point --
        # assert on the raw bytes, not on a round trip, which would pass for pickle too.
        (redis_key,) = redis_server.keys()
        stored = json.loads(redis_server.get(redis_key))
        assert stored["version"] == ENVELOPE_VERSION
        assert stored["encoding"] == "utf8"
        assert json.loads(stored["payload"]) == {"session_id": "abc", "created_at": "2026-09-08T02:42:19Z"}

        # And: it still round-trips through the cache.
        assert await cached_func(1) == {"session_id": "abc", "created_at": "2026-09-08T02:42:19Z"}


@pytest.mark.asyncio
async def test_default_envelope_is_still_pickle(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # Every existing caller must be byte-for-byte unaffected by this feature.
    cache_config_provider.configs["pickle_uc"] = GCacheKeyConfig.enabled(60)
    cache_config_provider.configs["pickle_uc"].ramp[CacheLayer.LOCAL] = 0

    @gcache.cached(key_type="Test", id_arg="test", use_case="pickle_uc")
    async def cached_func(test: int = 1) -> dict:
        return {"a": 1}

    with gcache.enable():
        await cached_func(1)
        (redis_key,) = redis_server.keys()
        raw = redis_server.get(redis_key)
        assert raw[0] == 0x80, "pickle framing"
        assert pickle.loads(raw).payload == {"a": 1}


@pytest.mark.asyncio
async def test_a_json_key_refuses_a_pickle_it_finds_and_falls_back(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # Reads still sniff the framing rather than trusting the declared envelope -- but a key
    # that declares JSON refuses the pickle branch outright, because sniffing alone would
    # leave arbitrary-code-execution reachable for anyone who can write the keyspace.
    #
    # The cost is one TTL of cold cache when a use case migrates pickle -> json: entries
    # written by the old code become misses. That is the self-healing direction, and the
    # only alternative is executing whatever a writer left behind.
    cache_config_provider.configs["sniff_uc"] = GCacheKeyConfig.enabled(60)
    cache_config_provider.configs["sniff_uc"].ramp[CacheLayer.LOCAL] = 0

    calls = 0

    @gcache.cached(
        key_type="Test", id_arg="test", use_case="sniff_uc", envelope=Envelope.JSON, serializer=JsonSerializer()
    )
    async def cached_func(test: int = 1) -> str:
        nonlocal calls
        calls += 1
        return "from-fallback"

    with gcache.enable():
        await cached_func(1)
        (redis_key,) = redis_server.keys()
        assert calls == 1

        # Overwrite with a pickle envelope, as a Python-only writer would have left it.
        redis_server.setex(
            redis_key,
            60,
            pickle.dumps(
                RedisValue(created_at_ms=int(time.time() * 1000), payload='"from-pickle"'),
                protocol=pickle.HIGHEST_PROTOCOL,
            ),
        )
        assert await cached_func(1) == "from-fallback"
        assert calls == 2, "the pickle must be treated as a miss, not unpickled"


@pytest.mark.asyncio
async def test_undecodable_value_degrades_to_a_miss(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # A corrupt entry must not be able to fail a request.
    cache_config_provider.configs["corrupt_uc"] = GCacheKeyConfig.enabled(60)
    cache_config_provider.configs["corrupt_uc"].ramp[CacheLayer.LOCAL] = 0

    calls = 0

    @gcache.cached(key_type="Test", id_arg="test", use_case="corrupt_uc")
    async def cached_func(test: int = 1) -> str:
        nonlocal calls
        calls += 1
        return "ok"

    with gcache.enable():
        await cached_func(1)
        (redis_key,) = redis_server.keys()
        redis_server.setex(redis_key, 60, b"\x01\x02 not an envelope")
        assert await cached_func(1) == "ok"
        assert calls == 2, "corrupt value should have been treated as a miss"


# --- Defects found in review: each of these decoded successfully before the fix. ---


@pytest.mark.parametrize(
    "envelope,reason",
    [
        ({"version": 2, "createdAtMs": 1, "expiresAtMs": 2, "encoding": "utf8", "payload": "x"}, "version"),
        ({"version": 1, "createdAtMs": 1, "expiresAtMs": 2, "encoding": "utf8", "payload": None}, "null payload"),
        ({"version": 1, "createdAtMs": 1, "expiresAtMs": 2, "encoding": "utf8", "payload": {"a": 1}}, "object payload"),
        ({"version": 1, "createdAtMs": 1, "expiresAtMs": 2, "encoding": "rot13", "payload": "x"}, "unknown encoding"),
    ],
)
def test_decode_rejects_envelopes_the_typescript_reader_rejects(envelope: dict, reason: str) -> None:
    # The two readers must agree about the same bytes. Accepting these silently would hand
    # a caller a future writer's data, or a non-string payload that blows up downstream in
    # a way EnvelopeDecodeError cannot catch.
    with pytest.raises(EnvelopeDecodeError):
        decode(json.dumps(envelope).encode())


@pytest.mark.parametrize(
    "blob",
    [
        b"\x80\x05truncated",  # cut short mid-pickle
        pickle.dumps({"not": "a RedisValue"}, protocol=pickle.HIGHEST_PROTOCOL),  # wrong type
    ],
)
def test_decode_wraps_pickle_failures(blob: bytes) -> None:
    # These used to escape as UnpicklingError / AttributeError, past the caller's
    # EnvelopeDecodeError guard, so the bad entry survived its whole TTL and re-failed on
    # every read.
    with pytest.raises(EnvelopeDecodeError):
        decode(blob)


def test_json_key_refuses_to_unpickle() -> None:
    # Sniffing alone would leave arbitrary-code-execution reachable for a key that declares
    # JSON. Anyone who can write the keyspace could then run code in the reader.
    pickled = pickle.dumps(RedisValue(created_at_ms=1, payload="x"), protocol=pickle.HIGHEST_PROTOCOL)
    assert decode(pickled, allow_pickle=True).payload == "x"
    with pytest.raises(EnvelopeDecodeError, match="refusing to unpickle"):
        decode(pickled, allow_pickle=False)


@pytest.mark.asyncio
async def test_plain_string_envelope_still_opts_in(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # Envelope subclasses str, so `is` comparison silently fell back to pickle for an
    # untyped caller passing "json" -- no error, and the caller believed it had opted in.
    cache_config_provider.configs["str_uc"] = GCacheKeyConfig.enabled(60)
    cache_config_provider.configs["str_uc"].ramp[CacheLayer.LOCAL] = 0

    @gcache.cached(key_type="Test", id_arg="test", use_case="str_uc", envelope="json", serializer=JsonSerializer())
    async def cached_func(test: int = 1) -> dict:
        return {"a": 1}

    with gcache.enable():
        await cached_func(1)
        (redis_key,) = redis_server.keys()
        assert json.loads(redis_server.get(redis_key))["version"] == ENVELOPE_VERSION


def test_json_envelope_without_a_serializer_is_rejected_at_decoration(gcache: GCache) -> None:
    # Knowable at decoration, so fail there rather than raising per request forever.
    with pytest.raises(ValueError, match="requires a Serializer"):

        @gcache.cached(key_type="Test", id_arg="test", use_case="no_ser_uc", envelope=Envelope.JSON)
        async def cached_func(test: int = 1) -> dict:
            return {"a": 1}


@pytest.mark.asyncio
async def test_json_serializer_reads_the_typescript_undefined_sentinel() -> None:
    # A TS writer caching `undefined` stores this sentinel; json.loads raises on it, and
    # that error escapes the caller's EnvelopeDecodeError guard, so the entry never heals.
    assert await JsonSerializer().load("__gcache_json_undefined_v1__") is None
    assert await JsonSerializer().load(b"__gcache_json_undefined_v1__") is None
    assert await JsonSerializer().load('{"a":1}') == {"a": 1}
