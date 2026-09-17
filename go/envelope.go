package gcache

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// envelopeVersion is the `version` field of the JSON envelope. It is shared with the
// Python client; bump only in lockstep with it.
const envelopeVersion = 1

// picklePROTO is the first byte of every pickle blob at protocol >= 2 (the PROTO opcode).
// A JSON object always starts with '{', so the two framings can never be confused -- which
// is what makes sniffing a stored value safe rather than a guess.
const picklePROTO = 0x80

// ErrPickleEnvelope is returned for a value a Python caller wrote under the default pickle
// envelope; treat it as a miss. LOAD-BEARING for the age invariant too: Cache.Get's proof that an old tracked entry is unreachable relies on an expiresAtMs pickle lacks, so reading pickle later would need Python's explicit age guard.
var ErrPickleEnvelope = errors.New("gcache: value uses the Python pickle envelope, not readable from Go")

// envelope is the cross-language value framing, identical to the one the Python package
// Python emits under
// Envelope.JSON.
type envelope struct {
	Version     int    `json:"version"`
	CreatedAtMs int64  `json:"createdAtMs"`
	ExpiresAtMs int64  `json:"expiresAtMs"`
	Encoding    string `json:"encoding"` // "utf8" | "base64"
	Payload     string `json:"payload"`
}

// encodeEnvelope frames an already-serialized payload for storage. A payload that is not
// valid UTF-8 is base64-encoded, the same branch Python takes for bytes -- without it,
// encoding/json would silently substitute U+FFFD per bad byte and write an unreadable value.
func encodeEnvelope(createdAt time.Time, ttl time.Duration, payload []byte) ([]byte, error) {
	createdMs := createdAt.UnixMilli()
	// The writer refuses what the reader rejects, matching Python's encode_json. Without
	// this an out-of-range timestamp wrote an entry no client can read back: rewritten and
	// rejected on every read, forever. Go was the one writer with no such check.
	if !isSafeInteger(float64(createdMs)) || !isSafeInteger(float64(createdMs+ttl.Milliseconds())) {
		return nil, fmt.Errorf("gcache: timestamps %d/%d outside the safe-integer range; no client could read this back",
			createdMs, createdMs+ttl.Milliseconds())
	}
	encoding, body := "utf8", string(payload)
	if !utf8.Valid(payload) {
		encoding, body = "base64", base64.StdEncoding.EncodeToString(payload)
	}
	return json.Marshal(envelope{
		Version:     envelopeVersion,
		CreatedAtMs: createdMs,
		ExpiresAtMs: createdMs + ttl.Milliseconds(),
		Encoding:    encoding,
		Payload:     body,
	})
}

// normalizeBase64 accepts the three legal spellings a foreign writer produces and neither
// client emits: the URL-safe alphabet, missing padding, and line wrapping (the base64 CLI
// wraps at 76 columns). Python's decode does the same three, in the same order.
//
// Whitespace comes out BEFORE padding is computed. Not stripping it at all -- what this did
// -- padded a length that counted the newlines, so a wrapped payload decoded here when that
// length happened to be a multiple of four and errored otherwise, agreeing with Python on
// neither outcome. Exactly these six ASCII bytes, not unicode.IsSpace, so Python's
// character class matches byte for byte.
func normalizeBase64(s string) string {
	s = strings.Map(func(r rune) rune {
		switch r {
		case ' ', '\t', '\n', '\r', '\v', '\f':
			return -1
		}
		return r
	}, s)
	s = strings.ReplaceAll(s, "-", "+")
	s = strings.ReplaceAll(s, "_", "/")
	if pad := len(s) % 4; pad != 0 {
		s += strings.Repeat("=", 4-pad)
	}
	return s
}

// The PROTO envelope. Protobuf wire format, hand-written rather than generated: four fields
// is small enough to pin byte-for-byte in the conformance corpus, and generating it would put
// protoc in a repo that has none. Python's counterpart is encode_proto/_decode_proto in
// _internal/envelope.py; envelope.proto documents the same schema.
//
//	field 1  version        varint
//	field 2  created_at_ms  varint
//	field 3  expires_at_ms  varint
//	field 4  payload        length-delimited
//
// FIELD NUMBERS MUST STAY <= 14. That is what makes the framing self-identifying: a tag byte
// is (field_number << 3) | wire_type, so fields 1-14 over proto3's wire types (0/1/2/5) span
// 0x08..0x75 -- disjoint from JSON's '{' (0x7b) and pickle's PROTO opcode (0x80). Field 16
// with a varint is exactly 0x80, so going past 15 would collide with pickle; capping at 15
// rather than 14 would stretch the range over 0x7b. Ten spare numbers remain.
const (
	protoFirstByteMin = 0x08
	protoFirstByteMax = 0x75

	wireVarint = 0
	wire64Bit  = 1
	wireLen    = 2
	wire32Bit  = 5
)

