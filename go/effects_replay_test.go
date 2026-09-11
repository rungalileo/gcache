package dialcache

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/synctest"
)

// C23/C25/C26 monitor consumes actual callback history, never expected ITF
// phases. Publication/source identity is additionally challenged by traces.
func (d *behaviorDriver) assertEffectsHistory() error {
	d.mu.Lock()
	history := append([]behaviorHistory(nil), d.history...)
	d.mu.Unlock()
	type source struct {
		at      int64
		settled string
	}
	sources := map[int]*source{}
	var active *source
	authorized := false
	previous := int64(-1)
	for index, e := range history {
		fail := func(reason string) error {
			return fmt.Errorf("effects contract event %d %s: %s", index, e.event, reason)
		}
		if e.at < previous {
			return fail("elapsed time moved backward")
		}
		previous = e.at
		switch e.event {
		case "sourceStart":
			if e.id < 0 || sources[e.id] != nil || active != nil {
				return fail("source started before prior fallback completed")
			}
			active = &source{at: e.at}
			sources[e.id] = active
			authorized = false
		case "sourceSettlement":
			s := sources[e.id]
			if s == nil || s.settled != "" || (e.outcome != "resolve" && e.outcome != "reject") {
				return fail("invalid source settlement identity")
			}
			s.settled = e.outcome
		case "fallbackCompletion":
			if active == nil {
				return fail("fallback completion has no source")
			}
			if math.IsNaN(e.duration) || math.IsInf(e.duration, 0) || e.duration < 0 {
				return fail("invalid observed fallback duration")
			}
			elapsed := float64(e.at - active.at)
			if math.Abs(e.duration-elapsed) > 1e-7 {
				return behaviorPropertyFailure("C23", "duration includes lookup or omits source time", obj{"event": e.event, "index": index, "atMs": e.at, "elapsedMs": elapsed, "durationMs": e.duration})
			}
			if !e.failed && (elapsed >= 10 || active.settled != "resolve") {
				return behaviorPropertyFailure("C25", "success must be accepted before its source deadline", obj{"event": e.event, "index": index, "atMs": e.at, "elapsedMs": elapsed, "budgetMs": 10, "settlement": active.settled, "failed": e.failed})
			}
			if e.failed && elapsed < 10 && active.settled != "reject" {
				return behaviorPropertyFailure("C23", "source lost its full source-relative budget", obj{"event": e.event, "index": index, "atMs": e.at, "elapsedMs": elapsed, "budgetMs": 10, "settlement": active.settled, "failed": e.failed})
			}
			active = nil
			authorized = !e.failed
		case "writeDispatch":
			if !authorized {
				return behaviorPropertyFailure("C26", "publication without accepted source success", obj{"event": e.event, "index": index, "atMs": e.at, "authorized": authorized})
			}
		default:
			return fail("unknown monitor event")
		}
	}
	return nil
}

// Both public replay and witness validation consume this exact inventory.
// Scheduled regressions are part of the corpus, including when their witness
// consequence is absent from every randomly sampled history.
func effectsPaths() ([]string, error) {
	paths := []string{"../formal/effects-smoke.itf.json"}
	if file := os.Getenv("DIALCACHE_EFFECTS_TRACE_FILE"); file != "" {
		paths = []string{file}
	} else if dir := os.Getenv("DIALCACHE_EFFECTS_TRACE_DIR"); dir != "" {
		var err error
		paths, err = filepath.Glob(filepath.Join(dir, "*.itf.json"))
		if err != nil {
			return nil, err
		}
		regressions, err := featureRegressionPaths("effects", dir)
		if err != nil {
			return nil, err
		}
		paths = append(paths, regressions...)
	}
	if len(paths) == 0 {
		return nil, fmt.Errorf("empty effects corpus")
	}
	return paths, nil
}

func TestEffectsPathsRejectMissingScheduledRegressions(t *testing.T) {
	t.Setenv("DIALCACHE_EFFECTS_TRACE_FILE", "")
	t.Setenv("DIALCACHE_EFFECTS_TRACE_DIR", t.TempDir())
	if _, err := effectsPaths(); err == nil || !strings.Contains(err.Error(), "missing Quint regression") {
		t.Fatalf("missing scheduled histories must fail corpus selection: %v", err)
	}
}

func TestEffectsConformance(t *testing.T) {
	coordinator := newReplayCoordinator(t)
	info, err := coordinator.call(obj{"op": "profiles"})
	if err != nil {
		t.Fatal(err)
	}
	effectsActions := append([]any{"init"}, ba(bm(info["profiles"])["effects"])...)
	requireRegistry(t)
	requireBehaviorProfile(t, "effects")
	paths, err := effectsPaths()
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		prepared, err := coordinator.prepare("effects", path, raw)
		if err != nil {
			t.Fatal(err)
		}
		for _, action := range ba(prepared["actions"]) {
			seen[bs(action)] = true
		}
		t.Run(filepath.Base(path), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				d := newBehaviorDriver(t, bm(prepared["fixture"]))
				defer d.close()
				if err := coordinator.replay(d, prepared, d.assertEffectsHistory); err != nil {
					t.Error(err)
				}
			})
		})
	}
	if os.Getenv("DIALCACHE_EFFECTS_TRACE_DIR") != "" && os.Getenv("DIALCACHE_EFFECTS_TRACE_FILE") == "" {
		for _, action := range effectsActions {
			if !seen[bs(action)] {
				t.Errorf("effects corpus omitted action %s", action)
			}
		}
	}
	t.Logf("specification=0.1.0 effectsProfile=2 traces=%d", len(paths))
}
func TestEffectsParserRejectsMissingDiagnostics(t *testing.T) {
	coordinator := newReplayCoordinator(t)
	raw, err := os.ReadFile("../formal/effects-smoke.itf.json")
	if err != nil {
		t.Fatal(err)
	}
	decoded, _ := behaviorJSON(raw)
	state := bm(ba(bm(decoded)["states"])[0])
	delete(bm(state["s"]), "events")
	if _, err := coordinator.prepare("effects", "negative", []byte(bjson(decoded))); err == nil {
		t.Fatal("missing diagnostic expectations accepted")
	}
}
