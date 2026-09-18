package gcache

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

// The Go half of the shared cross-language conformance suite: this file, test_conformance.py,
// and gcache-conformance.test.ts all read envelope_vectors.json, so none may hardcode a case --
// hand-mirrored literals once let five cross-language claims go silently false in an afternoon. Read by relative path since go:embed refuses the ".." needed to reach the fixture.

type conformanceFile struct {
	EnvelopeVersion int `json:"envelopeVersion"`
	VectorCount     int `json:"vectorCount"`
	Vectors         []struct {
		Name     string `json:"name"`
		Why      string `json:"why"`
		Envelope string `json:"envelope"`
		Expect   string `json:"expect"`
		Decoded  *struct {
			CreatedAtMs   int64  `json:"createdAtMs"`
			ExpiresAtMs   int64  `json:"expiresAtMs"`
			Payload       string `json:"payload"`
			PayloadBase64 string `json:"payloadBase64"`
		} `json:"decoded"`
		RejectedBy      []string `json:"rejectedBy"`
		AcceptedBy      []string `json:"acceptedBy"`
		AsymmetryIsSafe string   `json:"asymmetryIsSafe"`
	} `json:"vectors"`
	KeyRendering struct {
		Cases []struct {
			Name            string     `json:"name"`
			URNPrefix       string     `json:"urnPrefix"`
			KeyType         string     `json:"keyType"`
			ID              string     `json:"id"`
			Go              string     `json:"go"`
			Python          string     `json:"python"`
			AgreeingClients [][]string `json:"agreeingClients"`
			Reason          string     `json:"reason"`
		} `json:"cases"`
	} `json:"keyRendering"`
	ArgOrdering struct {
		Cases []struct {
			Name            string     `json:"name"`
			URNPrefix       string     `json:"urnPrefix"`
			KeyType         string     `json:"keyType"`
			ID              string     `json:"id"`
			UseCase         string     `json:"useCase"`
			Args            [][]string `json:"args"`
			Why             string     `json:"why"`
			Go              string     `json:"go"`
			Python          string     `json:"python"`
			AgreeingClients [][]string `json:"agreeingClients"`
		} `json:"cases"`
	} `json:"argOrdering"`
	HashedComponents struct {
		Algorithm string `json:"algorithm"`
		Encoding  string `json:"encoding"`
		Cases     []struct {
			Input  string `json:"input"`
			Digest string `json:"digest"`
			Why    string `json:"_why"`
		} `json:"cases"`
	} `json:"hashedComponents"`
	ProtoEnvelope struct {
		FirstByteRange struct {
			Min int `json:"min"`
			Max int `json:"max"`
		} `json:"firstByteRange"`
		OtherFramings struct {
			JSON   int `json:"json"`
			Pickle int `json:"pickle"`
		} `json:"otherFramings"`
		Canonical struct {
			CreatedAtMs    int64  `json:"createdAtMs"`
			ExpiresAtMs    int64  `json:"expiresAtMs"`
			PayloadBase64  string `json:"payloadBase64"`
			EnvelopeBase64 string `json:"envelopeBase64"`
			EnvelopeLength int    `json:"envelopeLength"`
		} `json:"canonical"`
		Rejects []struct {
			Name           string `json:"name"`
			EnvelopeBase64 string `json:"envelopeBase64"`
			Why            string `json:"why"`
		} `json:"rejects"`
	} `json:"protoEnvelope"`
}

func loadConformance(t *testing.T) conformanceFile {
	t.Helper()
	path := filepath.Join("..", "src", "gcache", "conformance", "envelope_vectors.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		// Fail loudly rather than skip. A skipped conformance suite is indistinguishable
		// from a passing one on a dashboard, which is the failure mode this file exists to
		// remove.
		t.Fatalf("shared conformance vectors unreadable at %s: %v", path, err)
	}
	var f conformanceFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("shared conformance vectors are not valid JSON: %v", err)
	}
	// EXACT, not a floor: a floor of 14 with 16 vectors present let two disappear silently.
	if f.VectorCount == 0 {
		t.Fatal("fixture declares no vectorCount -- the field was renamed or dropped")
	}
	if len(f.Vectors) != f.VectorCount {
		t.Fatalf("expected the full vector set, got %d -- a truncated file would make this "+
			"suite vacuously green", len(f.Vectors))
	}
	if f.EnvelopeVersion != envelopeVersion {
		t.Fatalf("fixture envelopeVersion = %d, this client = %d; every version-sensitive "+
			"vector would silently test the wrong thing", f.EnvelopeVersion, envelopeVersion)
	}
	return f
}

