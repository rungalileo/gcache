"""Protobuf serializer for cache values shared with another language.

Separate module so importing gcache never imports protobuf; the dependency is an
optional extra (``pip install gcache[protobuf]``).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from gcache.config import Serializer

if TYPE_CHECKING:
    from google.protobuf.message import Message

try:
    from google.protobuf.json_format import MessageToJson, Parse

    _PROTOBUF_IMPORT_ERROR: ImportError | None = None
except ImportError as exc:  # pragma: no cover - exercised only without the extra
    _PROTOBUF_IMPORT_ERROR = exc


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
        if _PROTOBUF_IMPORT_ERROR is not None:
            raise RuntimeError("ProtoJsonSerializer needs: pip install 'gcache[protobuf]'") from _PROTOBUF_IMPORT_ERROR
        self._message_type = message_type

    async def dump(self, obj: Any) -> str:
        if not isinstance(obj, self._message_type):
            # Otherwise MessageToJson raises an AttributeError naming neither type.
            raise TypeError(f"{type(self).__name__} expected {self._message_type.__name__}, got {type(obj).__name__}")
        return MessageToJson(
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
        return Parse(data, self._message_type(), ignore_unknown_fields=True)
