package dialcache

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

// Used only for strict input/observation parsing. Execution below creates real
// default instances, rather than the ordinary integer-clock BehaviorDriver.
func localClockProfile() behaviorProfile {
	return behaviorProfile{name: "local-clock", explicitInputs: true, actions: map[string]behaviorAction{
		"constructInstance": {choices: []int64{0, 1}},
		"advanceTicks":      {choices: []int64{1, 100, 300, 400, 700, 999200, 999999, 1000000}},
		"call":              {choices: []int64{0, 1, 2, 3}},
	}}
}

func replayLocalClockTrace(trace behaviorTrace) error {
	// Normalize only the test environment's phase, before replay begins. No
	// expected model timestamp or private cache state schedules an operation.
	probe := New[int](Options[int]{})
	elapsed := elapsedNow(probe.options.Clock)
	if elapsed < 0 {
		return fmt.Errorf("default clock started with negative elapsed time")
	}
	time.Sleep(time.Millisecond - elapsed%time.Millisecond)
	var caches [2]*Cache[int]
	var sources atomic.Int64
	actual := emptyBehaviorObservation(obj{})
	op := Operation{Identity: Identity{KeyType: "clock", ID: "one", UseCase: "QuintLocalGrid"}, Policy: Policy{LocalTTLMS: 1000}}
	for index, step := range trace.steps {
		switch step.action {
		case "constructInstance":
			if caches[step.choice] != nil {
				return fmt.Errorf("instance already constructed")
			}
			caches[step.choice] = New[int](Options[int]{})
		case "advanceTicks":
			time.Sleep(time.Duration(step.choice) * time.Microsecond)
		case "call":
			cache := caches[step.choice/2]
			if cache == nil {
				return fmt.Errorf("call before instance construction")
			}
			var value int
			err := cache.Enable(context.Background(), func(ctx context.Context) error {
				var err error
				value, err = cache.GetOrLoad(ctx, op, func(context.Context) (int, error) {
					sources.Add(1)
					return int(step.choice%2 + 1), nil
				})
				return err
			})
			if err != nil {
				return err
			}
			actual["calls"] = append(ba(actual["calls"]), value)
			actual["loaders"] = sources.Load()
		}
		if !bequal(step.expected, actual) {
			return fmt.Errorf("%s step %d %s choice %d\nexpected: %s\nactual: %s", trace.path, index, step.action, step.choice, bjson(step.expected), bjson(actual))
		}
	}
	return nil
}

func TestLocalClockConformance(t *testing.T) {
	paths, err := featurePaths("local-clock")
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) == 0 {
		t.Skip("the selected trace belongs to a different profile")
	}
	requireBehaviorProfile(t, "local-clock")
	for _, path := range paths {
		t.Run(filepath.Base(path), func(t *testing.T) {
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			trace, err := parseBehaviorTrace(raw, path, localClockProfile())
			if err != nil {
				t.Fatal(err)
			}
			synctest.Test(t, func(t *testing.T) {
				if err := replayLocalClockTrace(trace); err != nil {
					t.Fatal(err)
				}
			})
		})
	}
}

func TestLocalClockReplayIsolation(t *testing.T) {
	paths, err := featurePaths("local-clock")
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) == 0 {
		t.Skip("the selected trace belongs to a different profile")
	}
	t.Run("corrupted observation cannot steer replay", func(t *testing.T) {
		raw, err := os.ReadFile(paths[0])
		if err != nil {
			t.Fatal(err)
		}
		trace, err := parseBehaviorTrace(raw, paths[0], localClockProfile())
		if err != nil {
			t.Fatal(err)
		}
		trace.steps[1].expected["loaders"] = int64(1)
		synctest.Test(t, func(t *testing.T) {
			if err := replayLocalClockTrace(trace); err == nil {
				t.Fatal("corrupted source count was accepted")
			}
		})
	})
}
