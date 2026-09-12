package dialcache

import (
	"path/filepath"
	"strings"
	"testing"
	"testing/synctest"
)

// Harness control for the causally-ready-v1 settlement contract (PORTING.md),
// the Go counterpart of test/formal-settlement-control.test.ts. It replays the
// committed smoke history of every behaviorDriver-backed profile through the
// shared coordinator twice: once with the settling driver, which must pass,
// and once with a driver that skips its end-of-apply drain, which must be
// caught by the coordinator's observation assertions. If it were not, the
// contract would be unenforced and a port could pass without ever settling.
// The core and local-clock profiles use other drivers and are not covered.
//
// The file name ends in _replay_test.go so measure-go-semantics.mjs keeps this
// control out of the ordinary mutation cohort: it is evidence about the
// harness, not about the cache, and must earn no detection credit.
var settlementControlProfiles = []string{"independent", "layers", "admission", "scope", "recovery", "policy", "shadow", "effects"}

// Pinned with the TypeScript control: without the drain, all eight smoke
// histories fail an observation comparison. Lower it only with a written
// reason, together with the TypeScript floor; it must stay at least one.
const settlementControlMinimumDetections = 8

// replaySettlementControl runs one smoke history and returns the replay error,
// if any, instead of failing the test: the caller decides what the error means.
func replaySettlementControl(t *testing.T, coordinator *replayCoordinator, profile string, settle bool) error {
	t.Helper()
	prepared, err := coordinator.prepare(profile, filepath.Join("..", "formal", profile+"-smoke.itf.json"), nil)
	if err != nil {
		t.Fatal(err)
	}
	var result error
	synctest.Test(t, func(t *testing.T) {
		var d *behaviorDriver
		if settle {
			d = newBehaviorDriver(t, bm(prepared["fixture"]))
		} else {
			d = newUnsettledBehaviorDriver(t, bm(prepared["fixture"]))
		}
		defer d.close()
		result = coordinator.replay(d, prepared)
	})
	return result
}

func TestHarnessControlNoSettle(t *testing.T) {
	requireRegistry(t)
	coordinator := newReplayCoordinator(t)
	detected := []string{}
	undetected := []string{}
	for _, profile := range settlementControlProfiles {
		requireBehaviorProfile(t, profile)
		t.Run(profile+"/settling", func(t *testing.T) {
			if err := replaySettlementControl(t, coordinator, profile, true); err != nil {
				t.Errorf("settling driver failed the committed %s smoke history: %v", profile, err)
			}
		})
		t.Run(profile+"/no-settle", func(t *testing.T) {
			err := replaySettlementControl(t, coordinator, profile, false)
			if err == nil {
				undetected = append(undetected, profile)
				return
			}
			// Only an observation mismatch counts as detection. A driver,
			// transport or binding crash would be a harness defect, not
			// settlement evidence.
			if !strings.Contains(err.Error(), "Observation mismatch") {
				t.Fatalf("skipping settlement in %s failed without observation evidence: %v", profile, err)
			}
			detected = append(detected, profile)
		})
	}
	if len(settlementControlProfiles) < settlementControlMinimumDetections {
		t.Fatalf("the control covers %d profiles, fewer than its floor of %d", len(settlementControlProfiles), settlementControlMinimumDetections)
	}
	if len(detected) < settlementControlMinimumDetections {
		t.Fatalf("skipping settlement was detected by %d profiles, below the floor of %d\ndetected: %s\nundetected: %s",
			len(detected), settlementControlMinimumDetections, strings.Join(detected, ", "), strings.Join(undetected, ", "))
	}
	t.Logf("harness control: skipping settlement detected by %d/%d profiles (%s); undetected: [%s]",
		len(detected), len(settlementControlProfiles), strings.Join(detected, ", "), strings.Join(undetected, ", "))
}