func putVarint(out []byte, value uint64) []byte {
	for value > 0x7F {
		out = append(out, byte(value&0x7F)|0x80)
		value >>= 7
	}
	return append(out, byte(value))
}

// getVarint reads a varint at i, returning the value and the next index. Bounded at 10 bytes,
// the most an int64 takes -- an unbounded loop on a truncated value reads past the end.
func getVarint(data []byte, i int) (uint64, int, error) {
	var value uint64
	var shift uint
	for n := 0; n < 10; n++ {
		if i >= len(data) {
			return 0, 0, errors.New("gcache: truncated varint")
		}
		b := data[i]
		i++
		value |= uint64(b&0x7F) << shift
		if b&0x80 == 0 {
			return value, i, nil
		}
		shift += 7
	}
	return 0, 0, errors.New("gcache: varint longer than 10 bytes")
}

// encodeProtoEnvelope frames an already-serialized binary payload. 18 bytes of overhead
// against the JSON envelope's ~102, and no base64 -- which is a third of the payload back.
func encodeProtoEnvelope(createdAt time.Time, ttl time.Duration, payload []byte) ([]byte, error) {
	createdAtMs := createdAt.UnixMilli()
	expiresAtMs := createdAtMs + ttl.Milliseconds()
	for _, f := range []struct {
		name string
		val  int64
	}{{"createdAtMs", createdAtMs}, {"expiresAtMs", expiresAtMs}} {
		if !isSafeInteger(float64(f.val)) {
			return nil, fmt.Errorf(
				"gcache: %s %d is outside the safe-integer range both clients read", f.name, f.val)
		}
		if f.val < 0 {
			// A negative varint is 10 bytes and reads back as a huge unsigned value in a
			// reader that does not sign-extend. Refuse rather than write something the two
			// clients would disagree about.
			return nil, fmt.Errorf("gcache: %s must be non-negative, got %d", f.name, f.val)
		}
	}

	out := make([]byte, 0, len(payload)+24)
	out = append(out, (1<<3)|wireVarint)
	out = putVarint(out, uint64(envelopeVersion))
	out = append(out, (2<<3)|wireVarint)
	out = putVarint(out, uint64(createdAtMs))
	out = append(out, (3<<3)|wireVarint)
	out = putVarint(out, uint64(expiresAtMs))
	out = append(out, (4<<3)|wireLen)
	out = putVarint(out, uint64(len(payload)))
	out = append(out, payload...)
	return out, nil
}

// decodeProtoEnvelope parses the PROTO envelope. Fields in any order, unknown fields skipped.
func decodeProtoEnvelope(data []byte) (payload []byte, createdAtMs int64, expiresAtMs int64, err error) {
	var version uint64
	var haveVersion, haveCreated, haveExpires, havePayload bool

	for i := 0; i < len(data); {
		tag, next, err := getVarint(data, i)
		if err != nil {
			return nil, 0, 0, err
		}
		i = next
		field, wire := tag>>3, tag&0x07
		switch wire {
		case wireVarint:
			value, next, err := getVarint(data, i)
			if err != nil {
				return nil, 0, 0, err
			}
			i = next
			switch field {
			case 1:
				version, haveVersion = value, true
			case 2:
				createdAtMs, haveCreated = int64(value), true
			case 3:
				expiresAtMs, haveExpires = int64(value), true
			}
		case wireLen:
			length, next, err := getVarint(data, i)
			if err != nil {
				return nil, 0, 0, err
			}
			i = next
			if uint64(len(data)-i) < length {
				return nil, 0, 0, errors.New("gcache: length-delimited field runs past the end")
			}
			if field == 4 {
				payload, havePayload = data[i:i+int(length)], true
			}
			i += int(length)
		case wire64Bit:
			i += 8
		case wire32Bit:
			i += 4
		default:
			// Wire types 3 and 4 are proto2 groups. proto3 never emits them, so a value
			// carrying one was not written by any gcache client.
			return nil, 0, 0, fmt.Errorf("gcache: unsupported wire type %d on field %d", wire, field)
		}
		if i > len(data) {
			return nil, 0, 0, errors.New("gcache: field runs past the end")
		}
	}

	// GREATER than, not !=. A strict check makes every added field a flag day: an old reader
	// would reject an entry it could otherwise parse, because the loop above already skips
	// fields it does not know.
	if !haveVersion || version > uint64(envelopeVersion) {
		return nil, 0, 0, fmt.Errorf("gcache: unsupported envelope version %d", version)
	}
	if !haveCreated || !haveExpires || !havePayload {
		return nil, 0, 0, fmt.Errorf(
			"gcache: incomplete PROTO envelope (createdAtMs=%t expiresAtMs=%t payload=%t)",
			haveCreated, haveExpires, havePayload)
	}
	return payload, createdAtMs, expiresAtMs, nil
}

