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

from gcache.exceptions import UnserializableValue

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


# --- The PROTO envelope -------------------------------------------------------------------
#
# Protobuf wire format, hand-written rather than generated: four fields is small enough to
# pin byte-for-byte in the conformance corpus, and generating it would put protoc in a repo
# that has none AND make protobuf non-optional here (it is a lazy import on purpose --
# ~30 google.* modules on every `import gcache` was ruled out). See envelope.proto, which
# documents the same schema so another language can interoperate.
#
#   field 1  version        varint
#   field 2  created_at_ms  varint
#   field 3  expires_at_ms  varint
#   field 4  payload        length-delimited
#
# FIELD NUMBERS MUST STAY <= 14. That is what makes the framing self-identifying: a tag byte
# is (field_number << 3) | wire_type, so fields 1-14 over proto3's wire types (0/1/2/5) span
# 0x08..0x75 -- disjoint from JSON's '{' (0x7b) and pickle's PROTO opcode (0x80). Field 16
# with a varint is exactly 0x80, so going past 15 would collide with pickle; and capping at
# 15 rather than 14 would stretch the range over 0x7b. Ten spare numbers remain.
_PROTO_FIRST_BYTE_MIN = 0x08
_PROTO_FIRST_BYTE_MAX = 0x75

_WIRE_VARINT, _WIRE_64BIT, _WIRE_LEN, _WIRE_32BIT = 0, 1, 2, 5


def _put_varint(out: bytearray, value: int) -> None:
    while value > 0x7F:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value)


def _get_varint(data: bytes, i: int) -> tuple[int, int]:
    """Read a varint at ``i``; return (value, next index). Bounded at 10 bytes, which is the
    most an int64 can take -- an unbounded loop on a truncated value reads past the end."""
    value = shift = 0
    for _ in range(10):
        if i >= len(data):
            raise EnvelopeDecodeError("truncated varint")
        byte = data[i]
        i += 1
        # The TENTH byte carries only bit 63, so anything above 0x01 there encodes a value
        # wider than uint64. Bounding the LENGTH at 10 is not enough: 3<<63 fits in ten bytes,
        # and _to_signed64 then subtracts 2^64 and returns a POSITIVE 2^63 -- sailing past the
        # negative-timestamp guard as a plausible-looking number. Go's getVarint wraps at 64
        # bits instead, so the same bytes give the two clients different values again.
        if shift == 63 and byte > 0x01:
            raise EnvelopeDecodeError(f"varint wider than 64 bits (tenth byte {byte:#04x})")
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, i
        shift += 7
    raise EnvelopeDecodeError("varint longer than 10 bytes")


def encode_proto(created_at_ms: int, ttl_sec: int, payload: bytes) -> bytes:
    """Frame an already-serialized binary ``payload`` in the PROTO envelope.

    18 bytes of overhead against the JSON envelope's ~102, and no base64 -- which is a third
    of the payload back. The cost is that neither the payload nor the metadata is readable
    from ``redis-cli`` or Redis's Lua ``cjson`` any more; see the README.
    """
    if not isinstance(payload, bytes):
        raise EnvelopeEncodeError(f"the PROTO envelope carries bytes, got {type(payload).__name__}")

    # The PROTO framing is not an exemption. Its payload is opaque bytes, but "opaque" is the
    # writer's word: a custom Serializer can put JSON text here just as easily as protobuf,
    # and then the caller's codec unescapes it on both sides. Protobuf itself does not parse
    # as JSON, so it never reaches the walk.
    _reject_lone_surrogate(payload)

    # The SAME bound the JSON envelope enforces, though binary has no float64 rounding to
    # fear. One bound across both framings means a value written under either can be
    # expressed under the other, so switching a use case cannot make a timestamp
    # unrepresentable.
    expires_at_ms = created_at_ms + ttl_sec * 1000
    for field, value in (("createdAtMs", created_at_ms), ("expiresAtMs", expires_at_ms)):
        if not (_MIN_SAFE_INTEGER <= value <= _MAX_SAFE_INTEGER):
            raise EnvelopeEncodeError(
                f"{field} would be {value}, outside the safe-integer range that both "
                f"clients can read (created_at_ms={created_at_ms}, ttl_sec={ttl_sec})"
            )
    if created_at_ms < 0 or expires_at_ms < 0:
        # A negative varint is 10 bytes and reads back as a huge unsigned value in a reader
        # that does not sign-extend. Refuse rather than write something the two clients
        # would disagree about.
        raise EnvelopeEncodeError(f"timestamps must be non-negative, got {created_at_ms}/{expires_at_ms}")

    out = bytearray()
    out.append((1 << 3) | _WIRE_VARINT)
    _put_varint(out, ENVELOPE_VERSION)
    out.append((2 << 3) | _WIRE_VARINT)
    _put_varint(out, created_at_ms)
    out.append((3 << 3) | _WIRE_VARINT)
    _put_varint(out, expires_at_ms)
    out.append((4 << 3) | _WIRE_LEN)
    _put_varint(out, len(payload))
    out += payload
    return bytes(out)


