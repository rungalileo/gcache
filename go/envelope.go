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

// decodeEnvelope unframes a stored value, returning the payload, its write timestamp, and
// its expiry -- paired with the timestamp, that gives Cache.Get the declared lifetime that
// closes the resurrection gap (see the guard there). Sniffs the framing rather than assuming, so a key mid-migration or written by another language still works.
// normalizeBase64 maps the URL-safe alphabet onto the standard one and restores padding,
// so this reader accepts everything Python's reader does. A genuinely wrong
// alphabet still fails in DecodeString afterwards.
func normalizeBase64(s string) string {
	s = strings.ReplaceAll(s, "-", "+")
	s = strings.ReplaceAll(s, "_", "/")
	if pad := len(s) % 4; pad != 0 {
		s += strings.Repeat("=", 4-pad)
	}
	return s
}

func decodeEnvelope(raw []byte) (payload []byte, createdAtMs int64, expiresAtMs int64, err error) {
	if len(raw) == 0 {
		return nil, 0, 0, errors.New("gcache: empty value")
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
		// A FRACTIONAL timestamp is rejected (a whole-valued float is not); all three
		// clients now reject it. It matters because readers compare against a THRESHOLD:
		// expiresAtMs=1000.9 at now=1000 is unexpired for a truncating reader, expired for a rounding one.
		if *f.val != math.Trunc(*f.val) {
			return nil, 0, 0, fmt.Errorf(
				"gcache: %s must be a whole number of milliseconds, got %v", f.name, *f.val)
		}
		// Beyond the SAFE-INTEGER range (2^53) is rejected here; parseWatermark clamps at
		// int64 instead, since above 2^53 Go's float64 decode DISAGREED with Python's own
		// envelope parse with no error (measured: createdAtMs 9007199254740993 read as ...992 in Go, ...993 in Python). All three clients now share this bound.
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
		// Normalize first: Node's Buffer.from accepts the URL-safe alphabet and unpadded
		// input, and Python normalizes both before decoding. StdEncoding alone rejected
		// them, so a RawURLEncoding writer was a miss in Go and a hit in the other two.
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
