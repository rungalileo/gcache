"""ProtoJsonSerializer: the Python half of the cross-language payload contract.

Asserts the concrete wire shape, not a Python round trip -- Go (go/protocodec/protocodec_test.go)
can't see this suite. Uses descriptor_pb2 for multi-word fields (``go_package``) that the
well-known types mostly lack.
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
    # Default is lowerCamelCase on WRITE. Both protojson readers accept either spelling, but
    # non-protojson readers (cjson in a Redis Lua script, jq) see raw keys with no mapping.
    payload = await ProtoJsonSerializer(descriptor_pb2.FileOptions).dump(_options())
    assert set(json.loads(payload)) == {"go_package", "java_package"}


@pytest.mark.asyncio
async def test_dump_is_single_line() -> None:
    # Default is indent=2, pretty-printed. Works, but inflates every cached value.
    payload = await ProtoJsonSerializer(descriptor_pb2.FileOptions).dump(_options())
    assert "\n" not in payload


@pytest.mark.asyncio
async def test_load_ignores_a_field_it_does_not_know() -> None:
    # Matches Go's DiscardUnknown. The default raises, which during a rolling deploy
    # that adds a field makes every old pod reject every new entry.
    loaded = await ProtoJsonSerializer(descriptor_pb2.FileOptions).load(
        '{"go_package":"example/v1","field_from_a_newer_writer":7}'
    )
    assert loaded.go_package == "example/v1"


@pytest.mark.asyncio
async def test_load_reads_what_go_writes() -> None:
    # Go's protojson adds a random extra space after each comma (per binary build, see
    # internal/detrand), so readers must not be whitespace-sensitive.
    serializer = ProtoJsonSerializer(descriptor_pb2.FileOptions)
    for raw in (
        '{"java_package":"com.example","go_package":"example/v1"}',
        '{"java_package":"com.example", "go_package":"example/v1"}',
    ):
        loaded = await serializer.load(raw)
        assert (loaded.go_package, loaded.java_package) == ("example/v1", "com.example")


@pytest.mark.asyncio
async def test_load_accepts_bytes_as_well_as_str() -> None:
    # RedisCache passes bytes on the base64 path.
    loaded = await ProtoJsonSerializer(descriptor_pb2.FileOptions).load(b'{"go_package":"example/v1"}')
    assert loaded.go_package == "example/v1"


@pytest.mark.asyncio
async def test_dump_rejects_the_wrong_message_type() -> None:
    # Without the explicit check this is an AttributeError naming neither type.
    with pytest.raises(TypeError, match="FileOptions"):
        await ProtoJsonSerializer(descriptor_pb2.FileOptions).dump(descriptor_pb2.FieldOptions())


@pytest.mark.asyncio
async def test_round_trip_through_the_cache_stores_readable_protojson(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # End to end: assert the stored bytes, not the round trip.
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
        # utf8, not base64: a base64 payload would stop being readable from redis-cli.
        assert stored["encoding"] == "utf8"
        assert json.loads(stored["payload"]) == {"go_package": "example/v1", "java_package": "com.example"}

        # And it still comes back as a message, not a dict.
        again = await cached_func(1)
        assert isinstance(again, descriptor_pb2.FileOptions)
        assert again.java_package == "com.example"