def _to_signed64(value: int) -> int:
    """Reinterpret a varint as the signed int64 the schema declares.

    `created_at_ms` and `expires_at_ms` are `int64` in envelope.proto, and protobuf encodes a
    negative int64 as a 10-byte varint of its two's complement -- so reading the varint as
    unsigned turns -1 into 18446744073709551615. Go does `int64(value)` and gets -1, so the
    two clients disagreed about the same bytes: an entry with a negative expires_at_ms was
    long expired in Go and roughly 584 million years in the future in Python, which served it
    as a fresh hit forever.
    """
    return value - (1 << 64) if value >= (1 << 63) else value


def _decode_proto(data: bytes) -> DecodedValue:
    """Parse the PROTO envelope. Fields in any order, unknown fields skipped."""
    version: int | None = None
    created_at_ms: int | None = None
    expires_at_ms: int | None = None
    payload: bytes | None = None

    i = 0
    while i < len(data):
        tag, i = _get_varint(data, i)
        field, wire = tag >> 3, tag & 0x07
        if wire == _WIRE_VARINT:
            value, i = _get_varint(data, i)
            if field == 1:
                version = value
            elif field == 2:
                created_at_ms = _to_signed64(value)
            elif field == 3:
                expires_at_ms = _to_signed64(value)
        elif wire == _WIRE_LEN:
            length, i = _get_varint(data, i)
            if i + length > len(data):
                raise EnvelopeDecodeError("length-delimited field runs past the end")
            if field == 4:
                payload = data[i : i + length]
            i += length
        elif wire == _WIRE_64BIT:
            i += 8
        elif wire == _WIRE_32BIT:
            i += 4
        else:
            # Wire types 3 and 4 are proto2 groups. proto3 never emits them, so a value
            # carrying one was not written by any gcache client.
            raise EnvelopeDecodeError(f"unsupported wire type {wire} on field {field}")
        if i > len(data):
            raise EnvelopeDecodeError("field runs past the end")

    # GREATER than, not !=. A strict check makes every added field a flag day: an old reader
    # would reject an entry it could otherwise parse, because protobuf already skips fields
    # it does not know. Rejecting only a HIGHER version keeps that forward compatibility and
    # still refuses a deliberate incompatible break.
    # `< 1` as well as `> ENVELOPE_VERSION`. Rejecting only a HIGHER version let an
    # explicit-or-absent zero through, because 0 > 1 is false -- so a frame carrying no
    # usable version decoded as a HIT. The JSON envelope already refuses it (the
    # `version-zero` corpus vector expects `reject`), and this path did not, which is the
    # kind of one-sided divergence the shared corpus exists to prevent.
    #
    # No legitimate writer is excluded: both clients set version explicitly to
    # ENVELOPE_VERSION (1), and proto3 encodes a non-zero scalar, so a real frame always
    # carries it. Zero here means an absent field -- a writer that did not set it.
    if version is None or version < 1 or version > ENVELOPE_VERSION:
        raise EnvelopeDecodeError(f"unsupported envelope version {version!r}")
    # Negative is not a timestamp. Both clients now READ these identically, so this is no
    # longer about divergence -- it is that a negative epoch-ms is meaningless and, unchecked,
    # is the shape the divergence above turned into a permanent hit. Refuse it as a miss.
    if (created_at_ms is not None and created_at_ms < 0) or (expires_at_ms is not None and expires_at_ms < 0):
        raise EnvelopeDecodeError(
            f"negative envelope timestamp (createdAtMs={created_at_ms} expiresAtMs={expires_at_ms})"
        )
    if created_at_ms is None or expires_at_ms is None or payload is None:
        raise EnvelopeDecodeError(
            f"incomplete PROTO envelope (version={version} createdAtMs={created_at_ms} "
            f"expiresAtMs={expires_at_ms} payload={'set' if payload is not None else None})"
        )
    return DecodedValue(created_at_ms=created_at_ms, payload=payload, is_json=True, expires_at_ms=expires_at_ms)


