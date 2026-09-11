package dialcache

import (
	"fmt"
	"os"
	"testing"
)

var behaviorProfileVersions = map[string]int64{"recovery-read": 1, "local-failure": 1, "runtime-boundaries": 1, "shadow-layers": 1, "local-clock": 1, "source-budgets": 1, "effects": 2, "scope": 2, "policy": 3, "layers": 2, "recovery": 1, "independent": 2, "shadow": 3, "admission": 1}

func validateBehaviorProfileRegistry(raw []byte, name string, version int64) error {
	decoded, err := behaviorJSON(raw)
	if err != nil {
		return err
	}
	registry := bm(decoded)
	if bf(registry["schemaVersion"]) != 1 || registry["specificationVersion"] != "0.1.0" || bf(registry["behavioralSchemaVersion"]) != 2 || bf(registry["protocolSchemaVersion"]) != 3 {
		return fmt.Errorf("unsupported specification/behavioral registry")
	}
	count := 0
	for _, raw := range ba(registry["profiles"]) {
		profile := bm(raw)
		if profile["id"] != name {
			continue
		}
		count++
		if bf(profile["version"]) != float64(version) || profile["model"] != "formal/dialcache-"+name+"-conformance.qnt" || profile["smoke"] != "formal/"+name+"-smoke.itf.json" {
			return fmt.Errorf("unsupported %s profile definition/version", name)
		}
	}
	if count != 1 {
		return fmt.Errorf("registry needs exactly one %s profile", name)
	}
	return nil
}
func requireBehaviorProfile(t *testing.T, name string) {
	t.Helper()
	raw, err := os.ReadFile("../formal/profiles.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := validateBehaviorProfileRegistry(raw, name, behaviorProfileVersions[name]); err != nil {
		t.Fatal(err)
	}
}
func TestBehaviorProfileRegistryRejectsDrift(t *testing.T) {
	raw, err := os.ReadFile("../formal/profiles.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"version", "missing", "duplicate", "model", "schema"} {
		t.Run(mode, func(t *testing.T) {
			decoded, _ := behaviorJSON(raw)
			registry := bm(decoded)
			profiles := ba(registry["profiles"])
			for i, rawProfile := range profiles {
				profile := bm(rawProfile)
				if profile["id"] != "scope" {
					continue
				}
				switch mode {
				case "version":
					profile["version"] = 999
				case "missing":
					registry["profiles"] = append(profiles[:i], profiles[i+1:]...)
				case "duplicate":
					registry["profiles"] = append(profiles, profile)
				case "model":
					profile["model"] = "formal/unknown.qnt"
				case "schema":
					registry["behavioralSchemaVersion"] = 999
				}
				break
			}
			if err := validateBehaviorProfileRegistry([]byte(bjson(registry)), "scope", 2); err == nil {
				t.Fatal("unsupported profile registry accepted")
			}
		})
	}
}
