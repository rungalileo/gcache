"""Value envelope encoding for the Redis layer.

gcache has always wrapped cached payloads in a pickled :class:`RedisValue` carrying the
write timestamp the watermark comparison needs. Pickle is a fine default for Python-only
callers -- it serializes arbitrary objects -- but it is unreadable from other languages,
couples readers to this module's private class path, and executes arbitrary code on load.

``Envelope.JSON`` is an opt-in alternative for keys that are shared with non-Python
readers. Python and the Go client at ``go/`` write and read the same envelope, so both agree
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
being readable straight out of
``redis-cli``.)

Reads sniff the first byte rather than trusting the declared envelope, so a reader
understands whatever the writer actually produced -- which is what lets a pickle key read a
JSON entry, and lets both languages share one keyspace. Sniffing alone, though, would
leave the pickle path reachable for every key, including one that declares
``Envelope.JSON``, so ``decode`` takes ``allow_pickle`` and a JSON key refuses pickle
outright. Choosing ``Envelope.JSON`` therefore does close the arbitrary-code-execution path
on read; sniffing on its own would not.

Migrating a live use case pickle -> json is NOT one TTL of cold cache. A rolling deploy runs both generations at once: an old pod
(pickle, no serializer) treats a JSON entry as a miss and writes pickle over it, and a new
pod refuses that pickle and writes JSON again. Each generation destroys the framing the
other needs, so the key's hit rate sits near zero for the whole rollout -- a load spike on
the backing store, not a slow warm-up. Migrate under a NEW use_case instead; the two
generations then use different keys and never fight.
"""

import base64
import json
import math
import pickle
import re
from dataclasses import dataclass
from typing import Any

ENVELOPE_VERSION = 1

# Exactly the six ASCII bytes Go's normalizeBase64 strips. Not \s, which on a str pattern
# also matches U+00A0 and friends -- those would diverge from Go, which keeps them.
_WHITESPACE_RE = re.compile(r"[ \t\n\r\x0b\f]")

# Envelope timestamps are int64 milliseconds, matching the Go client. See decode().
_INT64_MAX = 2**63 - 1
# 2^53-1: above it Go's float64 rounds (9007199254740993 -> ...992) while Python's json.loads
# stays exact, so the two compared different numbers against the same threshold. Envelope
# timestamps are bounded here; the watermark deliberately is not.
_MAX_SAFE_INTEGER = 2**53 - 1
_MIN_SAFE_INTEGER = -(2**53 - 1)
_INT64_MIN = -(2**63)

# Every pickle protocol >= 2 blob starts with the PROTO opcode (0x80). JSON objects start
# with '{'. The two can never collide, which is what makes sniffing safe.
_PICKLE_PROTO_OPCODE = 0x80


@dataclass(frozen=True, slots=True)
class DecodedValue:
    """A decoded envelope: the write timestamp plus the still-serialized payload."""

    created_at_ms: int
    payload: Any
    # Which framing the bytes actually used, as opposed to what the key declared. The
    # caller needs this: a JSON payload is SERIALIZED, so it is only a value once a
    # Serializer has loaded it, and a key carrying no serializer must treat the entry as a
    # miss rather than hand back the raw string.
    is_json: bool = False
    # Only JSON envelopes carry one; None for pickle. The reader is expected to honour it,
    # because the Redis TTL and this field can disagree -- a writer that calls PERSIST or
    # sets a longer TTL leaves an entry Redis still serves but the envelope calls expired.
    expires_at_ms: int | None = None


class EnvelopeEncodeError(ValueError):
    """Raised when a value cannot be framed into a readable envelope.

    Distinct from EnvelopeDecodeError, which callers convert to a cache MISS. An encode
    failure is not a miss -- there is nothing stored to miss on. It means the write was
    refused, which is the correct outcome when the alternative is storing an entry no client
    can read. CacheController already treats a raising write as an error and leaves the
    keyspace untouched, and the caller still gets its value from the fallback.
    """


class EnvelopeDecodeError(Exception):
    """Raised when a stored value matches no known envelope."""