// decodeEnvelope unframes a stored value, returning the payload, its write timestamp and its
// expiry -- together those give Cache.Get the declared lifetime that closes the resurrection
// gap. Sniffs the framing, so a key mid-migration or written by the other client still works.
func decodeEnvelope(raw []byte) (payload []byte, createdAtMs int64, expiresAtMs int64, err error) {
	if len(raw) == 0 {
		return nil, 0, 0, errors.New("gcache: empty value")
	}
	if raw[0] >= protoFirstByteMin && raw[0] <= protoFirstByteMax {
		return decodeProtoEnvelope(raw)
	}
	if raw[0] == picklePROTO {
		return nil, 0, 0, ErrPickleEnvelope
	}
	if raw[0] != '{' {
		return nil, 0, 0, fmt.Errorf("gcache: unrecognized envelope, leading byte %#04x", raw[0])
	}
	// Validate UTF-8 before unmarshalling. json.Unmarshal SUBSTITUTES U+FFFD for malformed
	// bytes inside a string rather than failing, so a corrupt payload came back as a cache
	// HIT with the bad bytes replaced -- the caller got wrong data, where Python's json.loads
	// raises and the entry becomes a miss-and-rewrite.
	if !utf8.Valid(raw) {
		return nil, 0, 0, errors.New("gcache: envelope is not valid UTF-8")
	}

	// Pointers so an ABSENT field is distinguishable from a zero one. Decoding straight into
	// the value struct made {"version":1,"encoding":"utf8","payload":"{}"} a HIT with
	// createdAtMs=0, where Python calls those same bytes a miss.
	var w struct {
		Version     *float64 `json:"version"`
		CreatedAtMs *float64 `json:"createdAtMs"`
		ExpiresAtMs *float64 `json:"expiresAtMs"`
		Encoding    *string  `json:"encoding"`
		Payload     *string  `json:"payload"`
	}
	if err := json.Unmarshal(raw, &w); err != nil {
		return nil, 0, 0, fmt.Errorf("gcache: malformed JSON envelope: %w", err)
	}
	// Reject an unknown version, matching Python's decode, so a future writer (tombstone,
	// compression flag) becomes a miss rather than a silent misread. Absent and wrong are
	// separate cases because w.Version is a *int: %v on it before the nil check printed the pointer, not the number, in the error message.
	if w.Version == nil {
		return nil, 0, 0, errors.New("gcache: envelope has no version")
	}
	// A NUMBER, not an int: JSON does not distinguish 1 from 1.0, and Python's
	// `version != ENVELOPE_VERSION` accepts the float spelling.
	// Unmarshalling into *int rejected it, making Go the only client to miss those bytes.
	if *w.Version != float64(envelopeVersion) {
		return nil, 0, 0, fmt.Errorf("gcache: unsupported envelope version %v, want %d", *w.Version, envelopeVersion)
	}
	if w.Payload == nil {
		return nil, 0, 0, errors.New("gcache: envelope has no payload")
	}
	for _, f := range []struct {
		name string
		val  *float64
	}{{"createdAtMs", w.CreatedAtMs}, {"expiresAtMs", w.ExpiresAtMs}} {
		if f.val == nil {
			return nil, 0, 0, fmt.Errorf("gcache: envelope has no %s", f.name)
		}
		// DEFENSIVE ONLY -- no input reaches this, since JSON has no NaN/Infinity literal
		// and encoding/json rejects an out-of-range number first. Kept because it states the
		// contract (Python checks math.isfinite); parseWatermark's twin IS reachable.
		if math.IsNaN(*f.val) || math.IsInf(*f.val, 0) {
			return nil, 0, 0, fmt.Errorf("gcache: %s must be finite, got %v", f.name, *f.val)
		}
		// A FRACTIONAL timestamp is rejected (a whole-valued float is not); Python rejects
		// it too. It matters because readers compare against a THRESHOLD:
		// expiresAtMs=1000.9 at now=1000 is unexpired for a truncating reader, expired for a rounding one.
		if *f.val != math.Trunc(*f.val) {
			return nil, 0, 0, fmt.Errorf(
				"gcache: %s must be a whole number of milliseconds, got %v", f.name, *f.val)
		}
		// Beyond the SAFE-INTEGER range (2^53) is rejected here; parseWatermark clamps at
		// int64 instead, since above 2^53 Go's float64 decode DISAGREED with Python's own
		// envelope parse with no error (measured: createdAtMs 9007199254740993 read as ...992 in Go, ...993 in Python). Both clients now share this bound.
		if !isSafeInteger(*f.val) {
			return nil, 0, 0, fmt.Errorf(
				"gcache: %s %v is outside the safe-integer range; it cannot round-trip "+
					"through a float64 without changing value", f.name, *f.val)
		}
	}
	createdAtMs, expiresAtMs = int64(*w.CreatedAtMs), int64(*w.ExpiresAtMs)

	encoding := ""
	if w.Encoding != nil {
		encoding = *w.Encoding
	}
	switch encoding {
	case "utf8":
		return []byte(*w.Payload), createdAtMs, expiresAtMs, nil
	case "base64":
		// See normalizeBase64 for which spellings this accepts and why.
		decoded, err := base64.StdEncoding.DecodeString(normalizeBase64(*w.Payload))
		if err != nil {
			return nil, 0, 0, fmt.Errorf("gcache: malformed base64 payload: %w", err)
		}
		return decoded, createdAtMs, expiresAtMs, nil
	default:
		return nil, 0, 0, fmt.Errorf("gcache: unknown payload encoding %q", encoding)
	}
}