func TestConformanceVectors(t *testing.T) {
	f := loadConformance(t)
	for _, v := range f.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			if v.Why == "" {
				t.Fatal("every vector must record why it exists")
			}
			// Presence, not just content: a missing/renamed `envelope` key decodes to "",
			// and decodeEnvelope("") errors, which SATISFIES every reject vector for the
			// wrong reason. Measured: dropping the field from the 12 reject vectors left this suite green while Python failed all 12.
			if v.Envelope == "" {
				t.Fatal("vector has no `envelope` field; a reject vector would pass for the wrong reason")
			}
			// A vector may DELIBERATELY differ between clients, when one can't represent
			// the value faithfully. Assert our own side rather than skipping: a skip would
			// let Go silently change sides and leave the recorded asymmetry a lie.
			expectReject := v.Expect == "reject"
			if len(v.RejectedBy) > 0 {
				if v.AsymmetryIsSafe == "" {
					t.Fatal("an asymmetry must justify its direction")
				}
				expectReject = contains(v.RejectedBy, "go")
				if !expectReject && !contains(v.AcceptedBy, "go") {
					t.Fatalf("vector names neither go in rejectedBy %v nor acceptedBy %v",
						v.RejectedBy, v.AcceptedBy)
				}
			}

			payload, createdAtMs, expiresAtMs, err := decodeEnvelope([]byte(v.Envelope))
			if expectReject {
				if err == nil {
					t.Fatalf("expected a reject, got payload=%q created=%d expires=%d",
						payload, createdAtMs, expiresAtMs)
				}
				return
			}
			if err != nil {
				t.Fatalf("expected accept, got error: %v", err)
			}
			if v.Decoded == nil {
				t.Fatal("an accept case must declare what it decodes to")
			}
			if createdAtMs != v.Decoded.CreatedAtMs {
				t.Errorf("createdAtMs = %d, want %d", createdAtMs, v.Decoded.CreatedAtMs)
			}
			if expiresAtMs != v.Decoded.ExpiresAtMs {
				t.Errorf("expiresAtMs = %d, want %d", expiresAtMs, v.Decoded.ExpiresAtMs)
			}
			want := v.Decoded.Payload
			if v.Decoded.PayloadBase64 != "" {
				// base64 vectors record the encoded form; the decoder hands back raw bytes.
				decoded, decErr := base64.StdEncoding.DecodeString(v.Decoded.PayloadBase64)
				if decErr != nil {
					t.Fatalf("vector's payloadBase64 is not decodable: %v", decErr)
				}
				want = string(decoded)
			}
			if string(payload) != want {
				t.Errorf("payload = %q, want %q", payload, want)
			}
		})
	}
}

func TestConformanceKeyRendering(t *testing.T) {
	f := loadConformance(t)
	for _, c := range f.KeyRendering.Cases {
		t.Run(c.Name, func(t *testing.T) {
			// What this client ACTUALLY renders, against what the file records for it.
			got := prefix(c.URNPrefix, Key{KeyType: c.KeyType, ID: c.ID})
			if got != c.Go {
				t.Errorf("Go renders %q, file says %q", got, c.Go)
			}

			// The partition must match the recorded strings, so the file can't claim an
			// agreement its own values contradict. Replaced a two-way `agree: bool`, which
			// a partition survives a client being added or removed; a boolean would not.
			byRendering := map[string][]string{}
			for client, rendering := range map[string]string{
				"go": c.Go, "python": c.Python,
			} {
				byRendering[rendering] = append(byRendering[rendering], client)
			}
			var expected [][]string
			for _, group := range byRendering {
				sort.Strings(group)
				expected = append(expected, group)
			}
			sort.Slice(expected, func(i, j int) bool { return expected[i][0] < expected[j][0] })
			if !equalGroups(c.AgreeingClients, expected) {
				t.Errorf("agreeingClients = %v contradicts the recorded renderings, which group as %v",
					c.AgreeingClients, expected)
			}
			if len(c.AgreeingClients) > 1 && c.Reason == "" {
				t.Error("a divergence must be explained")
			}
		})
	}
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}

