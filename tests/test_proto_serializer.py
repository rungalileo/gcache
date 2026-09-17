"""ProtoSerializer: the Python half of the cross-language payload contract.

Asserts the concrete wire shape, not a Python round trip -- Go (go/protocodec/protocodec_test.go)
can't see this suite. Uses descriptor_pb2 for multi-word fields (``go_package``) that the
well-known types mostly lack.
"""

import pytest
import redislite
from google.protobuf import descriptor_pb2

from gcache import CacheLayer, Envelope, GCache, GCacheKeyConfig, ProtoSerializer
from gcache._internal.envelope import decode
from tests.conftest import FakeCacheConfigProvider


def _options() -> descriptor_pb2.FileOptions:
    return descriptor_pb2.FileOptions(go_package="example/v1", java_package="com.example")


@pytest.mark.asyncio
async def test_dump_is_the_binary_wire_format() -> None:
    # Byte-for-byte what protobuf itself produces -- not protojson, and not base64 of either.
    # This is the contract Go's protocodec.Proto must match.
    payload = await ProtoSerializer(descriptor_pb2.FileOptions).dump(_options())

    assert isinstance(payload, bytes)
    assert payload == _options().SerializeToString()
    # Field NUMBERS, not names: nothing in the output spells "go_package", which is the whole
    # reason the snake_case-vs-lowerCamelCase hazard disappears.
    assert b"go_package" not in payload and b"goPackage" not in payload
    assert b"example/v1" in payload, "the value itself is still there, unescaped"


@pytest.mark.asyncio
async def test_dump_is_smaller_than_protojson() -> None:
    # The reason this exists. Not a tight bound -- just that the direction is real, so a
    # regression to a text encoding cannot pass.
    from google.protobuf.json_format import MessageToJson

    binary = await ProtoSerializer(descriptor_pb2.FileOptions).dump(_options())
    protojson = MessageToJson(_options(), preserving_proto_field_name=True, indent=None).encode()
    assert len(binary) < len(protojson) * 0.75, f"{len(binary)} vs {len(protojson)}"


@pytest.mark.asyncio
async def test_load_skips_a_field_it_does_not_know() -> None:
    # A newer writer adds a field; this reader must not reject the entry. protobuf skips
    # unknown fields itself, so unlike protojson there is no DiscardUnknown to forget to set.
    newer = descriptor_pb2.FileOptions(go_package="example/v1")
    raw = newer.SerializeToString() + b"\xf8\x3f\x01"  # field 127, varint, value 1

    loaded = await ProtoSerializer(descriptor_pb2.FileOptions).load(raw)
    assert loaded.go_package == "example/v1"


@pytest.mark.asyncio
async def test_round_trip_preserves_every_field() -> None:
    serializer = ProtoSerializer(descriptor_pb2.FileOptions)
    loaded = await serializer.load(await serializer.dump(_options()))
    assert loaded.go_package == "example/v1"
    assert loaded.java_package == "com.example"


@pytest.mark.asyncio
async def test_dump_rejects_the_wrong_message_type() -> None:
    with pytest.raises(TypeError, match="expected FileOptions, got FieldOptions"):
        await ProtoSerializer(descriptor_pb2.FileOptions).dump(descriptor_pb2.FieldOptions())


def test_wire_identity_separates_two_message_types() -> None:
    # Binary makes confusing two messages WORSE than protojson did: field numbers carry no
    # names, so the wrong type's payload does not fail -- its fields are skipped as unknown
    # and the caller gets a zero-valued message. wire_identity is what prevents the mix-up.
    a = ProtoSerializer(descriptor_pb2.FileOptions).wire_identity()
    b = ProtoSerializer(descriptor_pb2.FieldOptions).wire_identity()
    assert a != b

    # And demonstrate the hazard it guards, so the reason is not just asserted in a comment.
    wrong = descriptor_pb2.FieldOptions()
    wrong.ParseFromString(_options().SerializeToString())
    assert wrong.ByteSize() == 0 or not wrong.ListFields(), "mismatched type parses to nothing, silently"


@pytest.mark.asyncio
async def test_round_trip_through_the_cache_stores_a_binary_envelope(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # End to end: assert the stored bytes, not the round trip.
    cache_config_provider.configs["proto_uc"] = GCacheKeyConfig.enabled(60)
    cache_config_provider.configs["proto_uc"].ramp[CacheLayer.LOCAL] = 0

    @gcache.cached(
        key_type="Test",
        id_arg="test",
        use_case="proto_uc",
        envelope=Envelope.PROTO,
        serializer=ProtoSerializer(descriptor_pb2.FileOptions),
    )
    async def cached_func(test: int = 1) -> descriptor_pb2.FileOptions:
        return _options()

    with gcache.enable():
        assert (await cached_func(1)).go_package == "example/v1"

        (redis_key,) = redis_server.keys()
        raw = redis_server.get(redis_key)

        # No JSON wrapper at all: the entry is the binary envelope, first byte in the PROTO
        # range rather than '{' (0x7b) or pickle's 0x80.
        assert 0x08 <= raw[0] <= 0x75, f"first byte 0x{raw[0]:02x} is outside the PROTO range"
        assert not raw.startswith(b"{")
        assert b"version" not in raw and b"createdAtMs" not in raw, "no JSON field names"

        decoded = decode(raw, allow_pickle=False)
        assert decoded.payload == _options().SerializeToString()
        assert decoded.expires_at_ms == decoded.created_at_ms + 60_000

        # And it still comes back as a message, not bytes.
        again = await cached_func(1)
        assert isinstance(again, descriptor_pb2.FileOptions)
        assert again.java_package == "com.example"


@pytest.mark.asyncio
async def test_the_binary_envelope_is_smaller_than_the_json_one(
    gcache: GCache, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # Pins the reason for the whole change, at the level that matters: the STORED entry.
    from google.protobuf.json_format import MessageToJson

    from gcache._internal.envelope import encode_json, encode_proto

    msg = _options()
    proto_entry = encode_proto(created_at_ms=1757308800123, ttl_sec=60, payload=msg.SerializeToString())
    json_entry = encode_json(
        created_at_ms=1757308800123,
        ttl_sec=60,
        payload=MessageToJson(msg, preserving_proto_field_name=True, indent=None),
    )
    assert len(proto_entry) < len(json_entry) * 0.6, f"{len(proto_entry)} vs {len(json_entry)}"
    # Envelope overhead specifically, which is what the JSON wrapper cost.
    assert len(proto_entry) - len(msg.SerializeToString()) < 25
