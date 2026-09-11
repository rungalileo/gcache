"""Protobuf serializer for cache values shared with another language.

protobuf is an optional extra (``pip install gcache[protobuf]``) and is imported inside
``__init__`` rather than at module scope. gcache/__init__.py imports this module, so a
module-scope import would pull protobuf -- roughly 30 ``google.*`` modules, including the
``google._upb._message`` extension -- into every ``import gcache``, whether the caller
uses this class or not.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from gcache.config import Serializer

if TYPE_CHECKING:
    from google.protobuf.message import Message


class ProtoJsonSerializer(Serializer):
    """Serializes a generated protobuf message as protojson.

    Pairs with ``Envelope.JSON``: protojson is text, so it rides in the envelope's
    string payload with no base64 and stays readable under ``redis-cli GET``.

    Use instead of a hand-written dataclass whenever another language reads the value:
    the schema then lives in one ``.proto`` rather than being reimplemented per
    language. Go's counterpart is ``orbit/libs/go/gcache/protocodec``, which sets the
    same non-default options; the two must not drift.

    Example::

        GCacheKey(..., envelope=Envelope.JSON,
                  serializer=ProtoJsonSerializer(session_identity_pb2.SessionIdentity))
    """

    def __init__(self, message_type: type[Message]) -> None:
        try:
            from google.protobuf.json_format import MessageToJson, Parse
        except ImportError as exc:  # pragma: no cover - needs the extra uninstalled
            raise ImportError("ProtoJsonSerializer needs: pip install 'gcache[protobuf]'") from exc
        self._message_to_json = MessageToJson
        self._parse = Parse
        self._message_type = message_type

    async def dump(self, obj: Any) -> str:
        if not isinstance(obj, self._message_type):
            # Otherwise MessageToJson raises an AttributeError naming neither type.
            raise TypeError(f"{type(self).__name__} expected {self._message_type.__name__}, got {type(obj).__name__}")
        return self._message_to_json(
            obj,
            # snake_case. Default is lowerCamelCase, which Go parses into a
            # zero-valued message rather than an error.
            preserving_proto_field_name=True,
            # Compact. Default is indent=2, which inflates every cached value.
            indent=None,
        )

    async def load(self, data: bytes | str) -> Any:
        if isinstance(data, bytes):
            data = data.decode("utf-8")
        # Tolerate a field a newer writer added; the default raises, which would make
        # each pod generation reject the other's entries for a whole rolling deploy.
        # Matches Go's protojson.UnmarshalOptions{DiscardUnknown: true}.
        return self._parse(data, self._message_type(), ignore_unknown_fields=True)