def _reject_lone_surrogate(payload: str | bytes) -> None:
    """Refuse a payload the two clients would decode to different values.

    HERE, at the framing boundary, not in one serializer: every serializer's output passes
    through the encoders, so a check living in ``JsonSerializer`` was bypassed by any CUSTOM
    ``Serializer`` -- and ``serializer=`` is public, documented API, so that is a supported
    path rather than an exotic one. The rule is a property of the envelope.
    """
    reason = lone_surrogate_reason(payload)
    if reason is not None:
        raise UnserializableValue(reason)


def lone_surrogate_reason(payload: str | bytes) -> str | None:
    """Name the divergence in ``payload``, or ``None`` if the two clients agree about it.

    The rule is "valid UTF-8 that parses as strict JSON and holds an unpaired surrogate",
    and NOT anything about the Python type or the transport encoding. Two earlier attempts
    used those instead and both were wrong:

    * ``isinstance(payload, str)`` caught PICKLE values, because ``decode`` returns the
      UNPICKLED object and a cached string is a ``str``. A ``@cached`` function under the
      default envelope returning a string with a lone surrogate was written happily and then
      refused on every read -- a permanent miss on the one framing Go cannot read at all, so
      there was never a divergence to prevent. The same string inside a dict was served,
      which is the tell that the discriminator had nothing to do with the rule.
    * the envelope's ``encoding`` field is equally wrong, and Go tried it. ``base64`` means
      "the writer handed us bytes", not "this is binary": a ``Serializer`` returning ``bytes``
      from ``json.dumps`` lands there with JSON text inside, and that text is exactly what
      the two clients disagree about.

    What actually decides it is whether the CALLER's codec will unescape the payload, which
    neither client can see. "Parses as strict JSON" is the closest honest proxy, and it is
    self-limiting: protobuf and other binary do not parse, so they are left alone.

    Split from the raise so the READ path can ask the same question. The write guard stops
    this client creating a divergent entry; it says nothing about one already in Redis,
    written by a foreign client or an older build. Reading it is where the harm lands, and
    it is the harm with no symptom -- both clients report a hit and return different values.
    """
    if isinstance(payload, bytes):
        try:
            body = payload.decode("utf-8")
        except UnicodeDecodeError:
            # Genuinely binary. Go's utf8.Valid gate reaches the same conclusion.
            return None
    else:
        body = payload
        try:
            body.encode("utf-8")
        except UnicodeEncodeError:
            # A literal surrogate CHARACTER, from a serializer that never went through
            # json.dumps. Unencodable by definition.
            return "an unencodable code point (a lone surrogate)"

    # Both spellings: JSON permits \uD800 as readily as \ud800, and every surrogate escape
    # starts with those three characters. Gating on a bare `\u` would parse every non-ASCII
    # payload written under ensure_ascii, which is most of them.
    if "\\ud" not in body and "\\uD" not in body:
        return None
    # BEFORE the parse, and the reason is determinism rather than safety. Relying on the
    # interpreter to tell us when a payload is too deep makes the ANSWER depend on the
    # machine: depth 4000 parses on a developer laptop and raises RecursionError in CI, so
    # the same payload was written on one host and refused on another. Two Python pods
    # disagreeing about an entry is the same defect as Python and Go disagreeing about one.
    #
    # An explicit limit, counted identically in both clients and pinned by the corpus,
    # replaces that. 500 is far under the lowest interpreter limit in any environment and far
    # over any real payload -- and it is only ever reached by a payload that already contains
    # a surrogate escape, since the substring gate runs first.
    if _exceeds_nesting(body):
        return f"a payload nested deeper than the {_MAX_JSON_NESTING}-level limit"
    try:
        # object_pairs_hook=list keeps DUPLICATE keys. Without it json.loads silently drops
        # all but the last, so `{"a":"\ud800","a":"ok"}` lost the surrogate before the walk
        # and Python accepted what Go's escape scan refused.
        #
        # parse_constant refuses NaN/Infinity, which json.loads accepts by default and Go's
        # json.Valid does not. Without it the two clients disagreed about whether such a
        # payload was JSON at all, and so about whether this rule applied to it.
        #
        # RecursionError as well as ValueError: json.loads raises it past the interpreter's
        # nesting limit, and it is not a ValueError. Escaping here would put an exception
        # through a guard whose whole job is to refuse an entry WITHOUT failing the read --
        # the caller would log an error, re-run the fallback and never write back, leaving
        # the entry to fail every read for its full TTL.
        parsed = json.loads(body, object_pairs_hook=list, parse_constant=_refuse_json_constant)
    except RecursionError:
        # Unreachable while _MAX_JSON_NESTING stays well under the interpreter's limit, and
        # kept because "unreachable" is a property of a constant someone can raise. Fails
        # CLOSED, unlike a plain parse failure: an open failure here would serve a payload
        # this client could not inspect.
        return "a payload too deeply nested to check"
    except ValueError:
        # Not strict JSON. Neither client unescapes it, so neither can disagree about it.
        return None
    if _holds_lone_surrogate(parsed):
        return "a lone surrogate escape"
    return None


