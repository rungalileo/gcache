"""Value envelope encoding for the Redis layer.

gcache has always wrapped cached payloads in a pickled :class:`RedisValue` carrying the
write timestamp the watermark comparison needs. Pickle is a fine default for Python-only
callers -- it serializes arbitrary objects -- but it is unreadable from other languages,
couples readers to this module's private class path, and executes arbitrary code on load.

``Envelope.JSON`` is an opt-in alternative for keys that are shared with non-Python
readers. It uses the same envelope the TypeScript port already writes
(``packages/gcache-ts/src/internal/redis-cache.ts``), so Python, TypeScript and Go agree
on one wire format.

It also makes an entry readable *inside Redis*, which pickle can never be. Redis ships
``cjson`` in its Lua interpreter, so a script can parse a stored envelope and act on its
metadata::

    local e = cjson.decode(redis.call('GET', KEYS[1]))
    return tostring(e.createdAtMs)

There is no Lua unpickler, so a pickled entry is opaque to the server no matter what.
That forecloses server-side atomic operations on cached values -- a compare-and-set that
only overwrites when the incoming record is newer, say -- which a JSON envelope leaves
available. (``cmsgpack`` is built in too, and is ~25% more compact; JSON wins here on
being what the TypeScript port already emits and on being readable straight out of
``redis-cli``.)

Reads never trust the declared envelope: :func:`decode` sniffs the first byte, so a key
can be migrated between envelopes without a flag day and a reader always understands
whatever the writer produced.
"""

import base64
import json
import pickle
from dataclasses import dataclass
from enum import Enum
from typing import Any

ENVELOPE_VERSION = 1

# Every pickle protocol >= 2 blob starts with the PROTO opcode (0x80). JSON objects start
# with '{'. The two can never collide, which is what makes sniffing safe.
_PICKLE_PROTO_OPCODE = 0x80


class Envelope(str, Enum):
    """How a cached value is framed on the wire."""

    PICKLE = "pickle"
    JSON = "json"


@dataclass(frozen=True, slots=True)
class DecodedValue:
    """A decoded envelope: the write timestamp plus the still-serialized payload."""

    created_at_ms: int
    payload: Any


class EnvelopeDecodeError(Exception):
    """Raised when a stored value matches no known envelope."""


def encode_json(created_at_ms: int, ttl_sec: int, payload: str | bytes) -> bytes:
    """Frame ``payload`` in the cross-language JSON envelope.

    ``payload`` must already be serialized -- the JSON envelope carries a string, so keys
    using it need a ``Serializer`` (``JsonSerializer`` by default). ``bytes`` payloads are
    base64-encoded and flagged via ``encoding``, matching the TypeScript port.
    """
    if isinstance(payload, bytes):
        encoding = "base64"
        body = base64.b64encode(payload).decode("ascii")
    else:
        encoding = "utf8"
        body = payload

    return json.dumps(
        {
            "version": ENVELOPE_VERSION,
            "createdAtMs": created_at_ms,
            "expiresAtMs": created_at_ms + ttl_sec * 1000,
            "encoding": encoding,
            "payload": body,
        },
        separators=(",", ":"),
    ).encode("utf-8")


def decode(data: bytes) -> DecodedValue:
    """Decode a stored value, sniffing the envelope rather than trusting the key's config.

    :raises EnvelopeDecodeError: if the blob is neither a pickle nor a JSON envelope.
    """
    if not data:
        raise EnvelopeDecodeError("empty value")

    if data[0] == _PICKLE_PROTO_OPCODE:
        value = pickle.loads(data)
        return DecodedValue(created_at_ms=value.created_at_ms, payload=value.payload)

    if data[0:1] == b"{":
        try:
            envelope = json.loads(data)
            payload = envelope["payload"]
            if envelope.get("encoding") == "base64":
                payload = base64.b64decode(payload)
            return DecodedValue(created_at_ms=int(envelope["createdAtMs"]), payload=payload)
        except (ValueError, KeyError, TypeError) as e:
            raise EnvelopeDecodeError(f"malformed JSON envelope: {e}") from e

    raise EnvelopeDecodeError(f"unrecognized envelope, leading byte {data[0]:#04x}")


def is_pickle(data: bytes) -> bool:
    """Whether ``data`` is a pickle blob. Exposed so callers can route large-blob decoding."""
    return bool(data) and data[0] == _PICKLE_PROTO_OPCODE
