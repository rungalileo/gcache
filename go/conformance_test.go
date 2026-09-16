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
func TestHashedComponentsMatchTheSharedDigests(t *testing.T) {
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
