"""Binary-protobuf serializer for payloads shared across languages.

protobuf is an optional extra (``pip install gcache[protobuf]``) and is imported inside
``__init__`` rather than at module scope. gcache/__init__.py imports this module, so a
module-scope import would pull protobuf -- roughly 30 ``google.*`` modules, including the
``google._upb._message`` extension -- into every ``import gcache``, whether the caller
serializes protobuf or not.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from gcache.config import Serializer

if TYPE_CHECKING:
    from google.protobuf.message import Message


class ProtoSerializer(Serializer):
    """Serializes a generated protobuf message in the binary wire format.

    Pairs with ``Envelope.PROTO``, which carries the bytes in a binary envelope with no
    base64 and no JSON wrapper. Measured against the same message as protojson in a JSON
    envelope: 69 bytes stored rather than 204, and roughly 20x cheaper to serialize and
    parse (2.23 -> 0.12 us and 6.48 -> 0.29 us).

    Use instead of a hand-written dataclass whenever another language reads the value: the
    schema then lives in one ``.proto`` rather than being reimplemented per language. Go's
    counterpart is ``go/protocodec`` in this repo; the two must not drift.

    Binary has no field NAMES on the wire, only numbers, which removes a whole class of
    cross-language divergence -- there is no snake_case-vs-lowerCamelCase spelling to get
    wrong, and no whitespace for one implementation to emit and another to tolerate. What it
    gives up is readability: a stored entry is opaque to ``redis-cli GET``, ``jq`` and
    Redis's Lua ``cjson``. Use ``Envelope.JSON`` with a text serializer where that matters.

    Example::

        GCacheKey(..., envelope=Envelope.PROTO,
                  serializer=ProtoSerializer(session_identity_pb2.SessionIdentity))
    """

    def __init__(self, message_type: type[Message]) -> None:
        try:
            import google.protobuf.message as _  # noqa: F401  (presence check only)
        except ImportError as exc:  # pragma: no cover - needs the extra uninstalled
            raise ImportError("ProtoSerializer needs: pip install 'gcache[protobuf]'") from exc
        self._message_type = message_type

    def wire_identity(self) -> Any:
        """The message's full name, not just this class.

        Two ProtoSerializers carrying different messages share a type, and binary makes
        confusing them WORSE than protojson did: field numbers carry no names, so another
        message's payload does not fail to parse -- its fields are skipped as unknown and the
        result is a zero-valued message. The full name is what keeps them apart.
        """
        return (type(self), self._message_type.DESCRIPTOR.full_name)

    async def dump(self, obj: Any) -> bytes:
        if not isinstance(obj, self._message_type):
            # Otherwise SerializeToString raises an AttributeError naming neither type.
            raise TypeError(f"{type(self).__name__} expected {self._message_type.__name__}, got {type(obj).__name__}")
        return obj.SerializeToString()

    async def load(self, data: bytes | str) -> Any:
        if isinstance(data, str):
            # The PROTO envelope always yields bytes, so this is only reachable for a key
            # whose envelope was changed without its serializer. Encode rather than reject:
            # a parse failure here is a miss the caller heals, and that is the same outcome.
            data = data.encode("utf-8")
        msg = self._message_type()
        # No offload, unlike the protojson serializer this replaced. That one needed it
        # because Parse is Python driving upb per field and yields between bytecodes: at
        # 1.18 MB the worst event-loop tick delay was 104 ms inline. ParseFromString is C
        # and holds the GIL, so it blocks the loop once and briefly -- measured 0.5 ms for a
        # 1.24 MB payload, which is not worth a thread hop (and the default executor is
        # shared with getaddrinfo, so using it delays DNS).
        #
        # Unknown fields are skipped by protobuf itself, so there is no DiscardUnknown to
        # set: a field a newer writer added cannot make this reject the entry.
        msg.ParseFromString(data)
        return msg
