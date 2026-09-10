"""Protobuf serializer, for cache values shared with another language.

Kept in its own module so that importing gcache never imports protobuf. The
dependency is an optional extra (``pip install gcache[protobuf]``); this module
imports fine without it and raises a useful error at construction instead of an
ImportError from somewhere unrelated.
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

    Pairs with ``Envelope.JSON``: protojson is text, so it rides in the envelope's string
    payload with no base64 and stays readable under ``redis-cli GET``.

    Use this instead of hand-writing a dataclass plus ``JsonSerializer`` whenever the value
    is read or written by another language. The schema then lives in one ``.proto`` rather
    than being reimplemented per language, which is the failure mode that produced six
    cross-language divergences in the session-identity cache before this existed.

    Example::

        from libs.python.schemas.cache.proto import session_identity_pb2

        GCacheKey(
            key_type="session_id",
            id=str(session_id),
            use_case="LogRecordsService::resolve_session",
            envelope=Envelope.JSON,
            serializer=ProtoJsonSerializer(session_identity_pb2.SessionIdentity),
        )

    Two options below are load-bearing and neither is the library default. The Go
    counterpart (``orbit/libs/go/gcache/protocodec``) sets exactly the same pair, and the
    two must not drift.
    """

    def __init__(self, message_type: type[Message]) -> None:
        if _PROTOBUF_IMPORT_ERROR is not None:
            raise RuntimeError(
                "ProtoJsonSerializer needs the protobuf extra: pip install 'gcache[protobuf]'"
            ) from _PROTOBUF_IMPORT_ERROR
        self._message_type = message_type

    async def dump(self, obj: Any) -> str:
        if not isinstance(obj, self._message_type):
            # Without this, MessageToJson raises an AttributeError from deep inside
            # json_format that names neither the value nor the expected type.
            raise TypeError(
                f"{type(self).__name__} was built for {self._message_type.__name__} but got {type(obj).__name__}"
            )
        return MessageToJson(
            obj,
            # snake_case. The default is lowerCamelCase, which Go would parse into a
            # message with every field at its zero value rather than an error.
            preserving_proto_field_name=True,
            # Compact. The DEFAULT IS indent=2 -- pretty-printed with newlines -- which
            # would work but inflate every cached value for nothing.
            indent=None,
        )

    async def load(self, data: bytes | str) -> Any:
        if isinstance(data, bytes):
            data = data.decode("utf-8")
        return Parse(
            data,
            self._message_type(),
            # Tolerate a field a newer writer added. The default is to raise, which during
            # any rolling deploy that adds a field would make every old pod treat every new
            # entry as corrupt, in both directions, for the whole rollout. Matches Go's
            # protojson.UnmarshalOptions{DiscardUnknown: true}.
            ignore_unknown_fields=True,
        )
