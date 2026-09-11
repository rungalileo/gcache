package dialcache

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Fast native runs verify the exact checked-in predictions and their source
// identity. Formal CI separately recomputes them with the pinned Quint tool.
func TestGeneratedFixtureFreshness(t *testing.T) {
	var lock struct {
		SchemaVersion int               `json:"schemaVersion"`
		QuintVersion  string            `json:"quintVersion"`
		Inputs        map[string]string `json:"inputs"`
		Artifacts     map[string]string `json:"artifacts"`
	}
	raw, err := os.ReadFile("../formal/generated-fixtures.lock.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &lock); err != nil {
		t.Fatal(err)
	}
	if lock.SchemaVersion != 1 || lock.QuintVersion != "0.32.0" || len(lock.Inputs) == 0 || len(lock.Artifacts) == 0 {
		t.Fatal("invalid generated fixture lock")
	}
	var recipes struct {
		Artifacts []struct {
			Path string `json:"path"`
		} `json:"artifacts"`
	}
	raw, err = os.ReadFile("../formal/fixture-recipes.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &recipes); err != nil {
		t.Fatal(err)
	}
	if len(recipes.Artifacts) != len(lock.Artifacts) {
		t.Fatal("incomplete generated fixture lock")
	}
	seen := map[string]bool{}
	for _, artifact := range recipes.Artifacts {
		if seen[artifact.Path] || lock.Artifacts[artifact.Path] == "" {
			t.Fatal("missing/duplicate fixture identity")
		}
		seen[artifact.Path] = true
	}
	for _, group := range []map[string]string{lock.Inputs, lock.Artifacts} {
		for path, expected := range group {
			if filepath.IsAbs(path) || strings.Contains(path, "..") {
				t.Fatal("invalid fixture source path")
			}
			actual, err := witnessHash(filepath.Join("..", path))
			if err != nil {
				t.Fatal(err)
			}
			if actual != expected {
				t.Fatalf("%s changed; regenerate Quint fixtures and review", path)
			}
		}
	}
}