func equalGroups(a, b [][]string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if len(a[i]) != len(b[i]) {
			return false
		}
		for j := range a[i] {
			if a[i][j] != b[i][j] {
				return false
			}
		}
	}
	return true
}

// TestConformanceArgOrdering pins that ValueKey sorts args by name. Not a local preference:
// Python's cached() has always sorted before building a key, so sorted args are what every
// key in production already looks like; removing this sort broke parity with production keys.
func TestConformanceArgOrdering(t *testing.T) {
	f := loadConformance(t)
	if len(f.ArgOrdering.Cases) == 0 {
		t.Fatal("no argOrdering cases -- the fixture moved or the section was dropped")
	}
	for _, c := range f.ArgOrdering.Cases {
		t.Run(c.Name, func(t *testing.T) {
			if c.Why == "" {
				t.Error("every case must say what it is for")
			}
			args := make([]Arg, 0, len(c.Args))
			for _, pair := range c.Args {
				if len(pair) != 2 {
					t.Fatalf("malformed arg pair %v", pair)
				}
				args = append(args, Arg{Name: pair[0], Value: pair[1]})
			}
			key := Key{KeyType: c.KeyType, ID: c.ID, UseCase: c.UseCase, Args: args}
			if got := ValueKey(c.URNPrefix, key); got != c.Go {
				t.Errorf("Go renders %q, file says %q", got, c.Go)
			}
		})
	}
}

// TestConformanceArgOrderingCorpusCouldDetectAnUnsortedClient asserts the corpus's own
// discriminating power: an already-alphabetical case renders the same sorted or not, so a
// corpus of only those can't detect a client that stopped sorting -- as one once did.
func TestConformanceArgOrderingCorpusCouldDetectAnUnsortedClient(t *testing.T) {
	f := loadConformance(t)
	for _, c := range f.ArgOrdering.Cases {
		var b strings.Builder
		b.WriteString(c.URNPrefix + ":" + c.KeyType + ":" + c.ID)
		for i, pair := range c.Args {
			if i == 0 {
				b.WriteByte('?')
			} else {
				b.WriteByte('&')
			}
			b.WriteString(pair[0] + "=" + pair[1])
		}
		b.WriteString("#" + c.UseCase)
		if b.String() != c.Go {
			return // this case distinguishes sorted from input order; the corpus has teeth
		}
	}
	t.Fatal("every argOrdering case renders the same sorted or unsorted, so this suite cannot " +
		"detect a client that stopped sorting -- add a case whose args are not alphabetical")
}

// TestHashedComponentsMatchTheSharedDigests pins HashComponent against Python's
// hash_component. A digest the two disagree on makes a hashed component unfindable by the
// other language -- a cache that writes fine and never hits, with no error on either side.
func TestConformanceHashedComponentsMatchTheSharedDigests(t *testing.T) {
	data := loadConformance(t)
	if data.HashedComponents.Algorithm != "sha256" || data.HashedComponents.Encoding != "hex-lower" {
		t.Fatalf("unexpected hashing contract: %s/%s",
			data.HashedComponents.Algorithm, data.HashedComponents.Encoding)
	}
	if len(data.HashedComponents.Cases) == 0 {
		t.Fatal("the hashed-component cases are gone")
	}
	for _, c := range data.HashedComponents.Cases {
		got := HashComponent(c.Input)
		if got != c.Digest {
			t.Errorf("HashComponent(%q) = %s, fixture says %s (%s)", c.Input, got, c.Digest, c.Why)
		}
		if got != strings.ToLower(got) || len(got) != 64 {
			t.Errorf("HashComponent(%q) = %q; want 64 chars of lowercase hex", c.Input, got)
		}
	}
}