// parseWatermark reads a watermark value. Python writes a plain decimal integer but reads
// it back through float() before int()-ing, so a float-formatted watermark is legal on the
// wire and must be accepted here too.
func parseWatermark(raw []byte) (int64, error) {
	s := strings.TrimSpace(string(raw))
	if s == "" {
		return 0, errors.New("gcache: empty watermark")
	}
	if ms, err := strconv.ParseInt(s, 10, 64); err == nil {
		return ms, nil
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, fmt.Errorf("gcache: malformed watermark %q: %w", s, err)
	}
	// A non-finite watermark is rejected (Cache.Get turns that into a miss) rather than left
	// to int64(f), which is implementation-defined: on arm64 int64(NaN) is 0, reading as "no
	// invalidation" and serving a suppressed entry. Python's own parser now suppresses-all on the same inputs, so the two clients still agree.
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, fmt.Errorf("gcache: non-finite watermark %q", s)
	}
	// A finite float outside int64 clamps rather than errors, which keeps Python's answer:
	// there int() yields the exact big integer and the >= comparison still decides stale.
	return clampToInt64(f), nil
}

// fitsInt64 reports whether a FINITE float64 converts to int64 with a defined result. A
// bare int64(f) is implementation-defined when f does not fit: arm64 saturates to MaxInt64,
// amd64 yields MinInt64, so one stored value would answer hit on a Mac, miss in production.
func fitsInt64(f float64) bool {
	return f > math.MinInt64 && f < math.MaxInt64
}

// maxSafeInteger is 2^53-1, the largest integer a float64 represents exactly. Above it,
// consecutive integers collide: 9007199254740993 and 9007199254740992 are the same float64.
const maxSafeInteger = 1<<53 - 1

// isSafeInteger reports whether a FINITE float64 round-trips an integer without changing
// value. The counterpart of JavaScript's Number.isSafeInteger, and used for the same reason
// -- see the envelope timestamp checks.
func isSafeInteger(f float64) bool {
	return f >= -maxSafeInteger && f <= maxSafeInteger
}

// clampToInt64 converts a FINITE float64 to int64, saturating rather than letting the
// hardware decide. Used for a watermark, where the envelope path rejects instead: a
// watermark is a SUPPRESSION instruction, so MaxInt64 ("everything is stale") is the fail-closed answer, unlike erroring to a spurious miss.
func clampToInt64(f float64) int64 {
	if fitsInt64(f) {
		return int64(f)
	}
	if f > 0 {
		return math.MaxInt64
	}
	return math.MinInt64
}

// isStale applies the protocol's staleness rule. The comparison is INCLUSIVE (`>=`),
// matching Python: a value written in the same millisecond as an invalidation is
// discarded. Loosening it to `>` would let a write that raced the invalidation survive.
func isStale(watermarkMs, createdAtMs int64) bool { return watermarkMs >= createdAtMs }
