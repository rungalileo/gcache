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
// Python and TypeScript clients; bump only in lockstep with them.
const envelopeVersion = 1

// picklePROTO is the first byte of every pickle blob at protocol >= 2 (the PROTO opcode).
// A JSON object always starts with '{', so the two framings can never be confused -- which
// is what makes sniffing a stored value safe rather than a guess.
const picklePROTO = 0x80

// ErrPickleEnvelope is returned when a value was written by a Python caller using the
// default pickle envelope. Go cannot read those (by design -- see the package docs), so
// callers should treat it as a miss and let the value be rewritten in the JSON envelope.
var ErrPickleEnvelope = errors.New("gcache: value uses the Python pickle envelope, not readable from Go")

// envelope is the cross-language value framing, identical to the one the TypeScript port
// writes (packages/gcache-ts/src/internal/redis-cache.ts) and the one Python emits under
// Envelope.JSON.
type envelope struct {
	Version     int    `json:"version"`
	CreatedAtMs int64  `json:"createdAtMs"`
	ExpiresAtMs int64  `json:"expiresAtMs"`
	Encoding    string `json:"encoding"` // "utf8" | "base64"
	Payload     string `json:"payload"`
}

// encodeEnvelope frames an already-serialized payload for storage.
//
// A payload that is not valid UTF-8 is base64-encoded, the same branch Python takes for a
// bytes payload. Without it encoding/json would silently substitute U+FFFD for each bad
// byte and report success, so a binary Codec would write a value nothing can read back.
func encodeEnvelope(createdAt time.Time, ttl time.Duration, payload []byte) ([]byte, error) {
	createdMs := createdAt.UnixMilli()
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
// the expiry the writer stamped on it.
//
// The expiry is returned rather than discarded for two separate reasons. It makes Go agree
// with the TypeScript reader, which already treats a past expiresAtMs as a miss. And with
// createdAtMs it gives Cache.Get the DECLARED LIFETIME, which is what actually closes the
// resurrection gap -- a tracked entry claiming to live longer than the watermark does is
// distrusted there. The expiry alone does not close it; see the guard in Get.
//
// It sniffs the framing rather than assuming, so a key mid-migration -- or one written by
// another language's client -- is still handled correctly.
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

	// Pointers so an ABSENT field is distinguishable from a zero one, and float64 for the
	// timestamps because Python accepts a float there (int() truncates) and the TypeScript
	// reader only asks for Number.isFinite. Decoding straight into the value struct made
	// {"version":1,"encoding":"utf8","payload":"{}"} a HIT with createdAtMs=0: the expiry
	// guard skips a zero, the declared-lifetime guard skips 0>0, and an untracked key has
	// no watermark left to catch it. Python and TypeScript both call those same bytes a
	// miss, which is the cross-language divergence this envelope exists to prevent.
	var w struct {
		Version     *int     `json:"version"`
		CreatedAtMs *float64 `json:"createdAtMs"`
		ExpiresAtMs *float64 `json:"expiresAtMs"`
		Encoding    *string  `json:"encoding"`
		Payload     *string  `json:"payload"`
	}
	if err := json.Unmarshal(raw, &w); err != nil {
		return nil, 0, 0, fmt.Errorf("gcache: malformed JSON envelope: %w", err)
	}
	// Reject an unknown version, matching Python's decode. The version field exists so a
	// future writer -- one that adds a tombstone or a compression flag -- turns into a miss
	// rather than being silently misread. If Go accepted it and Python did not, one key
	// would answer differently in each language, which is the exact failure the shared
	// envelope is supposed to prevent.
	// Absent and wrong are separate cases, and the value is DEREFERENCED. w.Version is a
	// *int, so %v printed the pointer: `"version":2` produced "unsupported envelope
	// version 0xc000014098". The field exists to make a future writer diagnosable, and
	// that message removed the one number worth reading.
	if w.Version == nil {
		return nil, 0, 0, errors.New("gcache: envelope has no version")
	}
	if *w.Version != envelopeVersion {
		return nil, 0, 0, fmt.Errorf("gcache: unsupported envelope version %d, want %d", *w.Version, envelopeVersion)
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
		// DEFENSIVE ONLY -- no input can reach this, and that is worth saying rather than
		// leaving the next reader to assume it is load-bearing. encoding/json rejects a
		// number outside float64 before this runs ("cannot unmarshal number 1e999"), and
		// JSON has no NaN or Infinity literal, so every non-finite candidate fails at the
		// Unmarshal above. Verified for NaN, Infinity, -Infinity, 1e999 and -1e999.
		//
		// Kept because it states a term of the cross-language contract -- Python checks
		// math.isfinite explicitly -- rather than leaving Go's compliance incidental to
		// how encoding/json happens to behave. parseWatermark's identical check IS
		// reachable and load-bearing: strconv.ParseFloat accepts "nan" and "inf".
		if math.IsNaN(*f.val) || math.IsInf(*f.val, 0) {
			return nil, 0, 0, fmt.Errorf("gcache: %s must be finite, got %v", f.name, *f.val)
		}
		// A FRACTIONAL timestamp is rejected; a float that happens to be whole (1757...0)
		// is not. Both other clients reject it as of gcache 45f511f -- Python raises
		// "must be a whole number of milliseconds" and the TypeScript reader switched from
		// Number.isFinite to Number.isInteger -- and Go accepting it was the last
		// disagreement left on this field.
		//
		// The reason it matters is that both readers compare the value against a
		// THRESHOLD, so a sub-millisecond difference flips a boolean rather than shifting
		// an answer slightly: expiresAtMs=1000.9 at now=1000 is unexpired for a reader
		// that truncates and expired for one that rounds. Rejecting is the only outcome
		// all three agree on -- the entry misses, is rewritten with whole milliseconds,
		// and heals.
		if *f.val != math.Trunc(*f.val) {
			return nil, 0, 0, fmt.Errorf(
				"gcache: %s must be a whole number of milliseconds, got %v", f.name, *f.val)
		}
		// Beyond the SAFE-INTEGER range is rejected here, where parseWatermark clamps at
		// int64. The bounds differ on purpose, and the reason is measurable rather than
		// stylistic: the two fields reach Python through different parsers.
		//
		//	envelope    json.loads -> a PYTHON INT, exact at any magnitude
		//	watermark   float() then int() -> a float64, rounded above 2^53
		//
		// Go decodes both through float64, so above 2^53 it agrees with Python on the
		// watermark and DISAGREES on the envelope. Measured: createdAtMs 9007199254740993
		// reads as ...992 in Go and ...993 in Python, and 9007199254740995 reads as ...996
		// in both Go and Python's watermark but ...995 in Python's envelope. Both sides
		// pass validation and compare different numbers against the staleness threshold,
		// with no error anywhere -- worse than a miss.
		//
		// So the envelope stops at 2^53-1, matching the TypeScript reader's
		// Number.isSafeInteger (it moved off Number.isInteger for exactly this, because
		// JSON.parse had already rounded the value before the check ran). That leaves Go
		// and TS rejecting where Python accepts, which is the self-healing direction: the
		// entry misses and is rewritten. Real timestamps sit ~5000x below the bound --
		// 2^53 ms is roughly year 287396 -- so nothing legitimate is refused.
		//
		// An envelope timestamp describes the entry's OWN lifetime. Accepting one that no
		// watermark can exceed -- isStale compares watermarkMs >= createdAtMs -- makes the
		// entry permanent and immune to invalidation for its whole Redis TTL. Rejecting it
		// is a miss, so the entry is simply rewritten with a sane timestamp. No legitimate
		// writer produces one: int64 milliseconds runs to roughly year 292 million and all
		// three clients emit Date.now()-scale values.
		//
		// All three clients now share this bound, so it is no longer an asymmetry. Python
		// matched it in gcache 98c5ac9 and the TypeScript reader in 4b2b704; verified
		// against the pinned revision, where createdAtMs 9007199254740993 is rejected as
		// "outside the safe-integer range" and 9007199254740991 is accepted.
		//
		// An earlier version of this comment claimed the asymmetry was safe because an
		// out-of-domain entry "makes the other two miss and rewrite". That held for 1e300
		// and NOT for the 2^53..int64 band, where every client accepted and two of them
		// compared different numbers. The bound above is what closes that band; the note
		// is corrected rather than left as the justification for a hole.
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
		decoded, err := base64.StdEncoding.DecodeString(*w.Payload)
		if err != nil {
			return nil, 0, 0, fmt.Errorf("gcache: malformed base64 payload: %w", err)
		}
		return decoded, createdAtMs, expiresAtMs, nil
	default:
		return nil, 0, 0, fmt.Errorf("gcache: unknown payload encoding %q", encoding)
	}
}

