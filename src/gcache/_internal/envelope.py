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

Reads sniff the first byte rather than trusting the declared envelope, so a reader
understands whatever the writer actually produced -- which is what lets a pickle key read a
JSON entry, and lets all three languages share one keyspace. Sniffing alone, though, would
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
from dataclasses import dataclass
from typing import Any

ENVELOPE_VERSION = 1

# Envelope timestamps are int64 milliseconds, matching the Go client. See decode().
_INT64_MAX = 2**63 - 1
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

    # A client built with decode_responses=True hands back str, not bytes. Both sniff
    # tests below then fail silently -- `data[0] == 0x80` is False for a one-char str and
    # `data[0:1] == b"{"` is False too -- and control reached the unrecognized-leading-byte
    # error, whose f"{data[0]:#04x}" raised ValueError. That escaped this function's
    # one-exception contract, so CacheController logged an error and never wrote back: the
    # entry stayed unreadable for its whole TTL, gcache_degraded_read_counter never moved,
    # and every read re-ran the fallback.
    #
    # Encoded rather than rejected, because a str is a legitimate transport form of the
    # same JSON text and decode_responses=True is an established pattern in the consuming
    # repo (services/api's AssistantService builds its client that way). The pickle branch
    # is unreachable from a str by construction -- a pickle blob is not valid UTF-8, so
    # redis-py could not have handed one back as str in the first place.
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
            # Validate the same three fields the TypeScript reader validates. Skipping them
            # makes the two readers disagree about the same bytes -- the version field in
            # particular exists precisely to turn a future writer's data into a miss.
            version = envelope.get("version")
            # isinstance(True, int) and True == 1, so a bare `"version": true` satisfied
            # `!= ENVELOPE_VERSION` and was ACCEPTED here, while the TypeScript reader's
            # `parsed.version !== 1` rejects it and Go's *int unmarshal fails on it. Python
            # was the only client answering hit for those bytes.
            if isinstance(version, bool) or version != ENVELOPE_VERSION:
                raise EnvelopeDecodeError(f"unsupported envelope version {version!r}")
            payload = envelope["payload"]
            if not isinstance(payload, str):
                raise EnvelopeDecodeError(f"payload must be a string, got {type(payload).__name__}")
            # Both timestamps must be real numbers, as parseEnvelope requires. int("5")
            # would otherwise accept a string where the TypeScript reader rejects it, so the
            # two would disagree about the same bytes.
            created_at_ms = envelope["createdAtMs"]
            expires_at_ms = envelope["expiresAtMs"]
            for field, value in (("createdAtMs", created_at_ms), ("expiresAtMs", expires_at_ms)):
                if isinstance(value, bool) or not isinstance(value, int | float):
                    raise EnvelopeDecodeError(f"{field} must be a number, got {type(value).__name__}")
                # Must be representable as a double, which is what the other two clients
                # can hold. JSON.parse maps an out-of-range integer LITERAL to Infinity, so
                # parseEnvelope's Number.isFinite check rejects it; Python's int is
                # arbitrary-precision and accepted a 401-digit value happily. That entry
                # then never looks expired and `watermark_ms >= created_at_ms` can never be
                # true, so no invalidation can ever reach it -- while TypeScript calls the
                # same bytes a miss.
                #
                # float() rather than math.isfinite: isfinite raises OverflowError on a
                # very large int, escaping this function's contract of raising only
                # EnvelopeDecodeError. float() fails on exactly the values JSON.parse
                # cannot represent, which is the line we need to match.
                try:
                    as_double = float(value)
                except OverflowError as exc:
                    raise EnvelopeDecodeError(f"{field} exceeds a double, got {value!r}") from exc
                if not math.isfinite(as_double):
                    raise EnvelopeDecodeError(f"{field} must be finite, got {value!r}")
                # Also bounded to int64, which is stricter than the TypeScript reader's
                # Number.isFinite. Double-representability is not enough: 1e300 passed the
                # check above and kept an exact 301-digit int, and no real watermark can
                # ever satisfy `watermark_ms >= created_at_ms` against that -- so the entry
                # became permanent and immune to invalidation, which is the one thing the
                # watermark exists to prevent. Same bound the Go client applies.
                #
                # Nothing legitimate is excluded: int64 milliseconds runs to year ~292
                # million, and all three writers stamp Date.now()-scale values. Being
                # stricter than TypeScript is the safe direction -- an entry it writes and
                # we reject is a miss that gets rewritten, not one served forever.
                if not (_INT64_MIN <= value <= _INT64_MAX):
                    raise EnvelopeDecodeError(f"{field} is outside int64, got {value!r}")
            encoding = envelope.get("encoding")
            if encoding == "base64":
                # Normalize before decoding. Node's Buffer.from(x, "base64") accepts both
                # the URL-safe alphabet ("a-_8") and unpadded input ("YWJjZGU"); Python
                # rejects both. So a Go writer using base64.RawURLEncoding would make every
                # Python read a miss-and-rewrite while the TypeScript reader kept hitting
                # the same key. validate=True is kept, so a genuinely wrong alphabet still
                # fails after the two URL-safe characters are mapped back.
                normalized = payload.replace("-", "+").replace("_", "/")
                payload = base64.b64decode(normalized + "=" * (-len(normalized) % 4), validate=True)
            elif encoding != "utf8":
                raise EnvelopeDecodeError(f"unsupported payload encoding {encoding!r}")
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