#: Maximum JSON nesting either client will inspect. Shared with Go's maxJSONNesting and
#: pinned by the conformance corpus. See _exceeds_nesting for why it is explicit.
_MAX_JSON_NESTING = 500


def _exceeds_nesting(body: str) -> bool:
    """Report whether ``body`` nests deeper than ``_MAX_JSON_NESTING``, string-aware.

    A raw count of ``[`` and ``{`` would refuse an ordinary flat array of 500 objects, so
    this tracks NET depth, and skips brackets inside string literals -- a value containing
    ``"[[[["`` is not nesting.

    Identical in Go (``exceedsNesting``), deliberately, and over the same text: the two
    clients must refuse the same payloads, and a scan is the only way to decide that without
    inheriting each parser's own private limit.
    """
    depth = 0
    in_string = False
    escaped = False
    for ch in body:
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
        elif ch in "[{":
            depth += 1
            if depth > _MAX_JSON_NESTING:
                return True
        elif ch in "]}":
            depth -= 1
    return False


def _refuse_json_constant(name: str) -> object:
    """Make json.loads reject NaN/Infinity, as Go's json.Valid does."""
    raise ValueError(f"not strict JSON: {name}")


def _holds_lone_surrogate(value: object) -> bool:
    """Walk a parsed JSON value for an unpaired surrogate, stopping at the first one.

    The PARSED value, not a re-serialization of it. json.loads combines a valid pair into the
    single non-BMP character it denotes, so any surrogate code point still present afterwards
    is by definition unpaired -- which makes utf-8 the exact test, on strings this walk can
    short-circuit out of. Re-dumping with ``ensure_ascii=False`` answered the same question
    and measured 2.35x a bare ``json.loads`` on a 40 KB emoji payload, because it built a
    whole second copy before testing any of it.

    Iterative rather than recursive: nothing bounds a payload's nesting depth, and a
    RecursionError raised out of this guard would be worse than the divergence it looks for.

    Tuples as well as lists, because ``object_pairs_hook=list`` renders every object as a
    list of ``(key, value)`` tuples -- so this walk visits KEYS too, which diverge exactly as
    values do.
    """
    stack: list[object] = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, str):
            try:
                item.encode("utf-8")
            except UnicodeEncodeError:
                return True
        elif isinstance(item, list | tuple):
            stack.extend(item)
        elif isinstance(item, dict):
            stack.extend(item.keys())
            stack.extend(item.values())
    return False


def encode_json(created_at_ms: int, ttl_sec: int, payload: str | bytes) -> bytes:
    """Frame ``payload`` in the cross-language JSON envelope.

    ``payload`` must already be serialized -- the JSON envelope carries a string, so keys
    using it need a ``Serializer`` (``JsonSerializer`` by default). ``bytes`` payloads are
    base64-encoded and flagged via ``encoding``.
    """
    # BEFORE the branch, so a bytes payload is asked the same question. `Serializer.dump` is
    # typed `-> bytes | str`, and a serializer returning the bytes of a json.dumps lands in
    # the base64 branch with JSON text inside -- which is exactly the payload the two clients
    # decode differently, while Go, reading the base64-decoded bytes, refuses it. Checking
    # only the str branch made this client the one that wrote what the other would not read.
    _reject_lone_surrogate(payload)
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
    """Decode a stored value from its framing, which every framing identifies itself by.

    The key's declared envelope is deliberately NOT consulted to pick a framing. It was
    considered: prioritise the declaration, fall back to the others. But the three framings
    occupy disjoint first bytes, so the sniff already lands on exactly one -- the declaration
    could only ever agree with it, and a branch for it would be ceremony. What the declaration
    IS used for is the one place it changes an outcome: ``allow_pickle``, below.

    Self-identifying by first byte, which is why no magic prefix is needed:

    * ``0x08``-``0x75`` -- PROTO. A tag byte is ``(field << 3) | wire_type``, so fields 1-14
      over proto3's wire types span exactly this range. See _PROTO_FIRST_BYTE_MIN.
    * ``0x7b`` (``{``) -- JSON.
    * ``0x80`` -- pickle. Only ever unpickled when the key declares it; see ``allow_pickle``.

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

    if _PROTO_FIRST_BYTE_MIN <= data[0] <= _PROTO_FIRST_BYTE_MAX:
        return _decode_proto(data)

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