// TestProtoEnvelopeMatchesTheSharedBytes pins the PROTO framing against Python. Both sides
// hand-write it, so nothing but these bytes stops them drifting -- and a drift is silent: one
// client writes an entry the other cannot read, with no error on the write side.
func TestConformanceProtoEnvelopeMatchesTheSharedBytes(t *testing.T) {
	data := loadConformance(t)
	c := data.ProtoEnvelope.Canonical

	payload, err := base64.StdEncoding.DecodeString(c.PayloadBase64)
	if err != nil {
		t.Fatalf("fixture payload: %v", err)
	}
	want, err := base64.StdEncoding.DecodeString(c.EnvelopeBase64)
	if err != nil {
		t.Fatalf("fixture envelope: %v", err)
	}

	got, err := encodeProtoEnvelope(
		time.UnixMilli(c.CreatedAtMs), time.Duration(c.ExpiresAtMs-c.CreatedAtMs)*time.Millisecond, payload)
	if err != nil {
		t.Fatalf("encodeProtoEnvelope: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("encodeProtoEnvelope = %x, fixture says %x", got, want)
	}
	if len(got) != c.EnvelopeLength {
		t.Fatalf("envelope is %d bytes, fixture says %d", len(got), c.EnvelopeLength)
	}

	gotPayload, createdAtMs, expiresAtMs, err := decodeEnvelope(want)
	if err != nil {
		t.Fatalf("decodeEnvelope: %v", err)
	}
	if !bytes.Equal(gotPayload, payload) || createdAtMs != c.CreatedAtMs || expiresAtMs != c.ExpiresAtMs {
		t.Fatalf("decode gave payload=%x created=%d expires=%d", gotPayload, createdAtMs, expiresAtMs)
	}
}

// TestProtoFirstByteRangeIsDisjointFromTheOtherFramings is why the framing needs no magic
// prefix. Asserted over the RANGE, not one example: the guarantee is about every field the
// schema may ever use, and it only holds while field numbers stay <= 14.
func TestConformanceProtoFirstByteRangeIsDisjointFromTheOtherFramings(t *testing.T) {
	data := loadConformance(t)
	lo, hi := data.ProtoEnvelope.FirstByteRange.Min, data.ProtoEnvelope.FirstByteRange.Max
	if lo != protoFirstByteMin || hi != protoFirstByteMax {
		t.Fatalf("this client uses 0x%02x..0x%02x, fixture says 0x%02x..0x%02x",
			protoFirstByteMin, protoFirstByteMax, lo, hi)
	}
	if j := data.ProtoEnvelope.OtherFramings.JSON; j >= lo && j <= hi {
		t.Errorf("JSON's 0x%02x falls inside the PROTO range", j)
	}
	if pk := data.ProtoEnvelope.OtherFramings.Pickle; pk >= lo && pk <= hi {
		t.Errorf("pickle's 0x%02x falls inside the PROTO range", pk)
	}
	for field := 1; field <= 14; field++ {
		for _, wire := range []int{0, 1, 2, 5} {
			if tag := (field << 3) | wire; tag < lo || tag > hi {
				t.Errorf("field %d wire %d gives 0x%02x, outside the range", field, wire, tag)
			}
		}
	}
	if tag := (16 << 3) | 0; tag != data.ProtoEnvelope.OtherFramings.Pickle {
		t.Errorf("field 16 varint = 0x%02x; the field cap exists because it is pickle's 0x%02x",
			tag, data.ProtoEnvelope.OtherFramings.Pickle)
	}
}

// TestProtoEnvelopeRejectsWhatPythonRejects -- each is a value no gcache client writes.
// Accepting one means answering a hit with data the other client would refuse.
func TestConformanceProtoEnvelopeRejectsWhatPythonRejects(t *testing.T) {
	data := loadConformance(t)
	if len(data.ProtoEnvelope.Rejects) == 0 {
		t.Fatal("the PROTO reject cases are gone")
	}
	for _, c := range data.ProtoEnvelope.Rejects {
		t.Run(c.Name, func(t *testing.T) {
			raw, err := base64.StdEncoding.DecodeString(c.EnvelopeBase64)
			if err != nil {
				t.Fatalf("fixture: %v", err)
			}
			if _, _, _, err := decodeEnvelope(raw); err == nil {
				t.Fatalf("accepted %x, which should be rejected: %s", raw, c.Why)
			}
		})
	}
}

// TestConformanceEveryTestInThisFileCarriesThePrefix keeps the name-based gate honest.
//
// `inv test-conformance` and .github/workflows/conformance.yaml both select Go tests with
// `-run TestConformance`, so a function in this file without that prefix is silently not run
// by the job that is described as the only check that the two clients agree. Four were:
// the hashed-component digests and all three PROTO envelope tests. The job passed while
// skipping them, which is worse than not having it.
//
// A name convention that nothing enforces is a comment. This reads the file and fails if any
// test function drifts back out of the filter.
func TestConformanceEveryTestInThisFileCarriesThePrefix(t *testing.T) {
	src, err := os.ReadFile("conformance_test.go")
	if err != nil {
		t.Fatalf("cannot read own source: %v", err)
	}
	re := regexp.MustCompile(`(?m)^func (Test\w+)\(`)
	var stray []string
	for _, m := range re.FindAllStringSubmatch(string(src), -1) {
		if !strings.HasPrefix(m[1], "TestConformance") {
			stray = append(stray, m[1])
		}
	}
	if len(stray) > 0 {
		t.Fatalf("these tests are skipped by `-run TestConformance`, so the conformance job "+
			"does not run them: %v -- rename them with the TestConformance prefix", stray)
	}
}

// TestConformanceWatermarkTimingMatchesTheCorpus is the Go half of the pin.
//
// watermarkTTL, maxEntryTTL and maxFutureBuffer are declared by hand here and again in
// Python's constants.py, and nothing compared them. The whole safety argument for the
// resurrection invariant rests on the two agreeing: Python writing a 6h watermark while Go
// assumes 5h breaks it in both directions, and every other test in both suites is written
// RELATIVE to the constants, so all of them hold for any pair of numbers.
func TestConformanceWatermarkTimingMatchesTheCorpus(t *testing.T) {
	var corpus struct {
		WatermarkTiming struct {
			WatermarkTTLSeconds    int `json:"watermarkTtlSeconds"`
			MaxTrackedTTLSeconds   int `json:"maxTrackedTtlSeconds"`
			MaxFutureBufferSeconds int `json:"maxFutureBufferSeconds"`
		} `json:"watermarkTiming"`
	}
	path := filepath.Join("..", "src", "gcache", "conformance", "envelope_vectors.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("shared conformance vectors unreadable at %s: %v", path, err)
	}
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatalf("shared conformance vectors are not valid JSON: %v", err)
	}
	w := corpus.WatermarkTiming
	if got := int(watermarkTTL.Seconds()); got != w.WatermarkTTLSeconds {
		t.Errorf("watermarkTTL = %ds, corpus says %ds", got, w.WatermarkTTLSeconds)
	}
	if got := int(maxEntryTTL.Seconds()); got != w.MaxTrackedTTLSeconds {
		t.Errorf("maxEntryTTL = %ds, corpus says %ds", got, w.MaxTrackedTTLSeconds)
	}
	if got := int(maxFutureBuffer.Seconds()); got != w.MaxFutureBufferSeconds {
		t.Errorf("maxFutureBuffer = %ds, corpus says %ds", got, w.MaxFutureBufferSeconds)
	}
	if w.MaxTrackedTTLSeconds+w.MaxFutureBufferSeconds > w.WatermarkTTLSeconds {
		t.Errorf("the corpus itself breaks the invariant: %d + %d > %d",
			w.MaxTrackedTTLSeconds, w.MaxFutureBufferSeconds, w.WatermarkTTLSeconds)
	}
}
