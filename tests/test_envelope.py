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
)
from gcache._internal.metrics import GCacheMetrics
from gcache._internal.redis_cache import RedisValue
from tests.conftest import FakeCacheConfigProvider


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
    # Migrating a live use case this way is not merely a cold TTL -- both pod generations
    # overwrite each other's framing during a rollout, so a real migration uses a new
    # use_case. What this test pins is only the refusal itself.
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


# --- Read-path defects: each of these returned a wrong value or poisoned an entry. ---


@pytest.mark.asyncio
async def test_a_pickle_key_without_a_serializer_treats_a_json_entry_as_a_miss(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # A JSON payload is SERIALIZED, so only a Serializer turns it back into a value. Without
    # one this used to hand back the raw string -- worse than a miss, because the caller got
    # a str where it expected a dict and nothing raised or logged.
    #
    # A rolling deploy reaches this exact state: old pods still declare Envelope.PICKLE with
    # no serializer while new pods have started writing JSON.
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
    # serializer.load used to run outside the EnvelopeDecodeError guard, so a payload it
    # could not parse raised straight past it: the caller logged an error, re-ran the
    # fallback, and never wrote back -- leaving the entry poisoned for its whole TTL, with
    # every later read paying the fallback again. Any non-Python writer can produce one.
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
    # The envelope's expiresAtMs and the Redis TTL can disagree -- a writer that calls
    # PERSIST or sets a longer TTL leaves an entry Redis happily returns. The TypeScript
    # reader treats a past expiresAtMs as a miss, so ignoring it here made one key answer
    # differently in each language.
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
    # JSON framing carries a string payload, so it needs a serializer to make one.
    # cached() rejects the pair at decoration; a directly built key (GCache.aget/aput)
    # was the one route left open, and it failed per request instead -- the write raised
    # inside RedisCache, gcache swallowed it, and only a log line said the entry never
    # landed. Pickle needs no serializer, so that pair stays legal.
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
    # json.loads maps 1e999 to inf, isinstance(inf, float) is True, and int(inf) then raises
    # OverflowError -- outside this function's contract, so it escaped the caller's miss
    # guard and left the entry poisoned for its whole TTL. parseEnvelope requires
    # Number.isFinite for the same reason.
    envelope = {"version": 1, "createdAtMs": 1, "expiresAtMs": 2, "encoding": "utf8", "payload": "x"}
    raw = json.dumps({**envelope, field: 1e999}).encode()
    with pytest.raises(EnvelopeDecodeError):
        decode(raw)


def test_decode_accepts_a_large_in_range_integer_timestamp() -> None:
    # A timestamp far beyond any real one is fine while it fits int64 -- the bound is the
    # range the Go client can hold, not plausibility.
    #
    # The guard must still never call math.isfinite on the int directly: it raises
    # OverflowError on a very large one, escaping decode's contract of raising only
    # EnvelopeDecodeError. That is why the float() conversion comes first and the int64
    # comparison is done on the original int.
    big = 2**62  # ~year 146 million, and comfortably inside int64
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


def test_decode_rejects_a_timestamp_outside_int64() -> None:
    # Double-representability was not a tight enough bound. 1e300 passed the finiteness
    # check and kept an exact 301-digit int, and no real watermark can satisfy
    # `watermark_ms >= created_at_ms` against that -- so the entry was permanent and immune
    # to invalidation, the one thing the watermark exists to prevent. int64 is the bound
    # the Go client applies, and nothing legitimate is excluded: int64 milliseconds runs to
    # year ~292 million.
    #
    # Stricter than the TypeScript reader, which accepts anything finite. That asymmetry is
    # the safe direction: an entry it writes and we reject is a miss that gets rewritten,
    # not one served forever.
    for value in ("1e300", "-1e300", "9223372036854775808"):
        raw = f'{{"version":1,"createdAtMs":{value},"expiresAtMs":1,"encoding":"utf8","payload":"x"}}'.encode()
        with pytest.raises(EnvelopeDecodeError):
            decode(raw)

    # The boundary itself is legal.
    edge = f'{{"version":1,"createdAtMs":{2**63 - 1},"expiresAtMs":1,"encoding":"utf8","payload":"x"}}'.encode()
    assert decode(edge).created_at_ms == 2**63 - 1


def test_decode_rejects_an_integer_timestamp_past_a_double() -> None:
    # JSON.parse maps an out-of-range integer literal to Infinity, so the TypeScript
    # reader's Number.isFinite check rejects it. Python's arbitrary-precision int accepted
    # it, and the entry then never looked expired AND could never be invalidated --
    # `watermark_ms >= created_at_ms` is false for every real watermark. One key, two
    # answers.
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
    # int("5") succeeds, which is exactly why the isinstance check exists -- parseEnvelope
    # requires a number, so without this the two readers accept different bytes.
    envelope = {"version": 1, "createdAtMs": 1, "expiresAtMs": 2, "encoding": "utf8", "payload": "x"}
    with pytest.raises(EnvelopeDecodeError):
        decode(json.dumps({**envelope, field: "5"}).encode())


def test_decode_accepts_unpadded_base64() -> None:
    # Python rejects unpadded base64 where Buffer.from(..., "base64") accepts it, so a
    # writer using a raw encoder would make every Python read a miss-and-rewrite while the
    # TypeScript reader kept hitting the same key.
    raw = json.dumps(
        {"version": 1, "createdAtMs": 1, "expiresAtMs": 2, "encoding": "base64", "payload": "YWJjZGU"}
    ).encode()
    assert decode(raw).payload == b"abcde"


def test_decode_accepts_the_url_safe_base64_alphabet() -> None:
    # Node's Buffer.from(x, "base64") accepts "-" and "_"; Python's b64decode rejects them.
    # A Go writer using base64.RawURLEncoding would otherwise make every Python read a
    # miss-and-rewrite while the TypeScript reader kept hitting the same key. Same
    # divergence class as the padding case.
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
    # The decoration guard closes the serializer-is-None route, so a serializer whose dump
    # returns a non-str/bytes value is the remaining way to reach the write guard. The
    # caller must still get its value -- a cache must not fail a request -- and nothing
    # unreadable may be stored.
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

    All of these paths fall through to the fallback, which raises MISS_COUNTER, so without
    this counter keyspace corruption and envelope thrash look exactly like ordinary misses
    on a dashboard. Nothing asserted it before -- `_record_degraded_read` could have been
    deleted outright and the suite would still have passed.
    """
    cache_config_provider.configs["degraded_uc"] = GCacheKeyConfig.enabled(60)
    cache_config_provider.configs["degraded_uc"].ramp[CacheLayer.LOCAL] = 0

    @gcache.cached(key_type="Test", id_arg="test", use_case="degraded_uc")
    async def cached_func(test: int = 1) -> str:
        return "ok"

    counter = GCacheMetrics.DEGRADED_READ_COUNTER.labels("degraded_uc", "Test", CacheLayer.REMOTE.name, "undecodable")
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

    counter = GCacheMetrics.DEGRADED_READ_COUNTER.labels(
        "expired_reason_uc", "Test", CacheLayer.REMOTE.name, "envelope_expired"
    )
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

    This is the question an operator asks before flipping an envelope: what happens to the
    entries already in Redis? Three things have to hold together, and asserting only the
    first would pass in a world where the entry stays poisoned for its whole TTL --
    precisely the bug that shipped twice on this branch, where the fallback ran but the
    write-back never did.
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

    counter = GCacheMetrics.DEGRADED_READ_COUNTER.labels("migrate_uc", "Test", CacheLayer.REMOTE.name, "undecodable")
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
    # json.dumps defaults to allow_nan=True and emits the bare tokens NaN / Infinity /
    # -Infinity. Those are not JSON: JSON.parse throws and Go's encoding/json rejects
    # them, so the write would succeed and leave an entry no other language can read
    # until its TTL ran out. Failing the write is the rule the rest of this envelope
    # follows -- gcache swallows the error, so the caller still gets its value.
    for bad in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(ValueError):
            await JsonSerializer().dump({"score": bad})

    # A finite float still round-trips.
    assert await JsonSerializer().dump({"score": 1.5}) == '{"score":1.5}'


def test_envelope_rejects_a_boolean_version() -> None:
    # isinstance(True, int) and True == 1, so `"version": true` satisfied
    # `!= ENVELOPE_VERSION` and was accepted. The TypeScript reader's `!== 1` rejects it
    # and Go's *int unmarshal fails on it, so Python was the only client calling it a hit.
    from gcache._internal.envelope import EnvelopeDecodeError, decode

    raw = b'{"version":true,"createdAtMs":1,"expiresAtMs":2,"encoding":"utf8","payload":"{}"}'
    with pytest.raises(EnvelopeDecodeError):
        decode(raw, allow_pickle=False)


def test_json_serializer_parses_inline_even_when_large() -> None:
    # Deliberately NOT offloaded. An earlier revision sent a large payload to an executor;
    # measured on 5.3 MB that changed the maximum event-loop tick delay not at all (0.007s
    # inline vs 0.007-0.014s offloaded), because json.loads runs in C and holds the GIL for
    # its whole run -- so the worker thread blocks the loop thread just the same. It also
    # used the default pool, which asyncio shares with getaddrinfo.
    #
    # This asserts the absence, because re-adding the offload looks like an obvious
    # improvement and is not one. ProtoJsonSerializer.load is the case where it does help.
    import inspect

    src = inspect.getsource(JsonSerializer.load)
    assert "run_in_executor" not in src


@pytest.mark.asyncio
async def test_invalidate_writes_a_watermark_in_the_value_key_s_slot() -> None:
    # Drives RedisCache.invalidate and captures the key it actually SETEXes -- comparing
    # two calls to render_prefix would pass with the bug restored, since both sides would
    # use the same helper.
    #
    # invalidate used to build this key by hand, and the two constructions disagreed when
    # urn_prefix was empty: a GCacheKey renders "{kt:i}" while the hand-rolled form
    # rendered "{:kt:i}". The braces ARE the cluster hash tag, so the watermark stopped
    # sharing a slot with the value it was meant to suppress -- the paired MGET is not even
    # legal across slots -- and the invalidation silently never matched. Go's WatermarkKey
    # guards the empty case, so Python was also the odd one out across languages.
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
    # Every one of these used to raise out of RedisCache.get -- float() on a non-numeric
    # value, int(nan) with ValueError, int(inf) with OverflowError -- which is the one thing
    # this class promises cannot happen: a cache must not be able to fail a request. The
    # int() sat outside the guarded block, so nothing caught it.
    #
    # Unreadable suppresses rather than returning None. None means "no invalidation has
    # happened", which would SERVE an entry someone tried to invalidate -- the one answer a
    # broken watermark must never produce. NaN is the sharpest case: had int(nan) not
    # raised, every comparison against it is False, so the entry would be neither stale nor
    # written back -- served forever and never repopulated.
    #
    # Reachable because of this work: before the shared envelope, only Python wrote these
    # keys. Go's parseWatermark has handled all three deliberately.
    from gcache._internal.redis_cache import _parse_watermark
    from gcache.config import GCacheKey

    key = GCacheKey(key_type="kt", id="i", use_case="u", invalidation_tracking=True)
    assert _parse_watermark(raw, key) == expected


def test_an_unreadable_watermark_suppresses_rather_than_serving() -> None:
    # The direction is the whole point, and I got it wrong first: staleness is
    # `watermark_ms >= created_at_ms`, so suppressing needs the MAXIMUM. The minimum marks
    # nothing stale and serves the very entry the broken watermark should have hidden --
    # which is also what None does, so both wrong answers are the same wrong answer.
    from gcache._internal.redis_cache import _WATERMARK_SUPPRESS_ALL

    created_at_ms = 1757308800123
    assert _WATERMARK_SUPPRESS_ALL >= created_at_ms, "must mark every entry stale"
    assert not (-(2**63) >= created_at_ms), "the minimum would serve it -- the bug I wrote"

    # And it must not trigger write-back: _exec_fallback re-puts only when
    # watermark_ms < now, so the maximum leaves the stored value alone until the watermark
    # key expires on its own TTL.
    import time

    assert not (_WATERMARK_SUPPRESS_ALL < time.time() * 1e3)


@pytest.mark.asyncio
async def test_get_does_not_raise_on_a_malformed_watermark() -> None:
    # Drives RedisCache.get, because testing _parse_watermark alone proved the parser
    # correct without proving it was WIRED IN -- reverting get() to the bare float()/int()
    # pair left every parser test passing. The mutation check is what exposed that.
    #
    # Each of these raised out of get() before: float("abc") -> ValueError, int(nan) ->
    # ValueError, int(inf) -> OverflowError, none of them inside the guarded block. A cache
    # must not be able to fail a request.
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
        fake = MagicMock(mget=AsyncMock(return_value=[stored, bad]), setex=AsyncMock(), set=AsyncMock())
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
    # The agreement matrix, asserted rather than described. Guarding on isnan alone treated
    # the three non-finite inputs three ways -- nan and inf suppressed, -inf SERVED -- which
    # was also the single input where the two clients disagreed, since Go rejects -inf.
    #
    # The line is finite-vs-not, not sign: -1e300 is a real instruction ("an extremely old
    # watermark, nothing is stale") and clamps in both clients, while -inf is not a
    # timestamp at all. Go reaches the same split from the other direction -- it rejects
    # non-finite and clamps finite out-of-range.
    import logging

    from gcache._internal.redis_cache import _parse_watermark
    from gcache.config import GCacheKey

    key = GCacheKey(key_type="kt", id="i", use_case="u", invalidation_tracking=True)
    created_at_ms = 1757308800123
    logging.disable(logging.WARNING)
    try:
        for raw in (b"nan", b"inf", b"-inf", b"1e400", b"abc", b""):
            parsed = _parse_watermark(raw, key)
            # None is a distinct outcome meaning "no watermark stored", and none of these
            # may produce it -- that would SERVE the entry, same as the minimum would.
            assert parsed is not None, f"{raw!r} must not read as 'no watermark'"
            assert parsed >= created_at_ms, f"{raw!r} must suppress"

        # Finite out-of-range keeps its meaning rather than being treated as garbage.
        old_watermark = _parse_watermark(b"-1e300", key)
        assert old_watermark is not None and old_watermark < created_at_ms, "a very old watermark stays old"
        high = _parse_watermark(b"1e300", key)
        assert high is not None and high >= created_at_ms
    finally:
        logging.disable(logging.NOTSET)