def encode_json(created_at_ms: int, ttl_sec: int, payload: str | bytes) -> bytes:
    """Frame ``payload`` in the cross-language JSON envelope.

    ``payload`` must already be serialized -- the JSON envelope carries a string, so keys
    using it need a ``Serializer`` (``JsonSerializer`` by default). ``bytes`` payloads are
    base64-encoded and flagged via ``encoding``.
    """
    if isinstance(payload, bytes):
        encoding = "base64"
        body = base64.b64encode(payload).decode("ascii")
    else:
        encoding = "utf8"
        body = payload

    # The writer honours the reader's bound, or a large ttl_sec pushes expiresAtMs past
    # 2^53 and every subsequent read rejects it -- rewritten and rejected forever.
    # Raising, not clamping: a clamp silently changes the configured TTL.
    expires_at_ms = created_at_ms + ttl_sec * 1000
    for field, value in (("createdAtMs", created_at_ms), ("expiresAtMs", expires_at_ms)):
        if not (_MIN_SAFE_INTEGER <= value <= _MAX_SAFE_INTEGER):
            raise EnvelopeEncodeError(
                f"{field} would be {value}, outside the safe-integer range that both "
                f"clients can read (created_at_ms={created_at_ms}, ttl_sec={ttl_sec})"
            )

    return json.dumps(
        {
            "version": ENVELOPE_VERSION,
            "createdAtMs": created_at_ms,
            "expiresAtMs": expires_at_ms,
            "encoding": encoding,
            "payload": body,
        },
        separators=(",", ":"),
    ).encode("utf-8")


