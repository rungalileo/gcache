package gcache

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestEncodeEnvelopeShapeMatchesTheOtherClients(t *testing.T) {
	// This exact shape is what Python's Envelope.JSON and the Python port write. If Go
	// drifts, the two silently stop reading each other.
	created := time.UnixMilli(1_757_308_800_123)
	raw, err := encodeEnvelope(created, 60*time.Second, []byte(`{"a":1}`))
	if err != nil {
		t.Fatalf("encodeEnvelope: %v", err)
	}

	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("result is not JSON: %v", err)
	}
	want := map[string]any{
		"version":     float64(1),
		"createdAtMs": float64(1_757_308_800_123),
		"expiresAtMs": float64(1_757_308_800_123 + 60_000),
		"encoding":    "utf8",
		"payload":     `{"a":1}`,
	}
	for k, w := range want {
		if got[k] != w {
			t.Errorf("field %q = %v, want %v", k, got[k], w)
		}
	}
}

func TestDecodeEnvelopeRoundTrip(t *testing.T) {
	raw, err := encodeEnvelope(time.UnixMilli(42), time.Minute, []byte("hello"))
	if err != nil {
		t.Fatalf("encodeEnvelope: %v", err)
	}
	payload, createdAtMs, _, err := decodeEnvelope(raw)
	if err != nil {
		t.Fatalf("decodeEnvelope: %v", err)
	}
	if string(payload) != "hello" || createdAtMs != 42 {
		t.Errorf("got (%q, %d), want (%q, %d)", payload, createdAtMs, "hello", 42)
	}
}

func TestDecodeEnvelopeAcceptsBase64PayloadsFromOtherClients(t *testing.T) {
	// The Python port base64s Buffer payloads. Go must read those even though it only
	// ever writes utf8.
	raw, _ := json.Marshal(envelope{
		Version: 1, CreatedAtMs: 7, ExpiresAtMs: 8,
		Encoding: "base64", Payload: base64.StdEncoding.EncodeToString([]byte{0x00, 0xff}),
	})
	payload, _, _, err := decodeEnvelope(raw)
	if err != nil {
		t.Fatalf("decodeEnvelope: %v", err)
	}
	if string(payload) != "\x00\xff" {
		t.Errorf("payload = %q", payload)
	}
}

func TestDecodeEnvelopeReportsPickleDistinctly(t *testing.T) {
	// A Python-written pickle value must be reported as its own error so the caller can
	// treat it as a miss and rewrite it, rather than logging it as corruption.
	pickled := append([]byte{picklePROTO, 0x05}, []byte("whatever")...)
	if _, _, _, err := decodeEnvelope(pickled); !errors.Is(err, ErrPickleEnvelope) {
		t.Errorf("err = %v, want ErrPickleEnvelope", err)
	}
}

func TestDecodeEnvelopeRejectsGarbage(t *testing.T) {
	for _, raw := range [][]byte{nil, {}, []byte("not an envelope"), []byte("[1,2,3]"), []byte("{oops")} {
		if _, _, _, err := decodeEnvelope(raw); err == nil {
			t.Errorf("decodeEnvelope(%q) = nil error, want one", raw)
		}
	}
}

func TestDecodeEnvelopeRejectsWhatPythonRejects(t *testing.T) {
	// The two readers must agree about the same bytes, or one key answers differently per
	// language. The version case is load-bearing: the field exists so a future writer
	// (tombstone, compression flag) becomes a miss instead of being silently misread.
	for name, raw := range map[string]string{
		"future version":   `{"version":99,"createdAtMs":5,"expiresAtMs":6,"encoding":"utf8","payload":"x"}`,
		"missing version":  `{"createdAtMs":5,"expiresAtMs":6,"encoding":"utf8","payload":"x"}`,
		"absent encoding":  `{"version":1,"createdAtMs":5,"expiresAtMs":6,"payload":"x"}`,
		"unknown encoding": `{"version":1,"createdAtMs":5,"expiresAtMs":6,"encoding":"rot13","payload":"x"}`,
	} {
		if _, _, _, err := decodeEnvelope([]byte(raw)); err == nil {
			t.Errorf("decodeEnvelope accepted a %s envelope", name)
		}
	}
}

