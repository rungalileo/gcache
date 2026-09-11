package dialcache

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
)

func validateRegistry(raw []byte) error {
	if err := validateJSON(raw); err != nil {
		return err
	}
	var registry struct {
		SchemaVersion         int
		SpecificationVersion  string
		ProtocolSchemaVersion int
		Profiles              []struct {
			ID      string
			Version int
		}
	}
	if err := json.Unmarshal(raw, &registry); err != nil {
		return err
	}
	if registry.SchemaVersion != 1 || registry.SpecificationVersion != "0.1.0" || registry.ProtocolSchemaVersion != 3 {
		return errors.New("unsupported specification/profile/protocol registry version")
	}
	core := 0
	for _, profile := range registry.Profiles {
		if profile.ID == "core" {
			core++
			if profile.Version != 1 {
				return errors.New("unsupported core profile version")
			}
		}
	}
	if core != 1 {
		return errors.New("registry requires exactly one core profile")
	}
	return nil
}
func requireRegistry(t *testing.T) {
	t.Helper()
	raw, err := os.ReadFile("../formal/profiles.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := validateRegistry(raw); err != nil {
		t.Fatal(err)
	}
}
func TestProfileRegistryCompatibility(t *testing.T) {
	requireRegistry(t)
	base := map[string]any{"schemaVersion": 1, "specificationVersion": "0.1.0", "protocolSchemaVersion": 3, "profiles": []any{map[string]any{"id": "core", "version": 1}}}
	for _, field := range []string{"schemaVersion", "specificationVersion", "protocolSchemaVersion", "profiles"} {
		t.Run(field, func(t *testing.T) {
			broken := map[string]any{}
			for key, value := range base {
				broken[key] = value
			}
			if field == "specificationVersion" {
				broken[field] = "999.0.0"
			} else if field == "profiles" {
				broken[field] = []any{map[string]any{"id": "core", "version": 999}}
			} else {
				broken[field] = 999
			}
			raw, _ := json.Marshal(broken)
			if err := validateRegistry(raw); err == nil {
				t.Fatal("unsupported registry accepted")
			}
		})
	}
	for _, profiles := range []any{[]any{}, []any{map[string]any{"id": "effects", "version": 1}}, []any{map[string]any{"id": "core", "version": 1}, map[string]any{"id": "core", "version": 1}}} {
		base["profiles"] = profiles
		raw, _ := json.Marshal(base)
		if err := validateRegistry(raw); err == nil {
			t.Fatal("missing/duplicate core profile accepted")
		}
	}
}
