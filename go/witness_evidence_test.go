package dialcache

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

// Required reachability witnesses have one evaluator shared by the language
// drivers. Reusing its result requires the exact corpus and definition hashes;
// it does not replace any Go public execution or observation assertion.
type witnessDigest struct {
	Path   string `json:"path"`
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
}
type witnessEvidence struct {
	SchemaVersion int             `json:"schemaVersion"`
	Profile       string          `json:"profile"`
	Traces        int             `json:"traces"`
	Required      []string        `json:"required"`
	Seen          []string        `json:"seen"`
	Inputs        []witnessDigest `json:"inputs"`
	Corpus        []witnessDigest `json:"corpus"`
}

func witnessHash(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}
func checkWitnessEvidence(profile, directory string, paths []string) error {
	raw, err := os.ReadFile(filepath.Join(directory, profile+".json"))
	if err != nil {
		return err
	}
	if err = validateJSON(raw); err != nil {
		return err
	}
	var evidence witnessEvidence
	if err = json.Unmarshal(raw, &evidence); err != nil {
		return err
	}
	if evidence.SchemaVersion != 1 || evidence.Profile != profile || evidence.Traces != len(paths) || len(evidence.Corpus) != len(paths) {
		return fmt.Errorf("unsupported/incomplete %s witness evidence", profile)
	}
	registryRaw, err := os.ReadFile("../formal/coverage-witnesses.json")
	if err != nil {
		return err
	}
	var registry map[string][]string
	if err = json.Unmarshal(registryRaw, &registry); err != nil {
		return err
	}
	required := registry[profile]
	if len(required) == 0 || !reflect.DeepEqual(required, evidence.Required) {
		return fmt.Errorf("%s required witness registry differs", profile)
	}
	seen := map[string]bool{}
	for _, name := range evidence.Seen {
		if seen[name] {
			return fmt.Errorf("duplicate witness %s", name)
		}
		seen[name] = true
	}
	for _, name := range required {
		if !seen[name] {
			return fmt.Errorf("%s missing witness %s", profile, name)
		}
	}
	expectedInputs := []string{"formal/profiles.json", "formal/coverage-witnesses.json", "formal/execution.json", "formal/dialcache-" + profile + "-conformance.qnt", "formal/conformance-observations.qnt", "test/formal-features.test.ts", "test/formal/coverage-evidence.ts"}
	if profile == "effects" {
		expectedInputs[5] = "test/formal-effects.test.ts"
	} else {
		expectedInputs = append(expectedInputs, "test/formal/runtime-witnesses.ts", "test/formal/recovery-shadow-witnesses.ts")
	}
	var execution struct {
		Libraries []string `json:"libraries"`
	}
	executionRaw, err := os.ReadFile("../formal/execution.json")
	if err != nil {
		return err
	}
	if err := json.Unmarshal(executionRaw, &execution); err != nil {
		return err
	}
	var definitions struct {
		Profiles []struct {
			ID      string   `json:"id"`
			Sources []string `json:"witnessSources"`
		} `json:"profiles"`
	}
	definitionsRaw, err := os.ReadFile("../formal/profiles.json")
	if err != nil {
		return err
	}
	if err := json.Unmarshal(definitionsRaw, &definitions); err != nil {
		return err
	}
	additional := append([]string{}, execution.Libraries...)
	for _, definition := range definitions.Profiles {
		if definition.ID == profile {
			additional = append(additional, definition.Sources...)
		}
	}
	for _, path := range additional {
		found := false
		for _, prior := range expectedInputs {
			if prior == path {
				found = true
				break
			}
		}
		if !found {
			expectedInputs = append(expectedInputs, path)
		}
	}
	if len(evidence.Inputs) != len(expectedInputs) {
		return fmt.Errorf("incomplete witness definition fingerprints")
	}
	for index, path := range expectedInputs {
		item := evidence.Inputs[index]
		if item.Path != path {
			return fmt.Errorf("unexpected witness input %s", item.Path)
		}
		hash, err := witnessHash(filepath.Join("..", filepath.FromSlash(path)))
		if err != nil {
			return err
		}
		if hash != item.SHA256 {
			return fmt.Errorf("stale witness definition %s", path)
		}
	}
	actual := map[string]string{}
	for _, path := range paths {
		name := filepath.Base(path)
		if _, duplicate := actual[name]; duplicate {
			return fmt.Errorf("duplicate trace name %s", name)
		}
		hash, err := witnessHash(path)
		if err != nil {
			return err
		}
		actual[name] = hash
	}
	for _, item := range evidence.Corpus {
		hash, ok := actual[item.Name]
		if !ok || hash != item.SHA256 {
			return fmt.Errorf("%s witness corpus differs at %s", profile, item.Name)
		}
		delete(actual, item.Name)
	}
	if len(actual) != 0 {
		return fmt.Errorf("unaccounted replay traces")
	}
	return nil
}
func TestGeneratedWitnessEvidence(t *testing.T) {
	directory := os.Getenv("DIALCACHE_WITNESS_EVIDENCE_DIR")
	profiles := map[string][]string{}
	if dir := os.Getenv("DIALCACHE_EFFECTS_TRACE_DIR"); dir != "" && os.Getenv("DIALCACHE_EFFECTS_TRACE_FILE") == "" {
		paths, err := effectsPaths()
		if err != nil {
			t.Fatal(err)
		}
		profiles["effects"] = paths
	}
	if os.Getenv("DIALCACHE_FEATURE_TRACE_DIR") != "" && os.Getenv("DIALCACHE_FEATURE_TRACE_FILE") == "" {
		clockPaths, err := featurePaths("local-clock")
		if err != nil {
			t.Fatal(err)
		}
		profiles["local-clock"] = clockPaths
		for name := range behaviorProfiles() {
			paths, err := featurePaths(name)
			if err != nil {
				t.Fatal(err)
			}
			profiles[name] = paths
		}
	}
	if len(profiles) == 0 {
		return
	}
	if directory == "" {
		t.Fatal("full generated replay requires DIALCACHE_WITNESS_EVIDENCE_DIR with matching evaluated witness evidence")
	}
	names := []string{}
	for name := range profiles {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			if err := checkWitnessEvidence(name, directory, profiles[name]); err != nil {
				t.Fatal(err)
			}
		})
	}
}