func TestParseWatermarkAcceptsBothFormsPythonCanWrite(t *testing.T) {
	// Python writes an int but reads via float(), so a float-formatted watermark is legal.
	tests := map[string]int64{
		"1757308800123":     1757308800123,
		"1757308800123.0":   1757308800123,
		"1757308800123.999": 1757308800123, // truncates, as Python's int(float) does
		"  1757308800123 ":  1757308800123,
	}
	for in, want := range tests {
		got, err := parseWatermark([]byte(in))
		if err != nil {
			t.Errorf("parseWatermark(%q): %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("parseWatermark(%q) = %d, want %d", in, got, want)
		}
	}
	for _, in := range []string{"", "   ", "abc"} {
		if _, err := parseWatermark([]byte(in)); err == nil {
			t.Errorf("parseWatermark(%q) = nil error, want one", in)
		}
	}
}

func TestParseWatermarkRejectsNonFiniteAndClampsOverflow(t *testing.T) {
	// int64(NaN) is 0 on arm64, which isStale reads as "never invalidated" -- so a corrupt
	// watermark would serve a value someone invalidated. Python raises on int(nan).
	for _, in := range []string{"nan", "NaN", "inf", "-Inf", "+inf"} {
		if _, err := parseWatermark([]byte(in)); err == nil {
			t.Errorf("parseWatermark(%q) = nil error, want one", in)
		}
	}
	// A finite float past int64 clamps rather than wrapping, keeping Python's answer:
	// there the exact big integer still decides the >= comparison.
	if got, err := parseWatermark([]byte("1e300")); err != nil || got != math.MaxInt64 {
		t.Errorf("parseWatermark(1e300) = %d, %v; want %d, nil", got, err, int64(math.MaxInt64))
	}
	if got, err := parseWatermark([]byte("-1e300")); err != nil || got != math.MinInt64 {
		t.Errorf("parseWatermark(-1e300) = %d, %v; want %d, nil", got, err, int64(math.MinInt64))
	}
}

func TestEncodeEnvelopeBase64sABinaryPayload(t *testing.T) {
	// encoding/json substitutes U+FFFD for invalid UTF-8 and reports success, so a binary
	// Codec would write a value that can never be read back. Base64 is the branch Python
	// takes for a bytes payload, so the entry stays readable in both languages.
	binary := []byte{0x00, 0xff, 0xfe, 0x80}
	raw, err := encodeEnvelope(time.UnixMilli(1757308800123), time.Hour, binary)
	if err != nil {
		t.Fatalf("encodeEnvelope: %v", err)
	}
	var e envelope
	if err := json.Unmarshal(raw, &e); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if e.Encoding != "base64" {
		t.Fatalf("encoding = %q, want base64", e.Encoding)
	}
	payload, _, _, err := decodeEnvelope(raw)
	if err != nil {
		t.Fatalf("decodeEnvelope: %v", err)
	}
	if !bytes.Equal(payload, binary) {
		t.Errorf("round trip = %#v, want %#v", payload, binary)
	}
}

func TestEncodeEnvelopeKeepsUTF8Unencoded(t *testing.T) {
	// The protojson path must stay utf8 -- that is what makes the value readable straight
	// out of redis-cli, and what Python emits for a str payload.
	raw, err := encodeEnvelope(time.UnixMilli(1757308800123), time.Hour, []byte(`{"session_id":"s-1"}`))
	if err != nil {
		t.Fatalf("encodeEnvelope: %v", err)
	}
	var e envelope
	if err := json.Unmarshal(raw, &e); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if e.Encoding != "utf8" {
		t.Errorf("encoding = %q, want utf8", e.Encoding)
	}
}

func TestIsStaleIsInclusive(t *testing.T) {
	// Equality counts as stale. A value written in the same millisecond as an invalidation
	// must lose, or a write racing an invalidation survives it.
	if !isStale(100, 100) {
		t.Error("watermark == createdAt should be stale")
	}
	if !isStale(101, 100) {
		t.Error("watermark > createdAt should be stale")
	}
	if isStale(99, 100) {
		t.Error("watermark < createdAt should be fresh")
	}
}

func TestDecodeEnvelopeRejectsMissingFields(t *testing.T) {
	// Python and Python both call these bytes a miss. Decoding straight into the value
	// struct made the first one a HIT with createdAtMs=0, which skips every expiry guard --
	// one key answering differently per language is the failure the envelope exists to stop.
	for name, raw := range map[string]string{
		"no timestamps":  `{"version":1,"encoding":"utf8","payload":"{}"}`,
		"no createdAtMs": `{"version":1,"expiresAtMs":1757308800123,"encoding":"utf8","payload":"{}"}`,
		"no expiresAtMs": `{"version":1,"createdAtMs":1757308800123,"encoding":"utf8","payload":"{}"}`,
		"no payload":     `{"version":1,"createdAtMs":1,"expiresAtMs":2,"encoding":"utf8"}`,
		"no version":     `{"createdAtMs":1,"expiresAtMs":2,"encoding":"utf8","payload":"{}"}`,
		// Named for what it actually pins. This is rejected by encoding/json as out of
		// float64 range, NOT by the finite guard further down -- no JSON input reaches
		// that guard, since JSON has no NaN or Infinity literal either.
		"createdAtMs beyond float64": `{"version":1,"createdAtMs":1e999,"expiresAtMs":2,"encoding":"utf8","payload":"{}"}`,
	} {
		if _, _, _, err := decodeEnvelope([]byte(raw)); err == nil {
			t.Errorf("%s: decodeEnvelope returned nil error, want one", name)
		}
	}
}

func TestDecodeEnvelopeTakesAWholeFloatAndRejectsAFractionalOne(t *testing.T) {
	// A float that is WHOLE is still accepted -- a writer emitting 1757308800123.0 is in
	// spec and must not become a Go-only miss. Both clients now reject a fractional
	// timestamp, closing what was once the last disagreement on this field.
	_, created, expires, err := decodeEnvelope([]byte(
		`{"version":1,"createdAtMs":1757308800123.0,"expiresAtMs":1757308860123.0,"encoding":"utf8","payload":"{}"}`))
	if err != nil {
		t.Fatalf("decodeEnvelope on whole floats: %v", err)
	}
	if created != 1757308800123 || expires != 1757308860123 {
		t.Errorf("got (%d, %d), want (1757308800123, 1757308860123)", created, expires)
	}

	// Fractional is rejected, in either field: readers compare against a THRESHOLD, so
	// expiresAtMs=1000.9 at now=1000 is unexpired for a truncating reader and expired for
	// a rounding one -- a sub-millisecond difference that flips a boolean, not a value.
	for _, raw := range []string{
		`{"version":1,"createdAtMs":1757308800123.5,"expiresAtMs":1757308860123,"encoding":"utf8","payload":"{}"}`,
		`{"version":1,"createdAtMs":1757308800123,"expiresAtMs":1757308860123.9,"encoding":"utf8","payload":"{}"}`,
	} {
		if _, _, _, err := decodeEnvelope([]byte(raw)); err == nil {
			t.Errorf("decodeEnvelope accepted a fractional timestamp: %s", raw)
		}
	}
}

func TestDecodeEnvelopeRejectsATimestampOutsideInt64(t *testing.T) {
	// Such an entry would be permanent and immune to invalidation (no watermark exceeds a
	// value outside int64). A bare int64(f) out of range is arch-dependent -- MaxInt64 on
	// arm64, MinInt64 on amd64 -- so the same bytes were once a hit on a Mac, miss in prod.
	for _, body := range []string{
		`{"version":1,"createdAtMs":1e300,"expiresAtMs":1e300,"encoding":"utf8","payload":"{}"}`,
		`{"version":1,"createdAtMs":-1e300,"expiresAtMs":1,"encoding":"utf8","payload":"{}"}`,
		`{"version":1,"createdAtMs":1,"expiresAtMs":1e300,"encoding":"utf8","payload":"{}"}`,
	} {
		if _, _, _, err := decodeEnvelope([]byte(body)); err == nil {
			t.Errorf("decodeEnvelope(%s) = nil error, want one", body)
		}
	}

	// The largest plausible timestamp must still be accepted: int64 milliseconds runs to
	// roughly year 292 million, so nothing a real writer emits comes near the boundary.
	ok := `{"version":1,"createdAtMs":1757000000000,"expiresAtMs":1757003600000,"encoding":"utf8","payload":"{}"}`
	if _, created, _, err := decodeEnvelope([]byte(ok)); err != nil || created != 1_757_000_000_000 {
		t.Errorf("decodeEnvelope(plausible) = %d, %v; want 1757000000000, nil", created, err)
	}
}

func TestWatermarkClampsWhereTheEnvelopeRejects(t *testing.T) {
	// The two paths answer the same range question differently ON PURPOSE: a watermark
	// clamps to MaxInt64 (fail-closed, a suppression instruction), while an envelope
	// timestamp is rejected. LIMITATION: arm64's hardware conversion already saturates this way, so only amd64 CI proves the clamp below is actually wired in.
	ms, err := parseWatermark([]byte("1e300"))
	if err != nil {
		t.Fatalf("parseWatermark(1e300) errored, want a clamp: %v", err)
	}
	if ms != math.MaxInt64 {
		t.Errorf("parseWatermark(1e300) = %d, want MaxInt64", ms)
	}
	if neg, err := parseWatermark([]byte("-1e300")); err != nil || neg != math.MinInt64 {
		t.Errorf("parseWatermark(-1e300) = %d, %v; want MinInt64, nil", neg, err)
	}
	if _, _, _, err := decodeEnvelope(
		[]byte(`{"version":1,"createdAtMs":1e300,"expiresAtMs":1,"encoding":"utf8","payload":"{}"}`),
	); err == nil {
		t.Error("decodeEnvelope accepted 1e300, want it rejected where the watermark clamps")
	}

	// In range AND whole, both must agree exactly -- the divergence is only out-of-range.
	// Fractional is deliberately excluded here: it is a difference between the two FIELDS,
	// not the languages -- parseWatermark truncates it, the envelope now rejects it in both.
	for _, f := range []float64{0, 1, -1, 1_757_000_000_000} {
		str := strconv.FormatFloat(f, 'g', -1, 64)
		fromWatermark, err := parseWatermark([]byte(str))
		if err != nil {
			t.Fatalf("parseWatermark(%q): %v", str, err)
		}
		raw := fmt.Sprintf(`{"version":1,"createdAtMs":%s,"expiresAtMs":1,"encoding":"utf8","payload":"{}"}`, str)
		_, fromEnvelope, _, err := decodeEnvelope([]byte(raw))
		if err != nil {
			t.Fatalf("decodeEnvelope(%q): %v", str, err)
		}
		if fromWatermark != fromEnvelope {
			t.Errorf("%s: watermark reads %d, envelope reads %d", str, fromWatermark, fromEnvelope)
		}
	}
}

func TestDecodeEnvelopeNamesTheVersionItRejected(t *testing.T) {
	// The version field exists so a future writer is diagnosable, which requires the error
	// to carry the number. w.Version is a *int, so `%v` on it printed the POINTER --
	// "unsupported envelope version 0xc000014098" -- an error that passed tests but lost the number.
	_, _, _, err := decodeEnvelope([]byte(
		`{"version":2,"createdAtMs":1,"expiresAtMs":2,"encoding":"utf8","payload":"{}"}`))
	if err == nil {
		t.Fatal("decodeEnvelope accepted version 2")
	}
	if !strings.Contains(err.Error(), "version 2") {
		t.Errorf("error does not name the version: %v", err)
	}
	if strings.Contains(err.Error(), "0x") {
		t.Errorf("error printed a pointer instead of the version: %v", err)
	}

	// Absent is a separate case, and must not report itself as an unsupported version.
	_, _, _, err = decodeEnvelope([]byte(
		`{"createdAtMs":1,"expiresAtMs":2,"encoding":"utf8","payload":"{}"}`))
	if err == nil {
		t.Fatal("decodeEnvelope accepted an envelope with no version")
	}
	if !strings.Contains(err.Error(), "no version") {
		t.Errorf("absent version should say so, got: %v", err)
	}
}

func TestDecodeEnvelopeStopsAtTheSafeIntegerBoundary(t *testing.T) {
	// The band between 2^53 and int64 is the one where every client used to ACCEPT and
	// compare different numbers with no error -- measured, createdAtMs 9007199254740993
	// decodes to ...992 here vs ...993 in Python's exact int. Go/TS now share this bound; Python stays looser, which is self-healing (a miss there instead).
	const maxSafe = 1<<53 - 1 // 9007199254740991

	// The boundary itself must be accepted, or the bound is off by one.
	raw := fmt.Sprintf(
		`{"version":1,"createdAtMs":%d,"expiresAtMs":%d,"encoding":"utf8","payload":"{}"}`, maxSafe, maxSafe)
	_, created, expires, err := decodeEnvelope([]byte(raw))
	if err != nil {
		t.Fatalf("decodeEnvelope(2^53-1): %v", err)
	}
	if created != maxSafe || expires != maxSafe {
		t.Errorf("got (%d, %d), want both %d", created, expires, int64(maxSafe))
	}

	// Just past it, in either field, must be refused -- these are the values float64
	// cannot hold exactly, so accepting one means serving a number Python does not have.
	for _, v := range []string{"9007199254740993", "9007199254740995", "-9007199254740993"} {
		for _, field := range []string{"createdAtMs", "expiresAtMs"} {
			body := fmt.Sprintf(
				`{"version":1,"createdAtMs":1757000000000,"expiresAtMs":1757003600000,"encoding":"utf8","payload":"{}"}`)
			body = strings.Replace(body,
				fmt.Sprintf(`"%s":%s`, field, map[string]string{
					"createdAtMs": "1757000000000", "expiresAtMs": "1757003600000",
				}[field]),
				fmt.Sprintf(`"%s":%s`, field, v), 1)
			if _, _, _, err := decodeEnvelope([]byte(body)); err == nil {
				t.Errorf("accepted %s=%s, which float64 cannot represent exactly", field, v)
			}
		}
	}
}