// parseWatermark reads a watermark value.
//
// Python writes a plain decimal integer but reads it back through float() before
// int()-ing, so a float-formatted watermark is legal on the wire and must be accepted
// here too.
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
	// A non-finite watermark is rejected, which Cache.Get turns into a miss. Leaving it to
	// int64(f) would be implementation-defined -- on arm64 int64(NaN) is 0, reading as "no
	// invalidation" and serving an entry someone suppressed.
	//
	// Python no longer raises here, as it did when this was written. Since gcache 103d7ba
	// its _parse_watermark substitutes a suppress-all sentinel for anything unreadable or
	// non-finite, so the two clients now agree on every input -- by different routes and
	// with the same answer. Measured across both:
	//
	//	nan, inf, -inf, abc, ""   suppress in Python, rejected here; miss either way
	//	1e300                     clamps high in both; suppresses
	//	-1e300                     clamps low in both; serves
	//
	// The finite/non-finite line is the one that matters, and it is deliberate on both
	// sides: "-1e300" is a real instruction ("an extremely old watermark, nothing is
	// stale") while "-inf" is not a timestamp at all. Suppressing is the fail-closed
	// direction for a watermark, so the non-finite cases end as a miss rather than as a
	// served entry.
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, fmt.Errorf("gcache: non-finite watermark %q", s)
	}
	// A finite float outside int64 clamps rather than errors, which keeps Python's answer:
	// there int() yields the exact big integer and the >= comparison still decides stale.
	return clampToInt64(f), nil
}

