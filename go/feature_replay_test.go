package dialcache

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"testing/synctest"
)

func featurePaths(p string) ([]string, error) {
	if file := os.Getenv("DIALCACHE_FEATURE_TRACE_FILE"); file != "" {
		if filepath.Base(filepath.Dir(file)) == p || strings.Contains(filepath.Base(file), p+"-smoke") {
			return []string{file}, nil
		}
		return nil, nil
	}
	if dir := os.Getenv("DIALCACHE_FEATURE_TRACE_DIR"); dir != "" {
		paths, err := filepath.Glob(filepath.Join(dir, p, "*.itf.json"))
		if err != nil {
			return nil, err
		}
		if len(paths) == 0 {
			return nil, fmt.Errorf("empty feature corpus %s", p)
		}
		regressions, err := featureRegressionPaths(p, dir)
		if err != nil {
			return nil, err
		}
		paths = append(paths, regressions...)
		return paths, nil
	}
	return []string{filepath.Join("..", "formal", p+"-smoke.itf.json")}, nil
}

func featureRegressionPaths(profile, directory string) ([]string, error) {
	raw, err := os.ReadFile("../formal/execution.json")
	if err != nil {
		return nil, err
	}
	var manifest struct {
		Models []struct {
			Profile     string   `json:"profile"`
			Regressions []string `json:"replayRegressions"`
		} `json:"models"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, err
	}
	paths := []string{}
	for _, model := range manifest.Models {
		if model.Profile != profile {
			continue
		}
		for _, name := range model.Regressions {
			path := filepath.Join(directory, "..", "regressions", profile, name+".itf.json")
			if _, err := os.Stat(path); err != nil {
				return nil, fmt.Errorf("missing Quint regression %s: %w", name, err)
			}
			paths = append(paths, path)
		}
	}
	return paths, nil
}
func TestFeatureConformance(t *testing.T) {
	requireRegistry(t)
	coordinator := newReplayCoordinator(t)
	info, err := coordinator.call(obj{"op": "profiles"})
	if err != nil {
		t.Fatal(err)
	}
	profiles := bm(info["profiles"])
	selected := os.Getenv("DIALCACHE_FEATURE_PROFILE")
	if selected != "" {
		if _, ok := profiles[selected]; !ok {
			t.Fatalf("unknown selected feature profile: %s", selected)
		}
	}
	count := 0
	executedProfiles := map[string]bool{}
	names := []string{}
	for name := range profiles {
		if name != "core" && name != "effects" && name != "local-clock" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	for _, name := range names {
		if selected != "" && selected != name {
			continue
		}
		paths, err := featurePaths(name)
		if err != nil {
			t.Fatal(err)
		}
		if len(paths) > 0 {
			requireBehaviorProfile(t, name)
		}
		actions := map[string]bool{}
		for _, path := range paths {
			prepared, err := coordinator.prepare(name, path, nil)
			if err != nil {
				t.Fatal(err)
			}
			for _, action := range ba(prepared["actions"]) {
				actions[bs(action)] = true
			}
			t.Run(name+"/"+filepath.Base(path), func(t *testing.T) {
				count++
				executedProfiles[name] = true
				synctest.Test(t, func(t *testing.T) {
					d := newBehaviorDriver(t, bm(prepared["fixture"]))
					defer d.close()
					if err := coordinator.replay(d, prepared); err != nil {
						t.Error(err)
					}
				})
			})
		}
		if os.Getenv("DIALCACHE_FEATURE_TRACE_DIR") != "" && os.Getenv("DIALCACHE_FEATURE_TRACE_FILE") == "" {
			for _, action := range ba(profiles[name]) {
				if !actions[bs(action)] {
					t.Errorf("%s corpus omits action %s", name, action)
				}
			}
		}
	}
	if count == 0 {
		t.Fatal("no feature traces selected")
	}
	t.Logf("specification=0.1.0 featureProfiles=%d replayed=%d", len(executedProfiles), count)
}

func TestFeatureParserRejectsMissingAndUnsafeInputs(t *testing.T) {
	coordinator := newReplayCoordinator(t)
	raw, err := os.ReadFile("../formal/scope-smoke.itf.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []string{"choice", "observation", "diagnostics", "unsafe"} {
		t.Run(mutation, func(t *testing.T) {
			decoded, _ := behaviorJSON(raw)
			states := ba(bm(decoded)["states"])
			state := bm(states[1])
			switch mutation {
			case "choice":
				state["input"] = obj{}
			case "observation":
				delete(bm(bm(state["s"])["o"]), "calls")
			case "diagnostics":
				delete(bm(state["s"]), "d")
			case "unsafe":
				bm(bm(state["s"])["o"])["loaders"] = obj{"#bigint": "9007199254740993"}
			}
			if _, err := coordinator.prepare("scope", "negative", []byte(bjson(decoded))); err == nil {
				t.Fatal("corrupt trace accepted")
			}
		})
	}
}
