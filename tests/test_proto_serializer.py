"""ProtoJsonSerializer: the Python half of the cross-language payload contract.

The Go half is orbit/libs/go/gcache/protocodec/protocodec_test.go and asserts the same
properties. Neither suite can see the other, which is precisely how six cross-language
divergences reached review in the session-identity work -- so these assert the concrete
wire shape rather than a Python round trip, which would pass no matter what Go does.

descriptor_pb2 is used as the sample message because it ships with the protobuf runtime:
these tests must not depend on a Galileo schema living in another repository. It also has
real multi-word fields (``go_package``), which the well-known types mostly lack.
"""

import json

import pytest
import redislite
from google.protobuf import descriptor_pb2

from gcache import CacheLayer, Envelope, GCache, GCacheKeyConfig, ProtoJsonSerializer
from gcache._internal.envelope import ENVELOPE_VERSION
from tests.conftest import FakeCacheConfigProvider


def _options() -> descriptor_pb2.FileOptions:
    return descriptor_pb2.FileOptions(go_package="example/v1", java_package="com.example")


@pytest.mark.asyncio
async def test_dump_uses_snake_case_field_names() -> None:
    # The cross-language contract in one assertion. The default is lowerCamelCase, which Go
    # would not fail on -- it would return a message with every field at its zero value.
    payload = await ProtoJsonSerializer(descriptor_pb2.FileOptions).dump(_options())
    assert set(json.loads(payload)) == {"go_package", "java_package"}


@pytest.mark.asyncio
async def test_dump_is_single_line() -> None:
    # MessageToJson DEFAULTS to indent=2, i.e. pretty-printed with newlines. That still
    # works, so nothing would fail -- every cached value would just carry the whitespace.
    payload = await ProtoJsonSerializer(descriptor_pb2.FileOptions).dump(_options())
    assert "\n" not in payload


@pytest.mark.asyncio
async def test_load_ignores_a_field_it_does_not_know() -> None:
    # Matches Go's protojson.UnmarshalOptions{DiscardUnknown: true}. The default on both
    # sides raises, which would make every old pod reject every new-format entry for the
    # whole duration of a rolling deploy that adds a field.
    loaded = await ProtoJsonSerializer(descriptor_pb2.FileOptions).load(
        '{"go_package":"example/v1","field_from_a_newer_writer":7}'
    )
    assert loaded.go_package == "example/v1"


@pytest.mark.asyncio
async def test_load_reads_what_go_writes() -> None:
    # Go's protojson emits a RANDOM extra space after each comma -- decided per binary
    # build, see internal/detrand -- so a reader must not be whitespace-sensitive and the
    # two languages' bytes must never be compared directly. Both spacings must parse.
    serializer = ProtoJsonSerializer(descriptor_pb2.FileOptions)
    for raw in (
        '{"java_package":"com.example","go_package":"example/v1"}',
        '{"java_package":"com.example", "go_package":"example/v1"}',
    ):
        loaded = await serializer.load(raw)
        assert (loaded.go_package, loaded.java_package) == ("example/v1", "com.example")


@pytest.mark.asyncio
async def test_load_accepts_bytes_as_well_as_str() -> None:
    # RedisCache hands the serializer whatever the envelope carried, which is bytes on the
    # base64 path.
    loaded = await ProtoJsonSerializer(descriptor_pb2.FileOptions).load(b'{"go_package":"example/v1"}')
    assert loaded.go_package == "example/v1"


@pytest.mark.asyncio
async def test_dump_rejects_the_wrong_message_type() -> None:
    # Without the explicit check this surfaces as an AttributeError from inside
    # json_format naming neither the value nor the expected type.
    with pytest.raises(TypeError, match="FileOptions"):
        await ProtoJsonSerializer(descriptor_pb2.FileOptions).dump(descriptor_pb2.FieldOptions())


@pytest.mark.asyncio
async def test_round_trip_through_the_cache_stores_readable_protojson(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # End to end: what actually lands in Redis has to be a JSON envelope whose payload is
    # protojson another language can read. Asserting the stored bytes, not the round trip.
    cache_config_provider.configs["proto_uc"] = GCacheKeyConfig.enabled(60)
    cache_config_provider.configs["proto_uc"].ramp[CacheLayer.LOCAL] = 0

    @gcache.cached(
        key_type="Test",
        id_arg="test",
        use_case="proto_uc",
        envelope=Envelope.JSON,
        serializer=ProtoJsonSerializer(descriptor_pb2.FileOptions),
    )
    async def cached_func(test: int = 1) -> descriptor_pb2.FileOptions:
        return _options()

    with gcache.enable():
        assert (await cached_func(1)).go_package == "example/v1"

        (redis_key,) = redis_server.keys()
        stored = json.loads(redis_server.get(redis_key))
        assert stored["version"] == ENVELOPE_VERSION
        # utf8, not base64: protojson is text, so it needs no encoding hop. A base64
        # payload here would mean the value stopped being readable from redis-cli.
        assert stored["encoding"] == "utf8"
        assert json.loads(stored["payload"]) == {"go_package": "example/v1", "java_package": "com.example"}

        # And it still comes back as a message, not a dict.
        again = await cached_func(1)
        assert isinstance(again, descriptor_pb2.FileOptions)
        assert again.java_package == "com.example"