// fitsInt64 reports whether a FINITE float64 converts to int64 with a defined result.
//
// A bare int64(f) is implementation-defined when f does not fit, and the two architectures
// this library is built for disagree at OPPOSITE ends: arm64 saturates to MaxInt64, amd64 yields
// the indefinite value MinInt64. Verified by running this package under both. Left to the
// hardware, one stored value answers hit on a developer's Mac and miss in production.
//
// Every float-to-int64 conversion on the wire path goes through this test first. What the
// two callers then DO differs -- see the comment at each -- but the range question is
// asked in one place so the answer cannot drift.
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
// hardware decide.
//
// Used for a watermark, where the envelope path rejects instead. A watermark is a
// SUPPRESSION instruction, so saturating reproduces Python's answer exactly: there int()
// yields the exact big integer and `watermark_ms >= created_at_ms` still decides stale.
// MaxInt64 says "everything is stale", which is that same answer and the fail-closed
// direction. Erroring would also degrade to a miss, but it would record a spurious
// watermark-decode failure for a value whose meaning was never in doubt.
func clampToInt64(f float64) int64 {
	if fitsInt64(f) {
		return int64(f)
	}
	if f > 0 {
		return math.MaxInt64
	}
	return math.MinInt64
}

// isStale applies the protocol's staleness rule.
//
// The comparison is INCLUSIVE (`>=`), matching Python: a value written in the very same
// millisecond as an invalidation is discarded. Loosening it to `>` would let a write that
// raced an invalidation survive.
func isStale(watermarkMs, createdAtMs int64) bool { return watermarkMs >= createdAtMs }
