package gcache

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// The Go half of the shared cross-language conformance suite.
//
// This file, tests/test_conformance.py and packages/gcache-ts/test/gcache-conformance.test.ts
// all read src/gcache/conformance/envelope_vectors.json. None of them may hardcode a case:
// one source of truth is the entire point. Parity used to be asserted by hand-mirrored
// literals in suites that ran in separate CI workflows -- and, until this package moved
// here, in separate REPOSITORIES, where nothing could even run both sides. Five
// cross-language claims went silently false in one afternoon under that arrangement.
//
// Changing a vector's expectation must fail all three suites. If only two fail, the third
// is not really reading the file.
//
// The fixture lives outside this module, so go:embed cannot reach it (embed refuses ".."
// paths). Read at test time by a path relative to this file, which is the same compromise
// the TypeScript suite makes.

type conformanceFile struct {
	EnvelopeVersion int `json:"envelopeVersion"`
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
			TypeScript      string     `json:"typescript"`
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
			TypeScript      string     `json:"typescript"`
			AgreeingClients [][]string `json:"agreeingClients"`
		} `json:"cases"`
	} `json:"argOrdering"`
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
	if len(f.Vectors) < 14 {
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
			// Presence, not just content. `Envelope` is a plain string, so a missing or
			// renamed `envelope` key in the fixture decodes to "" -- and decodeEnvelope("")
			// returns an error, which SATISFIES every reject vector. Measured: dropping the
			// field from the 12 reject vectors leaves this suite reporting ok while Python
			// fails all 12. TypeScript had the same hole. No vector legitimately carries an
			// empty envelope, so this is safe to require.
			if v.Envelope == "" {
				t.Fatal("vector has no `envelope` field; a reject vector would pass for the wrong reason")
			}
			// A vector may DELIBERATELY differ between clients, when one cannot represent
			// the value faithfully and rejecting it yields a miss-and-rewrite rather than
			// two clients serving the same bytes as different numbers. Assert our own side
			// rather than skipping: a skip would let Go silently change sides and leave the
			// recorded asymmetry a lie.
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

			// And the partition must match the recorded strings, so the file cannot claim
			// an agreement its own values contradict. Replaced a two-way `agree: bool`,
			// which could not express 2-of-3 -- the actual situation, since Go and Python
			// agree here and TypeScript does not.
			byRendering := map[string][]string{}
			for client, rendering := range map[string]string{
				"go": c.Go, "python": c.Python, "typescript": c.TypeScript,
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

// TestConformanceArgOrdering pins that ValueKey sorts args by name.
//
// The sort is not a local preference: Python's cached() has always sorted before building a
// key, so sorted args are what every key in production already looks like, and Python's and
// TypeScript's constructors were brought into line rather than this one being loosened.
// Removing this sort was tried and reverted -- it broke parity with every key cached() had
// written, which TestValueKeyMatchesProductionKeys caught immediately.
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
// discriminating power. An already-alphabetical case renders the same whether a client sorts
// or preserves input order, so a corpus of only those cannot detect a client that stops
// sorting -- exactly how the Go/Python split survived. At least one case must differ from
// its own input-order rendering.
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
