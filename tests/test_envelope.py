import base64
import json
import pickle
import time
from typing import Any

import pytest
import redislite

from gcache import CacheLayer, Envelope, GCache, GCacheKeyConfig, JsonSerializer, Serializer
from gcache._internal.envelope import (
    ENVELOPE_VERSION,
    EnvelopeDecodeError,
    decode,
    encode_json,
    encode_proto,
)
from gcache._internal.metrics import GCacheMetrics
from gcache._internal.redis_cache import RedisValue
from gcache.config import GCacheKey
from gcache.exceptions import (
    EnvelopeRequiresSerializer,
    JsonEnvelopeRequiresSerializer,
    UnserializableValue,
)
from tests.conftest import FakeCacheConfigProvider


def test_encode_json_shape_is_the_shared_wire_format() -> None:
    # The Go client at go/envelope.go writes this
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
    # Reads still sniff the framing, but a key declaring JSON refuses the pickle branch
    # outright -- sniffing alone would leave arbitrary-code-execution reachable for anyone
    # who can write the keyspace.
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
def test_decode_rejects_envelopes_the_go_reader_rejects(envelope: dict, reason: str) -> None:
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
    # JsonEnvelopeRequiresSerializer, which GCacheKey raises for the same condition -- it
    # subclasses ValueError too, so `except ValueError` callers are unaffected.
    with pytest.raises(JsonEnvelopeRequiresSerializer, match="requires a serializer"):

        @gcache.cached(key_type="Test", id_arg="test", use_case="no_ser_uc", envelope=Envelope.JSON)
        async def cached_func(test: int = 1) -> dict:
            return {"a": 1}


# --- Read-path defects: each of these returned a wrong value or poisoned an entry. ---