def decode(data: bytes | str, *, allow_pickle: bool = True) -> DecodedValue:
    """Decode a stored value, sniffing the framing rather than trusting the key's config.

    Sniffing is what lets a key move between envelopes with no flag day: a reader handles
    whatever the writer left.

    ``allow_pickle`` gates the pickle branch. A key that declares ``Envelope.JSON`` passes
    ``False``, because unpickling executes arbitrary code and the reader cannot tell a
    migration leftover from an attack payload written by anyone with keyspace access. A
    refused pickle blob raises, which the caller turns into a miss -- so a JSON-declared key
    still migrates cleanly off an old pickle value, it just takes one fallback to do it.

    Every failure mode raises :class:`EnvelopeDecodeError` so callers have a single
    exception to treat as "miss"; letting anything else escape leaves the bad entry in place
    for its full TTL, re-failing on every read.
    """
    if not data:
        raise EnvelopeDecodeError("empty value")

    # decode_responses=True hands back str, which failed both sniffs silently and then
    # raised ValueError out of this function's one-exception contract. Encoded, not
    # rejected -- but this does NOT make that option safe: a pickle value on the same
    # client still raises inside redis-py and never heals (_warn_once_if_text_mode).
    if isinstance(data, str):
        data = data.encode("utf-8")

    if data[0] == _PICKLE_PROTO_OPCODE:
        if not allow_pickle:
            raise EnvelopeDecodeError(
                "refusing to unpickle a value for a JSON-envelope key: unpickling executes "
                "arbitrary code and this reader cannot distinguish a migration leftover from "
                "an injected payload"
            )
        try:
            value = pickle.loads(data)
            return DecodedValue(created_at_ms=int(value.created_at_ms), payload=value.payload)
        except Exception as e:
            # A truncated blob, or a pickle of some other type that has no created_at_ms.
            # 0x80 is also MessagePack's empty-map byte, so a non-Python writer lands here too.
            raise EnvelopeDecodeError(f"malformed pickle envelope: {e}") from e

    if data[0:1] == b"{":
        try:
            envelope = json.loads(data)
            # Validate the same three fields the Go reader validates. Skipping them
            # makes the two readers disagree about the same bytes -- the version field in
            # particular exists precisely to turn a future writer's data into a miss.
            version = envelope.get("version")
            # isinstance(True, int) and True == 1, so a bare `"version": true` satisfied
            # `!= ENVELOPE_VERSION` and was ACCEPTED here, while the Go reader's
            # `parsed.version !== 1` rejects it and Go's *int unmarshal fails on it. Python
            # was the only client answering hit for those bytes.
            if isinstance(version, bool) or version != ENVELOPE_VERSION:
                raise EnvelopeDecodeError(f"unsupported envelope version {version!r}")
            payload = envelope["payload"]
            if not isinstance(payload, str):
                raise EnvelopeDecodeError(f"payload must be a string, got {type(payload).__name__}")
            # Both timestamps must be real numbers. int("5") would otherwise accept a
            # string where the Go reader rejects it, so the two would disagree about the
            # same bytes.
            created_at_ms = envelope["createdAtMs"]
            expires_at_ms = envelope["expiresAtMs"]
            for field, value in (("createdAtMs", created_at_ms), ("expiresAtMs", expires_at_ms)):
                if isinstance(value, bool) or not isinstance(value, int | float):
                    raise EnvelopeDecodeError(f"{field} must be a number, got {type(value).__name__}")
                # Double-representable, or a 401-digit value never looks expired and no
                # invalidation can reach it while Go calls the same bytes a miss.
                # float() not math.isfinite: isfinite raises OverflowError on a large int.
                try:
                    as_double = float(value)
                except OverflowError as exc:
                    raise EnvelopeDecodeError(f"{field} exceeds a double, got {value!r}") from exc
                if not math.isfinite(as_double):
                    raise EnvelopeDecodeError(f"{field} must be finite, got {value!r}")
                # Integral, not just numeric. Sub-1ms sounds ignorable but both readers
                # compare against a THRESHOLD: expiresAtMs=1000.9 at now=1000 is expired in
                # Python. Both clients reject it: rounding cannot make them agree, only
                # disagree differently.
                if not as_double.is_integer():
                    raise EnvelopeDecodeError(f"{field} must be a whole number of milliseconds, got {value!r}")
                # Bounded to the SAFE-INTEGER range, not int64: in the 2^53..int64 band both
                # clients accepted and then compared DIFFERENT numbers, which never
                # announces itself. The watermark keeps int64 because it reaches Python
                # through float(), so Python and Go already agree there.
                if not (_MIN_SAFE_INTEGER <= value <= _MAX_SAFE_INTEGER):
                    raise EnvelopeDecodeError(f"{field} is outside the safe-integer range, got {value!r}")
            encoding = envelope.get("encoding")
            if encoding == "base64":
                # Normalize first, because Python alone rejects three legal spellings a
                # foreign writer produces: the URL-safe alphabet, missing padding, and line
                # wrapping (the base64 CLI wraps at 76 columns by default, so a hand-repaired
                # entry has newlines). Go's normalizeBase64 does the same three, in the same
                # order -- whitespace BEFORE padding, or the padding is computed from a
                # length that counts the newlines and the decode fails on both sides for
                # some inputs and not others. validate=True still rejects a wrong alphabet.
                normalized = _WHITESPACE_RE.sub("", payload).replace("-", "+").replace("_", "/")
                payload = base64.b64decode(normalized + "=" * (-len(normalized) % 4), validate=True)
            elif encoding != "utf8":
                raise EnvelopeDecodeError(f"unsupported payload encoding {encoding!r}")
            # int() loses nothing -- the is_integer() check above already rejected any
            # fractional value, so this only narrows float to int for DecodedValue.
            return DecodedValue(
                created_at_ms=int(created_at_ms),
                payload=payload,
                is_json=True,
                expires_at_ms=int(expires_at_ms),
            )
        except EnvelopeDecodeError:
            raise
        except Exception as e:
            # As broad as the pickle branch, and for the same reason: this function promises
            # callers exactly one exception to treat as a miss. A narrower tuple let
            # RecursionError through on deeply nested JSON, and anything that escapes here
            # leaves the entry poisoned rather than rewritten.
            raise EnvelopeDecodeError(f"malformed JSON envelope: {e}") from e

    raise EnvelopeDecodeError(f"unrecognized envelope, leading byte {data[0]:#04x}")
