package dialcache

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The native reader validates the model/generator fingerprints before adding
// committed Quint expectations. It does not compute any expected wire result.
func generatedProtocolGroups(t *testing.T) map[string][]json.RawMessage {
	t.Helper()
	raw, err := os.ReadFile("../formal/execution.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Models []struct {
			Path         string
			VectorExport *struct {
				Generator, Artifact, Kind string
				Cases                     int
				Sources                   []string
			}
		}
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	groups := map[string][]json.RawMessage{}
	for _, model := range manifest.Models {
		if model.VectorExport == nil || model.VectorExport.Kind != "protocol" {
			continue
		}
		export := model.VectorExport
		raw, err := os.ReadFile(filepath.Join("..", export.Artifact))
		if err != nil {
			t.Fatal(err)
		}
		var envelope struct {
			SchemaVersion int
			Provenance    struct {
				Model        string
				SourceSHA256 map[string]string `json:"sourceSha256"`
			}
		}
		if err := json.Unmarshal(raw, &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.SchemaVersion != 3 || envelope.Provenance.Model != model.Path || len(envelope.Provenance.SourceSHA256) != len(export.Sources) {
			t.Fatal("invalid generated protocol provenance")
		}
		for _, source := range export.Sources {
			bytes, err := os.ReadFile(filepath.Join("..", source))
			if err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256(bytes)
			if envelope.Provenance.SourceSHA256[source] != hex.EncodeToString(digest[:]) {
				t.Fatalf("stale generated protocol source: %s", source)
			}
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			t.Fatal(err)
		}
		count := 0
		seen := map[string]bool{}
		for name, encoded := range fields {
			if name == "schemaVersion" || name == "provenance" {
				continue
			}
			var rows []json.RawMessage
			if err := json.Unmarshal(encoded, &rows); err != nil {
				t.Fatal(err)
			}
			for _, row := range rows {
				var identity struct{ Name string }
				if err := json.Unmarshal(row, &identity); err != nil {
					t.Fatal(err)
				}
				if identity.Name == "" || seen[identity.Name] {
					t.Fatal("duplicate or missing generated protocol case")
				}
				seen[identity.Name] = true
			}
			count += len(rows)
			groups[name] = append(groups[name], rows...)
		}
		if count != export.Cases {
			t.Fatal("incomplete generated protocol vector inventory")
		}
	}
	return groups
}