@pytest.mark.asyncio
async def test_a_pickle_key_without_a_serializer_treats_a_json_entry_as_a_miss(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # A JSON payload is SERIALIZED, so only a Serializer turns it back into a value. Without
    # one this hands back the raw string -- a str where the caller expected a dict, nothing
    # raised. A rolling deploy reaches this: old pods declare PICKLE while new pods write JSON.
    cache_config_provider.configs["mixed_uc"] = GCacheKeyConfig.enabled(60)
    cache_config_provider.configs["mixed_uc"].ramp[CacheLayer.LOCAL] = 0

    calls = 0

    @gcache.cached(key_type="Test", id_arg="test", use_case="mixed_uc")
    async def cached_func(test: int = 1) -> dict:
        nonlocal calls
        calls += 1
        return {"a": 1}

    with gcache.enable():
        await cached_func(1)
        (redis_key,) = redis_server.keys()
        assert calls == 1

        # What a newer, JSON-writing pod would have left behind.
        redis_server.setex(
            redis_key, 60, encode_json(created_at_ms=int(time.time() * 1000), ttl_sec=60, payload='{"a":2}')
        )

        assert await cached_func(1) == {"a": 1}, "must recompute, not return the raw payload string"
        assert calls == 2


@pytest.mark.asyncio
async def test_a_payload_the_serializer_cannot_load_is_a_miss_and_heals(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # serializer.load must run inside the EnvelopeDecodeError guard: unparseable payload
    # (any non-Python writer can produce one) must not escape and poison the entry for its
    # whole TTL, with every later read paying the fallback again.
    cache_config_provider.configs["badpayload_uc"] = GCacheKeyConfig.enabled(60)
    cache_config_provider.configs["badpayload_uc"].ramp[CacheLayer.LOCAL] = 0

    calls = 0

    @gcache.cached(
        key_type="Test", id_arg="test", use_case="badpayload_uc", envelope=Envelope.JSON, serializer=JsonSerializer()
    )
    async def cached_func(test: int = 1) -> dict:
        nonlocal calls
        calls += 1
        return {"a": 1}

    with gcache.enable():
        await cached_func(1)
        (redis_key,) = redis_server.keys()

        # A structurally valid envelope whose payload is not JSON.
        redis_server.setex(
            redis_key, 60, encode_json(created_at_ms=int(time.time() * 1000), ttl_sec=60, payload="not-json")
        )

        assert await cached_func(1) == {"a": 1}
        assert calls == 2
        # Healed, not left poisoned: the next read is served from cache.
        assert await cached_func(1) == {"a": 1}
        assert calls == 2, "the miss must have rewritten the entry"


@pytest.mark.asyncio
async def test_an_undecodable_value_is_rewritten_not_just_skipped(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # Degrading to a miss is only half the contract. If the fallback's value is never
    # written back, the corrupt bytes sit there for the full TTL and every read pays twice.
    cache_config_provider.configs["rewrite_uc"] = GCacheKeyConfig.enabled(60)
    cache_config_provider.configs["rewrite_uc"].ramp[CacheLayer.LOCAL] = 0

    calls = 0

    @gcache.cached(key_type="Test", id_arg="test", use_case="rewrite_uc")
    async def cached_func(test: int = 1) -> str:
        nonlocal calls
        calls += 1
        return "ok"

    with gcache.enable():
        await cached_func(1)
        (redis_key,) = redis_server.keys()
        redis_server.setex(redis_key, 60, b"\x99 not an envelope")

        assert await cached_func(1) == "ok"
        assert calls == 2
        assert redis_server.get(redis_key) != b"\x99 not an envelope", "the corrupt value must be replaced"
        assert await cached_func(1) == "ok"
        assert calls == 2


@pytest.mark.asyncio
async def test_a_bytes_payload_round_trips_through_the_cache(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # base64 had unit coverage on decode only. This drives it through the real read/write
    # path, which is where an encoding mismatch would actually bite.
    cache_config_provider.configs["bytes_uc"] = GCacheKeyConfig.enabled(60)
    cache_config_provider.configs["bytes_uc"].ramp[CacheLayer.LOCAL] = 0

    payload = b"\x00\xffbinary\x80"

    class BytesSerializer(Serializer):
        async def dump(self, obj: Any) -> bytes:
            return obj

        async def load(self, data: bytes | str) -> bytes:
            return data if isinstance(data, bytes) else data.encode()

    calls = 0

    @gcache.cached(
        key_type="Test", id_arg="test", use_case="bytes_uc", envelope=Envelope.JSON, serializer=BytesSerializer()
    )
    async def cached_func(test: int = 1) -> bytes:
        nonlocal calls
        calls += 1
        return payload

    with gcache.enable():
        assert await cached_func(1) == payload
        (redis_key,) = redis_server.keys()
        assert json.loads(redis_server.get(redis_key))["encoding"] == "base64"
        assert await cached_func(1) == payload
        assert calls == 1, "the second read must come from cache"


@pytest.mark.asyncio
async def test_an_expired_envelope_is_a_miss_even_when_redis_still_serves_it(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # expiresAtMs and the Redis TTL can disagree (PERSIST, a longer TTL); the Go
    # reader treats a past expiresAtMs as a miss, so ignoring it here made one key answer
    # differently per language.
    cache_config_provider.configs["expired_uc"] = GCacheKeyConfig.enabled(60)
    cache_config_provider.configs["expired_uc"].ramp[CacheLayer.LOCAL] = 0

    calls = 0

    @gcache.cached(
        key_type="Test", id_arg="test", use_case="expired_uc", envelope=Envelope.JSON, serializer=JsonSerializer()
    )
    async def cached_func(test: int = 1) -> dict:
        nonlocal calls
        calls += 1
        return {"a": 1}

    with gcache.enable():
        await cached_func(1)
        (redis_key,) = redis_server.keys()
        assert calls == 1

        # Written 10s ago with a 5s lifetime, but given a long Redis TTL.
        now_ms = int(time.time() * 1000)
        redis_server.setex(redis_key, 3600, encode_json(created_at_ms=now_ms - 10_000, ttl_sec=5, payload='{"a": 2}'))

        assert await cached_func(1) == {"a": 1}
        assert calls == 2, "an envelope past its expiresAtMs must not be served"


@pytest.mark.asyncio
async def test_json_envelope_works_with_invalidation_tracking(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # Cross-language invalidation is the whole reason this envelope exists, and the
    # watermark comparison reads createdAtMs out of the JSON envelope -- so the two
    # features had to be exercised together, not just separately.
    cache_config_provider.configs["tracked_uc"] = GCacheKeyConfig.enabled(60)
    cache_config_provider.configs["tracked_uc"].ramp[CacheLayer.LOCAL] = 0

    calls = 0

    @gcache.cached(
        key_type="Test",
        id_arg="test",
        use_case="tracked_uc",
        envelope=Envelope.JSON,
        serializer=JsonSerializer(),
        track_for_invalidation=True,
    )
    async def cached_func(test: int = 1) -> dict:
        nonlocal calls
        calls += 1
        return {"a": calls}

    with gcache.enable():
        assert await cached_func(1) == {"a": 1}
        assert await cached_func(1) == {"a": 1}
        assert calls == 1, "the second read must be served from the JSON entry"

        # A tracked key is brace-wrapped so the value and its watermark share a slot.
        keys = [k.decode() for k in redis_server.keys()]
        assert any(k.startswith("{") for k in keys), keys

        await gcache.ainvalidate("Test", "1")

        assert await cached_func(1) == {"a": 2}, "the watermark must supersede the JSON entry"
        assert calls == 2


@pytest.mark.asyncio
async def test_a_pickle_key_with_a_serializer_reads_a_json_entry(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # The no-flag-day direction both docstrings claim: a key still declaring PICKLE, but
    # carrying a serializer, must read what a JSON writer left. Without this the claim
    # rested on the reverse direction only.
    cache_config_provider.configs["pickle_reader_uc"] = GCacheKeyConfig.enabled(60)
    cache_config_provider.configs["pickle_reader_uc"].ramp[CacheLayer.LOCAL] = 0

    calls = 0

    @gcache.cached(key_type="Test", id_arg="test", use_case="pickle_reader_uc", serializer=JsonSerializer())
    async def cached_func(test: int = 1) -> dict:
        nonlocal calls
        calls += 1
        return {"a": 1}

    with gcache.enable():
        await cached_func(1)
        (redis_key,) = redis_server.keys()
        assert calls == 1

        redis_server.setex(
            redis_key, 60, encode_json(created_at_ms=int(time.time() * 1000), ttl_sec=60, payload='{"a": 2}')
        )

        assert await cached_func(1) == {"a": 2}, "a serializer-carrying pickle key must read JSON"
        assert calls == 1


def test_gcache_key_rejects_an_unrecognized_envelope() -> None:
    # GCacheKey is public API. Before this, envelope="jsn" silently selected pickle --
    # put compares with == and get derives allow_pickle with !=, so both fall through.
    from gcache.config import GCacheKey

    with pytest.raises(ValueError):
        GCacheKey(key_type="Test", id="1", use_case="uc", envelope="jsn")  # type: ignore[arg-type]

    # A bare string is coerced, which is the point: the field stays typed Envelope because
    # after __post_init__ it always is one. A serializer is required alongside JSON, so
    # one is passed here -- that rule has its own test below.
    coerced = GCacheKey(
        key_type="Test",
        id="1",
        use_case="uc",
        envelope="json",  # type: ignore[arg-type]
        serializer=JsonSerializer(),
    )
    assert coerced.envelope is Envelope.JSON


def test_gcache_key_rejects_json_without_a_serializer() -> None:
    # JSON framing carries a string payload, so it needs a serializer to make one. cached()
    # rejects the pair at decoration; a directly built key was the one route left open, and
    # failed per request instead -- RedisCache swallowed the write error and only logged it.
    from gcache.config import GCacheKey
    from gcache.exceptions import GCacheError, JsonEnvelopeRequiresSerializer

    # Catchable as all three: GCacheError like every other gcache failure (a caller
    # wrapping key construction in `except GCacheError` missed it as a bare ValueError),
    # and still ValueError, which is what the Envelope coercion two lines above it raises.
    for expected in (JsonEnvelopeRequiresSerializer, GCacheError, ValueError):
        with pytest.raises(expected, match="requires a serializer"):
            GCacheKey(key_type="Test", id="1", use_case="uc", envelope=Envelope.JSON)

    GCacheKey(key_type="Test", id="1", use_case="uc", envelope=Envelope.PICKLE)


@pytest.mark.parametrize("field", ["createdAtMs", "expiresAtMs"])
def test_decode_rejects_a_non_finite_timestamp(field: str) -> None:
    # json.loads maps 1e999 to inf; int(inf) then raises OverflowError, outside this
    # function's contract, escaping the caller's miss guard and poisoning the entry for its
    # whole TTL. Go's decodeEnvelope rejects non-finite values for the same reason.
    envelope = {"version": 1, "createdAtMs": 1, "expiresAtMs": 2, "encoding": "utf8", "payload": "x"}
    raw = json.dumps({**envelope, field: 1e999}).encode()
    with pytest.raises(EnvelopeDecodeError):
        decode(raw)


def test_decode_accepts_a_large_in_range_integer_timestamp() -> None:
    # SAFE-INTEGER bound (2^53), tightened deliberately from a looser int64: above 2^53, JS
    # Go rounds the field through a float64 while Python's json.loads stays exact, so
    # int64 let both ACCEPT and silently compare different numbers.
    big = 2**52  # ~year 144000, and comfortably inside the safe-integer range
    raw = json.dumps(
        {"version": 1, "createdAtMs": big, "expiresAtMs": big, "encoding": "utf8", "payload": "x"}
    ).encode()
    assert decode(raw).created_at_ms == big

    # And a value that would make math.isfinite raise still yields EnvelopeDecodeError.
    huge = json.dumps(
        {"version": 1, "createdAtMs": 10**400, "expiresAtMs": 1, "encoding": "utf8", "payload": "x"}
    ).encode()
    with pytest.raises(EnvelopeDecodeError):
        decode(huge)


def test_decode_rejects_a_timestamp_outside_the_safe_integer_range() -> None:
    # 1e300 passes finiteness but leaves an entry no real watermark can invalidate (a
    # 301-digit int always satisfies `watermark_ms >= created_at_ms`). int64 fixed that but
    # let JS/Go round the field through a double while Python stays exact -- silently.
    for value in ("1e300", "-1e300", "9223372036854775808", "9007199254740992"):
        raw = f'{{"version":1,"createdAtMs":{value},"expiresAtMs":1,"encoding":"utf8","payload":"x"}}'.encode()
        with pytest.raises(EnvelopeDecodeError):
            decode(raw)

    # The boundary itself is legal, in both signs -- so the bound is pinned exactly rather
    # than approximately. Making the comparison exclusive fails here.
    for edge_value in (2**53 - 1, -(2**53 - 1)):
        edge = f'{{"version":1,"createdAtMs":{edge_value},"expiresAtMs":1,"encoding":"utf8","payload":"x"}}'.encode()
        assert decode(edge).created_at_ms == edge_value


def test_decode_rejects_an_integer_timestamp_past_a_double() -> None:
    # Go reads the field into a float64, so an out-of-range literal loses precision and Go
    # rejects it. Python's arbitrary-precision int accepted it, so the entry never expired
    # AND could never be invalidated -- one key, two answers.
    big = int("9" * 401)
    raw = json.dumps(
        {"version": 1, "createdAtMs": big, "expiresAtMs": big, "encoding": "utf8", "payload": "x"}
    ).encode()
    with pytest.raises(EnvelopeDecodeError):
        decode(raw)


def test_decode_wraps_a_recursion_error_from_deeply_nested_json() -> None:
    # The JSON branch caught a narrower tuple than the pickle branch, so RecursionError
    # escaped. decode promises callers exactly one exception to treat as a miss.
    raw = ('{"version":1,"createdAtMs":1,"expiresAtMs":2,"encoding":"utf8","payload":' + "[" * 200_000).encode()
    with pytest.raises(EnvelopeDecodeError):
        decode(raw)


@pytest.mark.parametrize("field", ["createdAtMs", "expiresAtMs"])
def test_decode_rejects_a_string_timestamp(field: str) -> None:
    # int("5") succeeds, which is exactly why the isinstance check exists -- Go's decoder
    # requires a number, so without this the two readers accept different bytes.
    envelope = {"version": 1, "createdAtMs": 1, "expiresAtMs": 2, "encoding": "utf8", "payload": "x"}
    with pytest.raises(EnvelopeDecodeError):
        decode(json.dumps({**envelope, field: "5"}).encode())


def test_decode_accepts_unpadded_base64() -> None:
    # Python rejects unpadded base64 where Go's RawStdEncoding path accepts it, so a
    # writer using a raw encoder would make every Python read a miss-and-rewrite while the
    # Go reader kept hitting the same key.
    raw = json.dumps(
        {"version": 1, "createdAtMs": 1, "expiresAtMs": 2, "encoding": "base64", "payload": "YWJjZGU"}
    ).encode()
    assert decode(raw).payload == b"abcde"


def test_decode_accepts_the_url_safe_base64_alphabet() -> None:
    # Go's URLEncoding accepts "-" and "_"; Python's b64decode rejects them,
    # which would make a Go writer using base64.RawURLEncoding a miss-and-rewrite for
    # Python while Go kept hitting the same key.
    payload = base64.urlsafe_b64encode(b"\xf8\xff\xfe binary").decode().rstrip("=")
    assert "-" in payload or "_" in payload, f"fixture must exercise the URL-safe chars: {payload}"
    raw = json.dumps(
        {"version": 1, "createdAtMs": 1, "expiresAtMs": 2, "encoding": "base64", "payload": payload}
    ).encode()
    assert decode(raw).payload == b"\xf8\xff\xfe binary"


def test_decode_still_rejects_a_bad_base64_alphabet() -> None:
    # Re-padding must not weaken validation into accepting non-base64 characters.
    raw = json.dumps(
        {"version": 1, "createdAtMs": 1, "expiresAtMs": 2, "encoding": "base64", "payload": "!!!!"}
    ).encode()
    with pytest.raises(EnvelopeDecodeError):
        decode(raw)


@pytest.mark.asyncio
async def test_a_serializer_returning_a_non_string_writes_nothing(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # A serializer whose dump returns non-str/bytes is the one way left to reach the write
    # guard. The caller must still get its value -- a cache must not fail a request -- and
    # nothing unreadable may be stored.
    cache_config_provider.configs["badser_uc"] = GCacheKeyConfig.enabled(60)
    cache_config_provider.configs["badser_uc"].ramp[CacheLayer.LOCAL] = 0

    class BadSerializer(Serializer):
        async def dump(self, obj: Any) -> Any:
            return {"not": "a string"}

        async def load(self, data: bytes | str) -> Any:
            return data

    @gcache.cached(
        key_type="Test", id_arg="test", use_case="badser_uc", envelope=Envelope.JSON, serializer=BadSerializer()
    )
    async def cached_func(test: int = 1) -> dict:
        return {"a": 1}

    with gcache.enable():
        assert await cached_func(1) == {"a": 1}

    assert redis_server.keys() == [], "an unwritable value must leave no entry behind"


@pytest.mark.asyncio
async def test_a_degraded_read_increments_its_counter_with_a_reason(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    """The degraded-read counter is the only signal that separates corruption from a miss.

    Every degraded path falls through to the fallback like an ordinary miss, so without
    this counter corruption is invisible on a dashboard. Nothing asserted it before.
    """
    cache_config_provider.configs["degraded_uc"] = GCacheKeyConfig.enabled(60)
    cache_config_provider.configs["degraded_uc"].ramp[CacheLayer.LOCAL] = 0

    @gcache.cached(key_type="Test", id_arg="test", use_case="degraded_uc")
    async def cached_func(test: int = 1) -> str:
        return "ok"

    counter = GCacheMetrics.MISS_COUNTER.labels("degraded_uc", "Test", CacheLayer.REMOTE.name, "undecodable")
    before = counter._value.get()

    with gcache.enable():
        await cached_func(1)
        (redis_key,) = redis_server.keys()
        redis_server.setex(redis_key, 60, b"\x99 not an envelope")
        assert await cached_func(1) == "ok"

    assert counter._value.get() == before + 1, "an undecodable entry must be counted under its own reason"


@pytest.mark.asyncio
async def test_an_expired_envelope_is_counted_separately_from_corruption(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # Distinct reasons are the point: an operator needs to tell "a foreign writer is using a
    # longer TTL than we are" apart from "the keyspace is corrupt".
    cache_config_provider.configs["expired_reason_uc"] = GCacheKeyConfig.enabled(60)
    cache_config_provider.configs["expired_reason_uc"].ramp[CacheLayer.LOCAL] = 0

    @gcache.cached(
        key_type="Test",
        id_arg="test",
        use_case="expired_reason_uc",
        envelope=Envelope.JSON,
        serializer=JsonSerializer(),
    )
    async def cached_func(test: int = 1) -> dict:
        return {"a": 1}

    counter = GCacheMetrics.MISS_COUNTER.labels("expired_reason_uc", "Test", CacheLayer.REMOTE.name, "envelope_expired")
    before = counter._value.get()

    with gcache.enable():
        await cached_func(1)
        (redis_key,) = redis_server.keys()
        now_ms = int(time.time() * 1000)
        redis_server.setex(redis_key, 3600, encode_json(created_at_ms=now_ms - 10_000, ttl_sec=5, payload='{"a": 2}'))
        await cached_func(1)

    assert counter._value.get() == before + 1


@pytest.mark.asyncio
async def test_switching_a_live_use_case_to_json_heals_rather_than_raising(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    """The pickle -> JSON migration read, end to end.

    Three things must hold together: asserting only the first would pass in a world where
    the entry stays poisoned for its whole TTL -- the bug that shipped twice on this branch.
    """
    cache_config_provider.configs["migrate_uc"] = GCacheKeyConfig.enabled(60)
    cache_config_provider.configs["migrate_uc"].ramp[CacheLayer.LOCAL] = 0

    calls = 0

    @gcache.cached(
        key_type="Test", id_arg="test", use_case="migrate_uc", envelope=Envelope.JSON, serializer=JsonSerializer()
    )
    async def cached_func(test: int = 1) -> dict:
        nonlocal calls
        calls += 1
        return {"calls": calls}

    counter = GCacheMetrics.MISS_COUNTER.labels("migrate_uc", "Test", CacheLayer.REMOTE.name, "undecodable")
    before = counter._value.get()

    with gcache.enable():
        await cached_func(1)
        (redis_key,) = redis_server.keys()

        # Exactly what the pre-migration code left behind: a real pickle envelope.
        legacy = pickle.dumps(
            RedisValue(created_at_ms=int(time.time() * 1000), payload={"calls": 999}),
            protocol=pickle.HIGHEST_PROTOCOL,
        )
        redis_server.setex(redis_key, 60, legacy)
        assert redis_server.get(redis_key)[0] == 0x80, "fixture must be a genuine pickle"

        # 1. The caller gets a real value. A refused pickle must never surface as an
        #    exception -- a cache cannot be allowed to fail a request.
        assert await cached_func(1) == {"calls": 2}

        # 2. The entry is REWRITTEN in the new framing, so the cost is one miss per key and
        #    not a permanently poisoned entry re-failing for the whole TTL.
        assert redis_server.get(redis_key)[0:1] == b"{", "the legacy pickle must be replaced"

        # 3. Which means the very next read is a hit.
        assert await cached_func(1) == {"calls": 2}
        assert calls == 2, "the healed entry must serve without re-running the fallback"

    # And it is observable: a migration shows up on the degraded-read counter rather than
    # being indistinguishable from ordinary misses.
    assert counter._value.get() == before + 1


@pytest.mark.asyncio
async def test_json_serializer_refuses_nan_and_infinity() -> None:
    # json.dumps defaults to allow_nan=True and emits NaN/Infinity/-Infinity, which are not
    # JSON: JSON.parse and Go's encoding/json both reject them, so the write would leave an
    # entry no other language can read until its TTL ran out.
    for bad in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(ValueError):
            await JsonSerializer().dump({"score": bad})

    # A finite float still round-trips.
    assert await JsonSerializer().dump({"score": 1.5}) == '{"score":1.5}'


def test_envelope_rejects_a_boolean_version() -> None:
    # isinstance(True, int) and True == 1, so `"version": true` satisfied
    # `!= ENVELOPE_VERSION` and was accepted. The Go reader's typed unmarshal rejects it
    # and Go's *int unmarshal fails on it, so Python was the only client calling it a hit.
    from gcache._internal.envelope import EnvelopeDecodeError, decode

    raw = b'{"version":true,"createdAtMs":1,"expiresAtMs":2,"encoding":"utf8","payload":"{}"}'
    with pytest.raises(EnvelopeDecodeError):
        decode(raw, allow_pickle=False)


def test_json_serializer_parses_inline_even_when_large() -> None:
    # Deliberately NOT offloaded: measured on 5.3 MB, offloading changed the max event-loop
    # tick delay not at all (0.007s inline vs 0.007-0.014s offloaded) since json.loads holds
    # the GIL throughout, as ParseFromString does -- neither needs offloading.
    import inspect

    src = inspect.getsource(JsonSerializer.load)
    assert "run_in_executor" not in src


@pytest.mark.asyncio
async def test_invalidate_writes_a_watermark_in_the_value_key_s_slot() -> None:
    # Captures the actual SETEX key -- comparing two render_prefix calls would pass even
    # with the bug restored: a hand-built watermark key rendered "{:kt:i}" against
    # GCacheKey's "{kt:i}" on an empty urn_prefix, splitting the cluster hash tag.
    from unittest.mock import AsyncMock, MagicMock, patch

    from gcache._internal.metrics import GCacheMetrics
    from gcache._internal.redis_cache import RedisCache
    from gcache._internal.state import _GLOBAL_GCACHE_STATE
    from gcache.config import GCacheKey

    original = _GLOBAL_GCACHE_STATE.urn_prefix
    try:
        for prefix in ("urn", "urn:galileo:acme", ""):
            _GLOBAL_GCACHE_STATE.urn_prefix = prefix

            fake_client = MagicMock(setex=AsyncMock())
            cache = object.__new__(RedisCache)
            with (
                patch.object(RedisCache, "client", property(lambda _self: fake_client)),
                patch.object(GCacheMetrics, "INVALIDATION_COUNTER", MagicMock(), create=True),
            ):
                await RedisCache.invalidate(cache, "kt", "i", 0)

            written = fake_client.setex.await_args.args[0]
            expected = GCacheKey(key_type="kt", id="i", use_case="u", invalidation_tracking=True).prefix
            assert written == expected + "#watermark", f"diverged at urn_prefix={prefix!r}: {written}"
    finally:
        _GLOBAL_GCACHE_STATE.urn_prefix = original


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (b"1757308800123", 1757308800123),
        (b"1757308800123.9", 1757308800123),  # Python writes an int but reads via float()
        (None, None),
        (b"abc", 2**63 - 1),  # unreadable -> suppress EVERYTHING (the max, not the min)
        (b"", 2**63 - 1),
        (b"nan", 2**63 - 1),
        (b"inf", 2**63 - 1),  # non-finite -> suppress
        (b"1e400", 2**63 - 1),  # float() gives inf, so also non-finite
        (b"1e300", 2**63 - 1),  # FINITE but out of range -> clamps high
        (b"-1e300", -(2**63)),  # FINITE out of range low -> clamps, meaning "very old"
        (b"-inf", 2**63 - 1),  # non-finite -> suppress, like nan and inf
    ],
)
def test_parse_watermark_never_raises_and_fails_closed(raw: bytes | None, expected: int | None) -> None:
    # Every one of these used to raise out of RedisCache.get (float()/int() outside the
    # guarded block). Suppresses rather than returning None: None means "no invalidation",
    # which would SERVE the entry a broken watermark should hide.
    from gcache._internal.redis_cache import _parse_watermark
    from gcache.config import GCacheKey

    key = GCacheKey(key_type="kt", id="i", use_case="u", invalidation_tracking=True)
    assert _parse_watermark(raw, key, lambda _reason: None) == expected


def test_an_unreadable_watermark_suppresses_rather_than_serving() -> None:
    # Staleness is `watermark_ms >= created_at_ms`, so suppressing needs the MAXIMUM: the
    # minimum (like None) marks nothing stale and serves the very entry a broken watermark
    # should have hidden.
    from gcache._internal.redis_cache import _WATERMARK_SUPPRESS_ALL

    created_at_ms = 1757308800123
    assert _WATERMARK_SUPPRESS_ALL >= created_at_ms, "must mark every entry stale"
    assert not (-(2**63) >= created_at_ms), "the minimum would serve it -- the bug I wrote"

    # And it must not trigger write-back: _exec_fallback re-puts only when
    # watermark_ms < now, so the maximum leaves the stored value alone. Recovery therefore
    # cannot come from the sentinel; get() deletes a non-numeric watermark instead.
    import time

    assert not (_WATERMARK_SUPPRESS_ALL < time.time() * 1e3)


@pytest.mark.asyncio
async def test_get_does_not_raise_on_a_malformed_watermark() -> None:
    # Drives RedisCache.get, not _parse_watermark alone: reverting get() to the bare
    # float()/int() pair left every parser test passing, which is what the mutation check
    # exposed. Each of these raised before (ValueError, OverflowError), outside the guard.
    from unittest.mock import AsyncMock, MagicMock, patch

    from gcache._internal.envelope import encode_json
    from gcache._internal.metrics import GCacheMetrics
    from gcache._internal.redis_cache import RedisCache
    from gcache.config import GCacheKey, JsonSerializer

    key = GCacheKey(
        key_type="kt",
        id="i",
        use_case="u",
        invalidation_tracking=True,
        envelope=Envelope.JSON,
        serializer=JsonSerializer(),
    )
    stored = encode_json(created_at_ms=1757308800123, ttl_sec=3600, payload='{"v":1}')

    for bad in (b"abc", b"", b"nan", b"inf", b"-inf", b"1e400"):
        fake = MagicMock(
            mget=AsyncMock(return_value=[stored, bad]), setex=AsyncMock(), set=AsyncMock(), delete=AsyncMock()
        )
        cache = object.__new__(RedisCache)

        async def fallback() -> dict:
            return {"v": "fresh"}

        with (
            patch.object(RedisCache, "client", property(lambda _self: fake)),
            patch.object(RedisCache, "_record_degraded_read", MagicMock()),
            patch.object(RedisCache, "put", AsyncMock()),
            patch.object(GCacheMetrics, "REQUEST_COUNTER", MagicMock(), create=True),
            patch.object(GCacheMetrics, "MISS_COUNTER", MagicMock(), create=True),
            patch.object(GCacheMetrics, "SERIALIZATION_TIMER", MagicMock(), create=True),
        ):
            # The assertion is that this RETURNS rather than raising.
            result = await RedisCache.get(cache, key, fallback)

        assert result is not None, f"watermark {bad!r} produced no answer"


def test_every_non_finite_watermark_suppresses_in_both_languages() -> None:
    # Guarding on isnan alone let -inf SERVE while nan/inf suppressed -- the one input where
    # Go (which rejects -inf) disagreed. The split is finite-vs-not, not sign: -1e300 clamps
    # as "very old" in both clients; -inf isn't a timestamp at all.
    import logging

    from gcache._internal.redis_cache import _parse_watermark
    from gcache.config import GCacheKey

    key = GCacheKey(key_type="kt", id="i", use_case="u", invalidation_tracking=True)
    created_at_ms = 1757308800123
    logging.disable(logging.WARNING)
    try:
        for raw in (b"nan", b"inf", b"-inf", b"1e400", b"abc", b""):
            parsed = _parse_watermark(raw, key, lambda _reason: None)
            # None is a distinct outcome meaning "no watermark stored", and none of these
            # may produce it -- that would SERVE the entry, same as the minimum would.
            assert parsed is not None, f"{raw!r} must not read as 'no watermark'"
            assert parsed >= created_at_ms, f"{raw!r} must suppress"

        # Finite out-of-range keeps its meaning rather than being treated as garbage.
        old_watermark = _parse_watermark(b"-1e300", key, lambda _reason: None)
        assert old_watermark is not None and old_watermark < created_at_ms, "a very old watermark stays old"
        high = _parse_watermark(b"1e300", key, lambda _reason: None)
        assert high is not None and high >= created_at_ms
    finally:
        logging.disable(logging.NOTSET)


@pytest.mark.parametrize("as_str", [False, True])
def test_decode_handles_a_str_from_decode_responses(as_str: bool) -> None:
    # decode_responses=True clients hand back str; f"{data[0]:#04x}" then raised ValueError,
    # escaping decode's one-exception contract, so the entry stayed unreadable for its whole
    # TTL with no metric moving. Reachable: a real consumer uses this pattern.
    raw = encode_json(created_at_ms=1757308800123, ttl_sec=3600, payload='{"v":1}')
    data = raw.decode() if as_str else raw

    decoded = decode(data, allow_pickle=False)

    assert decoded.payload == '{"v":1}'
    assert decoded.created_at_ms == 1757308800123


@pytest.mark.asyncio
async def test_a_suppressing_watermark_records_a_degraded_read() -> None:
    # A non-finite watermark never heals: hit rate sits at zero until its own 4h TTL.
    # Driven through RedisCache.get, not _parse_watermark alone, since the parser could be
    # correct and not wired in. Recorder is explicit: a legitimate clamp hits the same sentinel.
    from unittest.mock import AsyncMock, MagicMock, patch

    from gcache._internal.redis_cache import RedisCache

    key = GCacheKey(
        key_type="kt",
        id="i",
        use_case="u",
        invalidation_tracking=True,
        envelope=Envelope.JSON,
        serializer=JsonSerializer(),
    )
    stored = encode_json(created_at_ms=1757308800123, ttl_sec=3600, payload='{"v":1}')

    async def fallback() -> dict:
        return {"v": "fresh"}

    expected = {
        b"abc": "unreadable_watermark",
        b"": "unreadable_watermark",
        b"nan": "non_finite_watermark",
        b"inf": "non_finite_watermark",
        b"-inf": "non_finite_watermark",
        b"1e400": "non_finite_watermark",
    }
    for bad, reason in expected.items():
        fake = MagicMock(
            mget=AsyncMock(return_value=[stored, bad]), setex=AsyncMock(), set=AsyncMock(), delete=AsyncMock()
        )
        cache = object.__new__(RedisCache)
        recorder = MagicMock()
        with (
            patch.object(RedisCache, "client", property(lambda _self: fake)),
            patch.object(RedisCache, "_record_degraded_read", recorder),
            patch.object(RedisCache, "put", AsyncMock()),
            patch.object(GCacheMetrics, "REQUEST_COUNTER", MagicMock(), create=True),
            patch.object(GCacheMetrics, "MISS_COUNTER", MagicMock(), create=True),
            patch.object(GCacheMetrics, "SERIALIZATION_TIMER", MagicMock(), create=True),
        ):
            await RedisCache.get(cache, key, fallback)
        reasons = [c.args[-1] for c in recorder.call_args_list]
        assert reason in reasons, f"watermark {bad!r} recorded {reasons}, expected {reason!r}"

    # A finite out-of-range watermark clamps to the SAME sentinel but is a real instruction,
    # not corruption, so it must not be counted. Without this the test would pass on a
    # recorder that fires unconditionally.
    fake = MagicMock(
        mget=AsyncMock(return_value=[stored, b"1e300"]), setex=AsyncMock(), set=AsyncMock(), delete=AsyncMock()
    )
    cache = object.__new__(RedisCache)
    recorder = MagicMock()
    with (
        patch.object(RedisCache, "client", property(lambda _self: fake)),
        patch.object(RedisCache, "_record_degraded_read", recorder),
        patch.object(RedisCache, "put", AsyncMock()),
        patch.object(GCacheMetrics, "REQUEST_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "MISS_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "SERIALIZATION_TIMER", MagicMock(), create=True),
    ):
        await RedisCache.get(cache, key, fallback)
    clamped = [c.args[-1] for c in recorder.call_args_list]
    assert "unreadable_watermark" not in clamped and "non_finite_watermark" not in clamped, (
        f"a finite out-of-range watermark is an instruction, not corruption; got {clamped}"
    )


@pytest.mark.asyncio
async def test_a_non_numeric_watermark_is_deleted_so_the_next_read_heals() -> None:
    # The suppress-all sentinel also stops write-back, so nothing repaired a garbage
    # watermark: every read for that entity missed for up to the key's 4-hour TTL. Two reads,
    # because a single one cannot tell "recovered" from "still suppressed".
    #
    # Deliberately NOT done for a non-finite watermark -- that parses as a number, so it is
    # what a format this reader does not understand yet would look like, and deleting it
    # would silently resurrect whatever the newer writer had invalidated. Asserted below,
    # since a test of the delete alone would pass on an unconditional one.
    from unittest.mock import AsyncMock, MagicMock, patch

    from gcache._internal.metrics import GCacheMetrics
    from gcache._internal.redis_cache import RedisCache

    key = GCacheKey(
        key_type="kt",
        id="i",
        use_case="u",
        invalidation_tracking=True,
        envelope=Envelope.JSON,
        serializer=JsonSerializer(),
    )
    watermark_key = key.prefix + "#watermark"
    fresh = encode_json(created_at_ms=int(time.time() * 1000), ttl_sec=3600, payload='{"v":"stored"}')

    async def fallback() -> dict:
        return {"v": "fresh"}

    for bad, heals in ((b"oops", True), (b"", True), (b"nan", False), (b"-inf", False)):
        store: dict[str, bytes] = {key.urn: fresh, watermark_key: bad}

        async def mget(*keys: str, _store: dict[str, bytes] = store) -> list[bytes | None]:
            return [_store.get(k) for k in keys]

        async def delete(*keys: str, _store: dict[str, bytes] = store) -> int:
            return sum(_store.pop(k, None) is not None for k in keys)

        fake = MagicMock(
            mget=AsyncMock(side_effect=mget),
            setex=AsyncMock(),
            set=AsyncMock(),
            delete=AsyncMock(side_effect=delete),
        )
        cache = object.__new__(RedisCache)
        with (
            patch.object(RedisCache, "client", property(lambda _self: fake)),
            patch.object(RedisCache, "_record_degraded_read", MagicMock()),
            patch.object(RedisCache, "put", AsyncMock()),
            patch.object(GCacheMetrics, "REQUEST_COUNTER", MagicMock(), create=True),
            patch.object(GCacheMetrics, "MISS_COUNTER", MagicMock(), create=True),
            patch.object(GCacheMetrics, "SERIALIZATION_TIMER", MagicMock(), create=True),
        ):
            first = await RedisCache.get(cache, key, fallback)
            second = await RedisCache.get(cache, key, fallback)

        # The read that finds the bad watermark still fails CLOSED, either way.
        assert first == {"v": "fresh"}, f"{bad!r} must suppress on the read that finds it"
        assert (watermark_key not in store) is heals, f"{bad!r}: deleted={watermark_key not in store}"
        assert second == ({"v": "stored"} if heals else {"v": "fresh"}), f"{bad!r} second read: {second}"


@pytest.mark.asyncio
async def test_a_pickle_key_on_a_text_mode_client_warns_once() -> None:
    # A pickle blob starts 0x80, not a valid UTF-8 start byte, so decode_responses=True makes
    # client.get raise UnicodeDecodeError INSIDE redis-py, before any RedisCache guard --
    # every PICKLE use case in the process fails for its full TTL and never heals.
    from unittest.mock import AsyncMock, MagicMock, patch

    from gcache._internal.redis_cache import RedisCache

    def text_mode_client() -> MagicMock:
        c = MagicMock(get=AsyncMock(return_value=None), setex=AsyncMock(), set=AsyncMock())
        c.connection_pool.connection_kwargs = {"decode_responses": True}
        return c

    async def fallback() -> dict:
        return {"v": "fresh"}

    pickle_key = GCacheKey(key_type="kt", id="i", use_case="pickle_uc")
    json_key = GCacheKey(key_type="kt", id="i", use_case="json_uc", envelope=Envelope.JSON, serializer=JsonSerializer())

    fake = text_mode_client()
    cache = object.__new__(RedisCache)
    cache._warned_text_mode_pickle = False
    logger = MagicMock()
    with (
        patch.object(RedisCache, "client", property(lambda _self: fake)),
        patch.object(RedisCache, "put", AsyncMock()),
        patch("gcache._internal.redis_cache._GLOBAL_GCACHE_STATE.logger", logger),
        patch.object(GCacheMetrics, "REQUEST_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "MISS_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "SERIALIZATION_TIMER", MagicMock(), create=True),
    ):
        await RedisCache.get(cache, pickle_key, fallback)
        await RedisCache.get(cache, pickle_key, fallback)

    warnings = [c for c in logger.warning.call_args_list if "decode_responses=True" in str(c)]
    assert len(warnings) == 1, f"expected exactly one warning across two pickle reads, got {len(warnings)}"
    assert "pickle_uc" in str(warnings[0]), "the warning must name the use case it was first seen on"

    # A JSON-declared key on a text-mode client must ALSO warn: reads SNIFF the framing (the
    # no-flag-day migration), so a JSON key is EXPECTED to meet legacy pickle values, and
    # those raise UnicodeDecodeError before any gcache guard. Gate is client mode, not envelope.
    fake2 = text_mode_client()
    cache2 = object.__new__(RedisCache)
    cache2._warned_text_mode_pickle = False
    logger2 = MagicMock()
    with (
        patch.object(RedisCache, "client", property(lambda _self: fake2)),
        patch.object(RedisCache, "put", AsyncMock()),
        patch("gcache._internal.redis_cache._GLOBAL_GCACHE_STATE.logger", logger2),
        patch.object(GCacheMetrics, "REQUEST_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "MISS_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "SERIALIZATION_TIMER", MagicMock(), create=True),
    ):
        await RedisCache.get(cache2, json_key, fallback)
    json_warnings = [c for c in logger2.warning.call_args_list if "decode_responses=True" in str(c)]
    assert len(json_warnings) == 1, "a JSON key on a text-mode client must warn too"
    # And the message must explain the migration case, not just the declared-pickle one --
    # otherwise an operator reads it as "not my problem, my use cases are all JSON".
    assert "migration" in str(json_warnings[0]), "the warning must name the legacy-pickle case"

    # A NON-text-mode client stays silent for both, so the gate is the client mode and not
    # simply "always warn".
    quiet = MagicMock(get=AsyncMock(return_value=None), setex=AsyncMock(), set=AsyncMock())
    quiet.connection_pool.connection_kwargs = {}
    cache3 = object.__new__(RedisCache)
    cache3._warned_text_mode_pickle = False
    logger3 = MagicMock()
    with (
        patch.object(RedisCache, "client", property(lambda _self: quiet)),
        patch.object(RedisCache, "put", AsyncMock()),
        patch("gcache._internal.redis_cache._GLOBAL_GCACHE_STATE.logger", logger3),
        patch.object(GCacheMetrics, "REQUEST_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "MISS_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "SERIALIZATION_TIMER", MagicMock(), create=True),
    ):
        await RedisCache.get(cache3, pickle_key, fallback)
        await RedisCache.get(cache3, json_key, fallback)
    assert not [c for c in logger3.warning.call_args_list if "decode_responses=True" in str(c)], (
        "a byte-mode client must not warn at all"
    )

    # A client whose factory returns something without a connection_pool must not break a
    # read: a diagnostic that can fail a request is worse than the thing it reports.
    odd = MagicMock(get=AsyncMock(return_value=None), setex=AsyncMock(), set=AsyncMock())
    del odd.connection_pool
    cache2 = object.__new__(RedisCache)
    cache2._warned_text_mode_pickle = False
    with (
        patch.object(RedisCache, "client", property(lambda _self: odd)),
        patch.object(RedisCache, "put", AsyncMock()),
        patch.object(GCacheMetrics, "REQUEST_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "MISS_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "SERIALIZATION_TIMER", MagicMock(), create=True),
    ):
        assert await RedisCache.get(cache2, pickle_key, fallback) == {"v": "fresh"}


def test_an_empty_urn_prefix_is_rejected_because_it_cannot_interoperate() -> None:
    # GCache.__init__ used to silently ignore urn_prefix="". Honoring it is worse: Python's
    # render_prefix omits an empty prefix ("kt:id") while TS joins it (":kt:id"), silently
    # splitting both the value and watermark keyspace.
    import inspect

    from gcache.exceptions import EmptyUrnPrefixNotSupported
    from gcache.gcache import GCache

    # Asserted against the source because GCacheAlreadyInstantiated forbids a second
    # in-process GCache and the conftest fixture already holds one.
    src = inspect.getsource(GCache.__init__)
    assert 'if config.urn_prefix == "":' in src, "an empty prefix must be rejected, not honoured"
    assert "raise EmptyUrnPrefixNotSupported()" in src

    # It is a ValueError too, so an existing `except ValueError` around construction still
    # catches it.
    assert issubclass(EmptyUrnPrefixNotSupported, ValueError)
    assert "never hits" in str(EmptyUrnPrefixNotSupported()), "the message must say why, not just no"


def test_global_state_is_not_published_before_validation() -> None:
    # urn_prefix/logger used to be published ABOVE the Redis checks, so a RedisConfigConflict
    # left them set with no GCache existing -- __del__ clears only gcache_instantiated, so
    # the next construction inherited a namespace from a failed attempt.
    import inspect

    from gcache.gcache import GCache

    src = inspect.getsource(GCache.__init__)
    conflict = src.index("raise RedisConfigConflict()")
    publish = src.index("_GLOBAL_GCACHE_STATE.urn_prefix = config.urn_prefix")
    assert conflict < publish, "validate before mutating global state, not after"
    # And only once -- the later copy became dead code when the check moved up.
    assert src.count("raise RedisConfigConflict()") == 1


@pytest.mark.parametrize(
    ("field", "created", "expires"),
    [
        ("expiresAtMs", 1757308800123, 1757308860123.9),
        ("createdAtMs", 1757308800123.9, 1757308860123),
        ("createdAtMs", -1000.9, 900),
        ("createdAtMs", 0.5, 60000),
    ],
)
def test_a_fractional_timestamp_is_rejected_rather_than_rounded(field: str, created: float, expires: float) -> None:
    # BOTH readers compare against a threshold, so a sub-ms difference flips a boolean:
    # expiresAtMs=1000.9 at now=1000 -- floored Python calls it expired, TS (unrounded) calls
    # it a hit. Rejecting is the only outcome where both agree, and costs nothing (heals).
    raw = json.dumps(
        {
            "version": ENVELOPE_VERSION,
            "createdAtMs": created,
            "expiresAtMs": expires,
            "encoding": "utf8",
            "payload": '{"a":1}',
        }
    ).encode()
    with pytest.raises(EnvelopeDecodeError, match="whole number of milliseconds"):
        decode(raw, allow_pickle=False)


def test_a_whole_number_float_timestamp_is_still_accepted() -> None:
    # 1757308800123.0 is what json.loads gives for a value written as 1757308800123.0, and it
    # IS a whole number of milliseconds -- so the rejection must not catch it. Without this
    # the test above passes on a check that rejects every float.
    raw = json.dumps(
        {
            "version": ENVELOPE_VERSION,
            "createdAtMs": 1757308800123.0,
            "expiresAtMs": 1757308860123.0,
            "encoding": "utf8",
            "payload": '{"a":1}',
        }
    ).encode()
    got = decode(raw, allow_pickle=False)
    assert got.created_at_ms == 1757308800123
    assert got.expires_at_ms == 1757308860123
    assert isinstance(got.created_at_ms, int), "DecodedValue must still carry ints"


def test_a_stateful_serializer_can_declare_its_own_wire_identity() -> None:
    # _serializer_identity used to reduce every serializer to its class, so two stateful
    # instances with different wire formats compared EQUAL, shared a urn, and each decoded
    # the other's payload. Default is still the class, so stateless serializers are unaffected.
    from gcache.gcache import _serializer_identity

    class Stateless(Serializer):
        async def dump(self, obj: Any) -> str:
            return json.dumps(obj)

        async def load(self, data: bytes | str) -> Any:
            return json.loads(data)

    class Versioned(Serializer):
        def __init__(self, wire_version: int) -> None:
            self._wire_version = wire_version

        def wire_identity(self) -> Any:
            return (type(self), self._wire_version)

        async def dump(self, obj: Any) -> str:
            return json.dumps(obj)

        async def load(self, data: bytes | str) -> Any:
            return json.loads(data)

    # Default: the class, so two stateless instances stay interchangeable.
    assert _serializer_identity(Stateless()) == _serializer_identity(Stateless())
    assert _serializer_identity(JsonSerializer()) == _serializer_identity(JsonSerializer())
    assert _serializer_identity(None) is None

    # Overridden: different configurations no longer collide...
    assert _serializer_identity(Versioned(1)) != _serializer_identity(Versioned(2))
    # ...and identical ones still match, so a legitimate registration is not rejected.
    assert _serializer_identity(Versioned(1)) == _serializer_identity(Versioned(1))
    # And a Versioned is never interchangeable with a Stateless, despite both defaulting
    # through the same code path.
    assert _serializer_identity(Versioned(1)) != _serializer_identity(Stateless())


def test_a_failed_construction_does_not_release_the_live_instance(gcache: GCache) -> None:
    # gcache_instantiated is set LAST in __init__, so an earlier raise still finalizes the
    # half-built object. Its __del__ AttributeError (missing thread pool) also happened to
    # skip clearing a flag it doesn't own -- fixing .stop() naively would free the LIVE flag.
    import gc

    from gcache import GCacheConfig
    from gcache._internal.state import _GLOBAL_GCACHE_STATE
    from gcache.exceptions import GCacheAlreadyInstantiated
    from tests.conftest import FakeCacheConfigProvider

    assert _GLOBAL_GCACHE_STATE.gcache_instantiated, "the fixture's instance must be live"

    with pytest.raises(GCacheAlreadyInstantiated):
        GCacheConfig(cache_config_provider=FakeCacheConfigProvider()) and GCache(
            GCacheConfig(cache_config_provider=FakeCacheConfigProvider())
        )
    gc.collect()  # force the half-built object's __del__ to run now, not at interpreter exit

    assert _GLOBAL_GCACHE_STATE.gcache_instantiated, "a failed construction must not release the live instance's flag"
    # And the live instance still works -- the flag is not the only thing __del__ could have
    # torn down.
    with pytest.raises(GCacheAlreadyInstantiated):
        GCache(GCacheConfig(cache_config_provider=FakeCacheConfigProvider()))

    # Mutation-checked: reverting __del__ to the bare `.stop()` call leaves everything above
    # GREEN, since the AttributeError itself is what aborted __del__ before reaching the
    # flag. The raise and the ownership need separate assertions; neither substitutes.
    bare = object.__new__(GCache)
    bare.__del__()  # must return, not raise AttributeError on a missing thread pool
    assert _GLOBAL_GCACHE_STATE.gcache_instantiated, (
        "finalizing a never-initialized object must not clear the flag either"
    )


def test_only_the_owning_gcache_releases_the_singleton_flag(gcache: GCache) -> None:
    # Having a thread pool proves __init__ COMPLETED, not that this object is still the
    # live instance -- the destructor treated the two as the same thing, letting an
    # impostor's __del__ release the live flag. Mutation-checked against dropping owner-id.
    from gcache._internal.state import _GLOBAL_GCACHE_STATE
    from gcache.exceptions import GCacheAlreadyInstantiated

    assert _GLOBAL_GCACHE_STATE.gcache_instantiated
    assert _GLOBAL_GCACHE_STATE.gcache_owner_id == id(gcache), (
        "the live instance must be the recorded owner, or the guard below tests nothing"
    )

    # A fully-built impostor: it has a pool, so the pre-existing `pool is None` guard lets it
    # through, but it is not the owner.
    from gcache._internal.event_loop_thread import EventLoopThreadPool

    impostor = object.__new__(GCache)
    impostor._event_loop_thread_pool = EventLoopThreadPool("impostor pool")
    impostor.__del__()

    assert _GLOBAL_GCACHE_STATE.gcache_instantiated, "a non-owning GCache must not release the live instance's flag"
    assert _GLOBAL_GCACHE_STATE.gcache_owner_id == id(gcache), "ownership must be unchanged"
    # And the singleton is still enforced, which is the consequence that actually matters.
    from gcache import GCacheConfig
    from tests.conftest import FakeCacheConfigProvider

    with pytest.raises(GCacheAlreadyInstantiated):
        GCache(GCacheConfig(cache_config_provider=FakeCacheConfigProvider()))


def test_the_writer_refuses_to_frame_an_unreadable_expiry() -> None:
    # Tightening decode() without encode_json left a permanent miss reachable from
    # CONFIGURATION alone: a large ttl_sec pushes the expiry past 2^53, so every read
    # rejects and rewrites it forever. Raises rather than silently clamping to a different value.
    from gcache._internal.envelope import EnvelopeEncodeError, encode_json

    now = 1757308800123

    # The boundary is legal, so the bound is pinned exactly rather than approximately.
    ok = encode_json(created_at_ms=now, ttl_sec=(2**53 - 1 - now) // 1000, payload='{"a":1}')
    assert json.loads(ok)["expiresAtMs"] <= 2**53 - 1

    # A ttl that pushes the derived expiry past it is refused.
    with pytest.raises(EnvelopeEncodeError, match="expiresAtMs"):
        encode_json(created_at_ms=now, ttl_sec=9007199254740, payload='{"a":1}')

    # And an out-of-range created_at is refused on its own, not only via the expiry -- the
    # writer checks both fields, as the reader does.
    with pytest.raises(EnvelopeEncodeError, match="createdAtMs"):
        encode_json(created_at_ms=2**53, ttl_sec=60, payload='{"a":1}')

    # EnvelopeEncodeError is NOT an EnvelopeDecodeError: a refused write is not a miss, since
    # there is nothing stored to miss on. Conflating them would have CacheController treat it
    # as a degraded read and try to heal an entry that does not exist.
    from gcache._internal.envelope import EnvelopeDecodeError

    assert not issubclass(EnvelopeEncodeError, EnvelopeDecodeError)
    assert issubclass(EnvelopeEncodeError, ValueError)


@pytest.mark.asyncio
async def test_a_refused_write_reaches_redis_with_nothing() -> None:
    # The consequence that matters, driven through the real write path rather than the
    # helper: a refused frame must not reach Redis. Storing it is the failure mode -- an
    # entry every client rejects, rewritten on each read and rejected again.
    from unittest.mock import AsyncMock, MagicMock, patch

    from gcache._internal.envelope import EnvelopeEncodeError
    from gcache._internal.redis_cache import RedisCache

    key = GCacheKey(
        key_type="kt",
        id="i",
        use_case="u",
        envelope=Envelope.JSON,
        serializer=JsonSerializer(),
    )
    fake = MagicMock(setex=AsyncMock(), set=AsyncMock(), get=AsyncMock(return_value=None))
    cache = object.__new__(RedisCache)

    with (
        patch.object(RedisCache, "client", property(lambda _self: fake)),
        patch.object(GCacheMetrics, "SIZE_HISTOGRAM", MagicMock(), create=True),
        patch.object(GCacheMetrics, "SERIALIZATION_TIMER", MagicMock(), create=True),
    ):
        # The TTL arrives through the resolved config, which is how a real misconfiguration
        # would reach it -- a ramp/TTL provider handing out a nonsense ttl_sec, not a caller
        # passing one in.
        huge = GCacheKeyConfig(ttl_sec={CacheLayer.REMOTE: 9007199254740}, ramp={CacheLayer.REMOTE: 100})
        legal = GCacheKeyConfig(ttl_sec={CacheLayer.REMOTE: 60}, ramp={CacheLayer.REMOTE: 100})

        # The specific type, not a bare Exception -- if put() started failing for an
        # unrelated reason this assertion would otherwise still pass.
        with patch.object(RedisCache, "_resolve_config", AsyncMock(return_value=huge)):
            with pytest.raises(EnvelopeEncodeError):
                await RedisCache.put(cache, key, {"a": 1})

        # And a legal ttl on the same path DOES reach Redis, so the test above is about the
        # bound rather than about put() being broken.
        with patch.object(RedisCache, "_resolve_config", AsyncMock(return_value=legal)):
            await RedisCache.put(cache, key, {"a": 1})

    assert fake.setex.await_count == 1, "only the legal write may reach Redis"


@pytest.mark.asyncio
async def test_a_tracked_entry_outliving_the_watermark_is_distrusted() -> None:
    # A value outliving its watermark RESURRECTS silently for the rest of its TTL -- a gap
    # Go had a ceiling for and Python didn't. The READ guard matters more than any write cap,
    # since the shared keyspace holds entries this process never wrote.
    from unittest.mock import AsyncMock, MagicMock, patch

    from gcache._internal.constants import MAX_TRACKED_TTL_SECONDS
    from gcache._internal.redis_cache import RedisCache

    key = GCacheKey(
        key_type="kt",
        id="i",
        use_case="u",
        invalidation_tracking=True,
        envelope=Envelope.JSON,
        serializer=JsonSerializer(),
    )
    now = int(time.time() * 1000)

    async def fallback() -> dict:
        return {"v": "fresh"}

    # Declares a lifetime one second beyond the ENTRY CAP -- unexpired, so only the lifetime
    # guard can catch it. The bound is MAX_TRACKED_TTL_SECONDS, not the watermark lifetime:
    # the two stopped being the same number when the watermark went to 5h and the cap stayed
    # at 4h, and the guard follows the cap (see the band test below).
    too_long = encode_json(created_at_ms=now, ttl_sec=MAX_TRACKED_TTL_SECONDS + 1, payload='{"v":1}')
    fake = MagicMock(mget=AsyncMock(return_value=[too_long, None]), setex=AsyncMock(), set=AsyncMock())
    cache = object.__new__(RedisCache)
    recorder = MagicMock()
    with (
        patch.object(RedisCache, "client", property(lambda _self: fake)),
        patch.object(RedisCache, "_record_degraded_read", recorder),
        patch.object(RedisCache, "put", AsyncMock()),
        patch.object(GCacheMetrics, "REQUEST_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "MISS_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "SERIALIZATION_TIMER", MagicMock(), create=True),
    ):
        result = await RedisCache.get(cache, key, fallback)
    assert result == {"v": "fresh"}, "a distrusted entry must be a miss"
    assert "lifetime_exceeds_watermark" in [c.args[-1] for c in recorder.call_args_list]

    # Exactly at the entry cap is fine -- the bound is pinned, not approximate.
    at_bound = encode_json(created_at_ms=now, ttl_sec=MAX_TRACKED_TTL_SECONDS, payload='{"v":1}')
    fake = MagicMock(mget=AsyncMock(return_value=[at_bound, None]), setex=AsyncMock(), set=AsyncMock())
    cache = object.__new__(RedisCache)
    recorder = MagicMock()
    with (
        patch.object(RedisCache, "client", property(lambda _self: fake)),
        patch.object(RedisCache, "_record_degraded_read", recorder),
        patch.object(RedisCache, "put", AsyncMock()),
        patch.object(GCacheMetrics, "REQUEST_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "MISS_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "SERIALIZATION_TIMER", MagicMock(), create=True),
    ):
        result = await RedisCache.get(cache, key, fallback)
    assert result == {"v": 1}, "an entry at exactly the watermark TTL must still be served"
    assert "lifetime_exceeds_watermark" not in [c.args[-1] for c in recorder.call_args_list]

    # And an UNTRACKED key with the same over-long lifetime is served: it has no watermark to
    # outlive, so the guard must not fire. Without this the test would pass on a guard that
    # ignores invalidation_tracking.
    untracked = GCacheKey(key_type="kt", id="i", use_case="u", envelope=Envelope.JSON, serializer=JsonSerializer())
    fake = MagicMock(get=AsyncMock(return_value=too_long), setex=AsyncMock(), set=AsyncMock())
    cache = object.__new__(RedisCache)
    with (
        patch.object(RedisCache, "client", property(lambda _self: fake)),
        patch.object(RedisCache, "put", AsyncMock()),
        patch.object(GCacheMetrics, "REQUEST_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "MISS_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "SERIALIZATION_TIMER", MagicMock(), create=True),
    ):
        assert await RedisCache.get(cache, untracked, fallback) == {"v": 1}


@pytest.mark.asyncio
async def test_a_tracked_write_longer_than_the_watermark_is_refused() -> None:
    # The write half of the resurrection invariant, now capped at MAX_TRACKED_TTL_SECONDS
    # rather than the full watermark lifetime: the TTL cap pairs with the buffer cap so
    # buffer+TTL stays inside the watermark by construction (see constants.py). Go rejects
    # at construction (maxEntryTTL); Python's TTL arrives from a runtime provider, so the
    # write is the first point that knows it. Raises rather than caps: a cap would silently
    # shorten the TTL and hide the misconfig.
    from unittest.mock import AsyncMock, MagicMock, patch

    from gcache._internal.constants import MAX_TRACKED_TTL_SECONDS
    from gcache._internal.redis_cache import RedisCache
    from gcache.exceptions import TrackedTTLExceedsWatermark

    tracked = GCacheKey(
        key_type="kt",
        id="i",
        use_case="u",
        invalidation_tracking=True,
        envelope=Envelope.JSON,
        serializer=JsonSerializer(),
    )
    untracked = GCacheKey(key_type="kt", id="i", use_case="u", envelope=Envelope.JSON, serializer=JsonSerializer())
    fake = MagicMock(setex=AsyncMock(), set=AsyncMock())
    cache = object.__new__(RedisCache)
    over = GCacheKeyConfig(ttl_sec={CacheLayer.REMOTE: MAX_TRACKED_TTL_SECONDS + 1}, ramp={CacheLayer.REMOTE: 100})
    at = GCacheKeyConfig(ttl_sec={CacheLayer.REMOTE: MAX_TRACKED_TTL_SECONDS}, ramp={CacheLayer.REMOTE: 100})

    with (
        patch.object(RedisCache, "client", property(lambda _self: fake)),
        patch.object(GCacheMetrics, "SIZE_HISTOGRAM", MagicMock(), create=True),
        patch.object(GCacheMetrics, "SERIALIZATION_TIMER", MagicMock(), create=True),
    ):
        with patch.object(RedisCache, "_resolve_config", AsyncMock(return_value=over)):
            with pytest.raises(TrackedTTLExceedsWatermark):
                await RedisCache.put(cache, tracked, {"v": 1})
            # An UNTRACKED key with the same TTL is fine -- no watermark to outlive.
            await RedisCache.put(cache, untracked, {"v": 1})
        # And exactly at the bound is allowed for a tracked key.
        with patch.object(RedisCache, "_resolve_config", AsyncMock(return_value=at)):
            await RedisCache.put(cache, tracked, {"v": 1})

    assert fake.setex.await_count == 2, "only the refused tracked write must be blocked"


@pytest.mark.asyncio
async def test_a_stale_tracked_pickle_entry_is_distrusted_by_age() -> None:
    # The declared-lifetime guard reads expires_at_ms (JSON-only), missing legacy PICKLE
    # entries. Age (created_at_ms, both framings) is sharper: any watermark old enough to
    # mark it stale has itself expired. Not over-broad: Redis would evict a shorter-TTL entry first.
    from unittest.mock import AsyncMock, MagicMock, patch

    from gcache._internal.constants import WATERMARK_TTL_SECONDS
    from gcache._internal.redis_cache import RedisCache, RedisValue

    key = GCacheKey(key_type="kt", id="i", use_case="u", invalidation_tracking=True)
    now = time.time() * 1000

    async def fallback() -> dict:
        return {"v": "fresh"}

    def read(created_at_ms: float, k: GCacheKey = key) -> tuple:
        blob = pickle.dumps(RedisValue(created_at_ms=int(created_at_ms), payload={"v": "cached"}))
        fake = MagicMock(
            mget=AsyncMock(return_value=[blob, None]),
            get=AsyncMock(return_value=blob),
            setex=AsyncMock(),
            set=AsyncMock(),
        )
        return fake, object.__new__(RedisCache)

    # Older than the watermark TTL -> distrusted, even though it is a pickle entry with no
    # expires_at_ms for the declared-lifetime guard to inspect.
    fake, cache = read(now - (WATERMARK_TTL_SECONDS + 60) * 1000)
    recorder = MagicMock()
    with (
        patch.object(RedisCache, "client", property(lambda _self: fake)),
        patch.object(RedisCache, "_record_degraded_read", recorder),
        patch.object(RedisCache, "put", AsyncMock()),
        patch.object(GCacheMetrics, "REQUEST_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "MISS_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "SERIALIZATION_TIMER", MagicMock(), create=True),
    ):
        assert await RedisCache.get(cache, key, fallback) == {"v": "fresh"}
    assert "age_exceeds_watermark" in [c.args[-1] for c in recorder.call_args_list]

    # A FRESH tracked pickle entry is served -- so the guard is about age, not about pickle.
    fake, cache = read(now - 60_000)
    recorder = MagicMock()
    with (
        patch.object(RedisCache, "client", property(lambda _self: fake)),
        patch.object(RedisCache, "_record_degraded_read", recorder),
        patch.object(RedisCache, "put", AsyncMock()),
        patch.object(GCacheMetrics, "REQUEST_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "MISS_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "SERIALIZATION_TIMER", MagicMock(), create=True),
    ):
        assert await RedisCache.get(cache, key, fallback) == {"v": "cached"}
    assert "age_exceeds_watermark" not in [c.args[-1] for c in recorder.call_args_list]

    # And an UNTRACKED old entry is served -- no watermark to outlive, so nothing to distrust.
    untracked = GCacheKey(key_type="kt", id="i", use_case="u")
    fake, cache = read(now - (WATERMARK_TTL_SECONDS + 60) * 1000, untracked)
    with (
        patch.object(RedisCache, "client", property(lambda _self: fake)),
        patch.object(RedisCache, "put", AsyncMock()),
        patch.object(GCacheMetrics, "REQUEST_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "MISS_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "SERIALIZATION_TIMER", MagicMock(), create=True),
    ):
        assert await RedisCache.get(cache, untracked, fallback) == {"v": "cached"}


@pytest.mark.asyncio
async def test_each_degraded_reason_goes_to_the_right_guard() -> None:
    # Guards overlap, so ORDER decides the reported reason: placed before the expiry guard,
    # the age check stole envelope_expired's label for an entry whose Redis TTL outlived its
    # envelope (PERSIST, a longer TTL) -- sending an operator to the wrong system.
    from unittest.mock import AsyncMock, MagicMock, patch

    from gcache._internal.constants import WATERMARK_TTL_SECONDS
    from gcache._internal.redis_cache import RedisCache, RedisValue

    now = int(time.time() * 1000)
    json_key = GCacheKey(
        key_type="kt",
        id="i",
        use_case="u",
        invalidation_tracking=True,
        envelope=Envelope.JSON,
        serializer=JsonSerializer(),
    )
    pickle_key = GCacheKey(key_type="kt", id="i", use_case="u", invalidation_tracking=True)

    async def fb() -> dict:
        return {"v": "fresh"}

    async def reasons_for(stored: bytes, key: GCacheKey) -> list[str]:
        fake = MagicMock(mget=AsyncMock(return_value=[stored, None]), setex=AsyncMock(), set=AsyncMock())
        cache = object.__new__(RedisCache)
        rec = MagicMock()
        with (
            patch.object(RedisCache, "client", property(lambda _s: fake)),
            patch.object(RedisCache, "_record_degraded_read", rec),
            patch.object(RedisCache, "put", AsyncMock()),
            patch.object(GCacheMetrics, "REQUEST_COUNTER", MagicMock(), create=True),
            patch.object(GCacheMetrics, "MISS_COUNTER", MagicMock(), create=True),
            patch.object(GCacheMetrics, "SERIALIZATION_TIMER", MagicMock(), create=True),
        ):
            await RedisCache.get(cache, key, fb)
        return [c.args[-1] for c in rec.call_args_list]

    # Expired AND over-age: expiry wins, because that is the label's case.
    expired_and_old = encode_json(created_at_ms=now - 5 * 3600 * 1000, ttl_sec=int(3.5 * 3600), payload='{"v":1}')
    assert await reasons_for(expired_and_old, json_key) == ["envelope_expired"]

    # Unexpired but declaring too long a life: the declared-lifetime guard, which sits first
    # because it is about the CONTRACT rather than about this entry's clock.
    too_long = encode_json(created_at_ms=now, ttl_sec=WATERMARK_TTL_SECONDS + 1, payload='{"v":1}')
    assert await reasons_for(too_long, json_key) == ["lifetime_exceeds_watermark"]

    # And the age guard is unreachable for JSON -- the two above imply it. Not a gap: serving
    # needs now < expiresAtMs and expiresAtMs - createdAtMs <= watermarkTTL, which together
    # give now - createdAtMs < watermarkTTL.
    for ttl in (60, int(3.5 * 3600), WATERMARK_TTL_SECONDS):
        for age_h in (0, 1, 5, 9):
            e = encode_json(created_at_ms=now - age_h * 3600 * 1000, ttl_sec=ttl, payload='{"v":1}')
            assert "age_exceeds_watermark" not in await reasons_for(e, json_key), (
                f"age guard should be unreachable for JSON (ttl={ttl}s age={age_h}h)"
            )

    # PICKLE is where it is load-bearing: no expires_at_ms, so both guards above skip it.
    old_pickle = pickle.dumps(RedisValue(created_at_ms=now - (WATERMARK_TTL_SECONDS + 60) * 1000, payload={"v": 1}))
    assert await reasons_for(old_pickle, pickle_key) == ["age_exceeds_watermark"]


def test_a_prefix_carrying_a_grammar_delimiter_is_refused() -> None:
    # Go's New refuses {}#? too. A brace is the dangerous one: it moves the Redis Cluster
    # hash tag, so a value and its watermark stop sharing a slot and the single MGET that
    # reads both becomes illegal.
    from gcache import GCache, GCacheConfig
    from gcache.exceptions import UrnPrefixContainsDelimiter
    from tests.conftest import FakeCacheConfigProvider

    for bad in ("urn:galileo:a{b", "urn:galileo:a}b", "urn:galileo:a#b", "urn:galileo:a?b"):
        with pytest.raises(UrnPrefixContainsDelimiter):
            GCache(GCacheConfig(cache_config_provider=FakeCacheConfigProvider(), urn_prefix=bad))

    # A ValueError too, like the other construction-time failures.
    assert issubclass(UrnPrefixContainsDelimiter, ValueError)


@pytest.mark.asyncio
async def test_invalidate_requires_both_key_type_and_id() -> None:
    # Matching Go's Invalidate. An empty one wrote a watermark for a malformed key,
    # suppressing nothing while reporting success.
    from gcache._internal.redis_cache import RedisCache

    class _Bare(RedisCache):
        def __init__(self) -> None:
            pass

    for key_type, id_ in (("", "id"), ("kt", ""), ("", "")):
        with pytest.raises(ValueError, match="requires both key_type and id"):
            await _Bare().invalidate(key_type, id_, 0)


class TestProtoEnvelopeVersionZero:
    """A PROTO frame with no usable version must MISS, as the JSON envelope already made it.

    The check was `version > ENVELOPE_VERSION` alone, so an explicit-or-absent zero slipped
    through -- ``0 > 1`` is false -- and a frame carrying no usable version decoded as a hit.
    The JSON side refuses it (the ``version-zero`` corpus vector expects ``reject``), so this
    was a one-sided divergence between the two framings of the same envelope.
    """

    @staticmethod
    def _reframe(blob: bytes, version: int) -> bytes:
        """Rewrite field 1 (version) of a canonical proto envelope.

        Field 1 varint is tag 0x08. Setting it to 0 is the case under test; proto3 would
        normally OMIT a zero, and an absent field decodes as 0 too, so both spellings of
        "no version" land on the same branch.
        """
        assert blob[0] == 0x08, f"expected field 1 varint first, got 0x{blob[0]:02x}"
        return bytes([0x08, version]) + blob[2:]

    def test_version_zero_is_rejected(self) -> None:
        good = encode_proto(created_at_ms=1_700_000_000_000, ttl_sec=60, payload=b"hi")
        assert decode(good, allow_pickle=False).payload == b"hi", "the canonical frame must decode"

        with pytest.raises(EnvelopeDecodeError, match="unsupported envelope version"):
            decode(self._reframe(good, 0), allow_pickle=False)

    def test_an_absent_version_field_is_rejected(self) -> None:
        # proto3 omits a zero scalar, so a writer that never set the field produces bytes
        # with no field 1 at all -- the shape a real non-compliant writer would emit.
        good = encode_proto(created_at_ms=1_700_000_000_000, ttl_sec=60, payload=b"hi")
        assert good[0] == 0x08
        with pytest.raises(EnvelopeDecodeError, match="unsupported envelope version"):
            decode(good[2:], allow_pickle=False)

    def test_the_current_version_still_decodes(self) -> None:
        good = encode_proto(created_at_ms=1_700_000_000_000, ttl_sec=60, payload=b"ok")
        assert decode(self._reframe(good, 1), allow_pickle=False).payload == b"ok"


class TestProtoNegativeTimestamps:
    """int64 fields read as signed, and a negative refused -- the same on both clients.

    envelope.proto declares created_at_ms/expires_at_ms as int64, and protobuf encodes a
    negative int64 as the 10-byte varint of its two's complement. Python read that varint as
    UNSIGNED, so -1 became 18446744073709551615 while Go's int64(value) gave -1. An entry
    with a negative expires_at_ms was therefore long expired in Go and ~584 million years in
    the future in Python, which served it as a fresh hit forever.
    """

    @staticmethod
    def _varint(n: int) -> bytes:
        if n < 0:
            n += 1 << 64
        out = bytearray()
        while True:
            b, n = n & 0x7F, n >> 7
            out.append(b | (0x80 if n else 0))
            if not n:
                return bytes(out)

    def _frame(self, created: int, expires: int) -> bytes:
        return (
            bytes([0x08, 1])
            + bytes([0x10])
            + self._varint(created)
            + bytes([0x18])
            + self._varint(expires)
            + bytes([0x22, 2])
            + b"hi"
        )

    def test_a_negative_timestamp_is_refused(self) -> None:
        with pytest.raises(EnvelopeDecodeError, match="negative envelope timestamp"):
            decode(self._frame(-1, -1), allow_pickle=False)

    def test_a_negative_expiry_alone_is_refused(self) -> None:
        # The dangerous one: a plausible created_at with a negative expiry is what Python
        # turned into an entry that never expires.
        with pytest.raises(EnvelopeDecodeError, match="negative envelope timestamp"):
            decode(self._frame(1_700_000_000_000, -1), allow_pickle=False)

    def test_a_normal_frame_still_decodes(self) -> None:
        dv = decode(self._frame(1_700_000_000_000, 1_700_000_060_000), allow_pickle=False)
        assert dv.created_at_ms == 1_700_000_000_000
        assert dv.expires_at_ms == 1_700_000_060_000


class TestLoneSurrogateIsRefused:
    r"""A lone surrogate must never be stored: the two clients decode it differently.

    Checked in TWO places, because the question is answerable exactly in each and nowhere
    else in one:

      JsonSerializer.dump  the object is still in scope, so re-dumping without ensure_ascii
                           puts a lone surrogate back as a real character and utf-8 refuses
                           it. This is the ESCAPE case -- \ud800 in the stored ASCII text.
      encode_json          the framing boundary every serializer's output crosses, catching a
                           LITERAL lone surrogate character from a serializer that never went
                           through json.dumps.

    Deliberately NOT a regex over the serialized text. Two attempts were each wrong in a
    different direction, and both are pinned below: the first refused every emoji, because a
    valid PAIR is also two escapes; the second refused ordinary text containing the
    characters \ud800, because an escaped backslash makes \\ud800 and the pattern matched
    from the second one.
    """

    @pytest.mark.parametrize(
        ("cp", "half"),
        [(0xD800, "high-min"), (0xDBFF, "high-max"), (0xDC00, "low-min"), (0xDFFF, "low-max")],
    )
    @pytest.mark.asyncio
    async def test_every_lone_surrogate_is_refused(self, cp: int, half: str) -> None:
        with pytest.raises(UnserializableValue):
            await JsonSerializer().dump({"v": chr(cp)})

    @pytest.mark.asyncio
    async def test_a_valid_surrogate_PAIR_is_fine(self) -> None:
        # Every non-BMP character is a pair under ensure_ascii. Refusing these would break
        # any cached value containing an emoji, which the first version of this guard did.
        for pair in ("\U0001f600", "\U00020000", "\U0001d11e"):
            assert await JsonSerializer().dump({"v": pair})

    @pytest.mark.asyncio
    async def test_text_that_merely_CONTAINS_an_escape_sequence_is_fine(self) -> None:
        # Serializes to \\ud800 -- an escaped backslash then literal characters. A pattern
        # matching \ud[89ab].. hits starting at the second backslash, so prose about unicode
        # or any JSON-inside-JSON was refused.
        assert await JsonSerializer().dump({"note": r"the escape \ud800 means a high surrogate"})

    def test_a_literal_lone_surrogate_is_refused_at_the_boundary(self) -> None:
        # The route a check living only in JsonSerializer leaves open: a custom serializer
        # returning text with a real lone surrogate in it.
        with pytest.raises(UnserializableValue):
            encode_json(created_at_ms=1, ttl_sec=60, payload='{"v":"' + chr(0xD800) + '"}')

    @pytest.mark.asyncio
    async def test_the_error_does_not_carry_the_value(self) -> None:
        # The message reaches the logs through CacheController, and the payload is cached
        # application data -- tokens, PII, whatever the caller stored.
        try:
            await JsonSerializer().dump({"secret": "hunter2" + chr(0xD800)})
        except UnserializableValue as exc:
            assert "hunter2" not in str(exc), f"the cached value leaked into the error: {exc}"
        else:
            pytest.fail("expected UnserializableValue")


@pytest.mark.asyncio
async def test_the_read_guards_use_the_entry_cap_not_the_watermark_lifetime() -> None:
    """The band between the write cap (4h) and the watermark lifetime (5h) must be refused.

    Raising WATERMARK_TTL_SECONDS to 5h while the tracked-TTL cap stayed at 4h silently
    loosened both read guards by an hour: an entry declaring a 4h30m lifetime, or one 4h30m
    old, passed with no degraded reason -- although no compliant writer can produce either,
    since the write path caps at 4h.

    The correct threshold is WATERMARK - MAX_FUTURE_BUFFER, which IS MAX_TRACKED_TTL: an
    entry created at C can be suppressed by a watermark written as early as C-B, and that
    watermark dies at C+(W-B). Past that age nothing can vouch for it.

    Every pre-existing case sat outside the band, so none of them could see the gap.
    """
    from unittest.mock import AsyncMock, MagicMock, patch

    from gcache._internal.constants import MAX_TRACKED_TTL_SECONDS
    from gcache._internal.redis_cache import RedisCache

    key = GCacheKey(
        key_type="kt",
        id="i",
        use_case="u",
        invalidation_tracking=True,
        envelope=Envelope.JSON,
        serializer=JsonSerializer(),
    )
    now = int(time.time() * 1000)
    band = MAX_TRACKED_TTL_SECONDS + 1800  # 4h30m: above the write cap, below the watermark

    async def fallback() -> dict:
        return {"v": "fresh"}

    async def serve(blob: bytes) -> tuple[object, list[str]]:
        fake = MagicMock(mget=AsyncMock(return_value=[blob, None]), setex=AsyncMock(), set=AsyncMock())
        cache = object.__new__(RedisCache)
        rec = MagicMock()
        with (
            patch.object(RedisCache, "client", property(lambda _self: fake)),
            patch.object(RedisCache, "_record_degraded_read", rec),
            patch.object(RedisCache, "put", AsyncMock()),
            patch.object(GCacheMetrics, "REQUEST_COUNTER", MagicMock(), create=True),
            patch.object(GCacheMetrics, "MISS_COUNTER", MagicMock(), create=True),
            patch.object(GCacheMetrics, "SERIALIZATION_TIMER", MagicMock(), create=True),
        ):
            out = await RedisCache.get(cache, key, fallback)
        return out, [c.args[-1] for c in rec.call_args_list]

    # 1. A DECLARED lifetime inside the band.
    out, reasons = await serve(encode_json(created_at_ms=now, ttl_sec=band, payload='{"v":1}'))
    assert out == {"v": "fresh"}, "an entry declaring more than the entry cap must be a miss"
    assert "lifetime_exceeds_watermark" in reasons, reasons

    # 2. An AGE inside the band. This has to be a PICKLE entry: the age guard is unreachable
    #    for JSON, because an entry old enough to trip it and declaring a lifetime within the
    #    cap is necessarily EXPIRED, and the expiry guard fires first. Pickle carries no
    #    expires_at_ms, so age is the only thing that can catch it -- which is exactly why
    #    the loosened threshold mattered there.
    pickle_key = GCacheKey(key_type="kt", id="i", use_case="u", invalidation_tracking=True)
    old_pickle = pickle.dumps(RedisValue(created_at_ms=now - band * 1000, payload={"v": 1}))
    fake = MagicMock(mget=AsyncMock(return_value=[old_pickle, None]), setex=AsyncMock(), set=AsyncMock())
    cache = object.__new__(RedisCache)
    rec = MagicMock()
    with (
        patch.object(RedisCache, "client", property(lambda _self: fake)),
        patch.object(RedisCache, "_record_degraded_read", rec),
        patch.object(RedisCache, "put", AsyncMock()),
        patch.object(GCacheMetrics, "REQUEST_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "MISS_COUNTER", MagicMock(), create=True),
        patch.object(GCacheMetrics, "SERIALIZATION_TIMER", MagicMock(), create=True),
    ):
        out = await RedisCache.get(cache, pickle_key, fallback)
    reasons = [c.args[-1] for c in rec.call_args_list]
    assert out == {"v": "fresh"}, "a pickle entry older than the entry cap must be a miss"
    assert "age_exceeds_watermark" in reasons, reasons

    # 3. Exactly at the cap is still served -- the bound is pinned, not approximate.
    out, _ = await serve(encode_json(created_at_ms=now, ttl_sec=MAX_TRACKED_TTL_SECONDS, payload='{"v":1}'))
    assert out == {"v": 1}, "an entry at the cap must still be served"


class TestEnvelopeRequiresSerializerCoversProto:
    """The PROTO half of the guard, and the alias that keeps old catches working.

    The guard was widened from JSON-only to both encoded framings, but every existing test
    used the JSON path -- so the half that was actually broken had no coverage. A PROTO key
    with no serializer used to construct fine and then fail every write, with
    CacheController swallowing the error and the local layer masking it in-process.
    """

    def test_a_proto_key_without_a_serializer_is_refused_at_construction(self) -> None:
        with pytest.raises(EnvelopeRequiresSerializer) as exc:
            GCacheKey(key_type="kt", id="i", use_case="u", envelope=Envelope.PROTO)
        assert "PROTO" in str(exc.value), f"the message must name the framing: {exc.value}"

    def test_a_json_key_without_a_serializer_is_still_refused(self) -> None:
        with pytest.raises(EnvelopeRequiresSerializer):
            GCacheKey(key_type="kt", id="i", use_case="u", envelope=Envelope.JSON)

    def test_pickle_needs_no_serializer(self) -> None:
        # PICKLE serialises the object itself, so it is the one framing that works without.
        # Widening the guard to "any envelope" would have broken it.
        GCacheKey(key_type="kt", id="i", use_case="u", envelope=Envelope.PICKLE)

    def test_the_old_name_still_catches_a_proto_failure(self) -> None:
        # An ALIAS, not a subclass -- the two must be the same class, or a consumer whose
        # `except JsonEnvelopeRequiresSerializer` predates the rename would stop catching a
        # PROTO failure raised under the new name. That is the whole reason for the alias,
        # and nothing asserted it.
        assert JsonEnvelopeRequiresSerializer is EnvelopeRequiresSerializer
        with pytest.raises(JsonEnvelopeRequiresSerializer):
            GCacheKey(key_type="kt", id="i", use_case="u", envelope=Envelope.PROTO)
