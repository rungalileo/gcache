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

func replayLocalClockTrace(coordinator *replayCoordinator, prepared obj) error {
	// Normalize only the test environment's phase. The driver uses real default
	// instances, so an injected integer clock cannot hide a construction-grid bug.
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
	apply := func(input obj) error {
		instance := bn(input["instance"])
		switch input["op"] {
		case "constructInstance":
			if instance < 0 || instance >= int64(len(caches)) || caches[instance] != nil {
				return fmt.Errorf("invalid/duplicate instance")
			}
			caches[instance] = New[int](Options[int]{})
		case "advanceTicks":
			ticks := bn(input["ticks"])
			if ticks <= 0 {
				return fmt.Errorf("invalid clock advance")
			}
			time.Sleep(time.Duration(ticks) * time.Microsecond)
		case "call":
			if instance < 0 || instance >= int64(len(caches)) || caches[instance] == nil {
				return fmt.Errorf("call before instance construction")
			}
			cache := caches[instance]
			var value int
			err := cache.Enable(context.Background(), func(ctx context.Context) error {
				var err error
				value, err = cache.GetOrLoad(ctx, op, func(context.Context) (int, error) { sources.Add(1); return int(bn(input["offered"])), nil })
				return err
			})
			if err != nil {
				return err
			}
			actual["calls"] = append(ba(actual["calls"]), value)
			actual["loaders"] = sources.Load()
		default:
			return fmt.Errorf("unknown local-clock command")
		}
		return nil
	}
	return coordinator.execute(prepared, apply, func() obj { return actual }, func() int64 { return time.Now().UnixMilli() })
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
	coordinator := newReplayCoordinator(t)
	for _, path := range paths {
		prepared, err := coordinator.prepare("local-clock", path, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Run(filepath.Base(path), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				if err := replayLocalClockTrace(coordinator, prepared); err != nil {
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
	coordinator := newReplayCoordinator(t)
	t.Run("corrupted observation cannot steer replay", func(t *testing.T) {
		raw, err := os.ReadFile(paths[0])
		if err != nil {
			t.Fatal(err)
		}
		trace, err := behaviorJSON(raw)
		if err != nil {
			t.Fatal(err)
		}
		state := bm(ba(bm(trace)["states"])[1])
		bm(bm(state["s"])["o"])["loaders"] = obj{"#bigint": "1"}
		prepared, err := coordinator.prepare("local-clock", paths[0], []byte(bjson(trace)))
		if err != nil {
			t.Fatal(err)
		}
		synctest.Test(t, func(t *testing.T) {
			if err := replayLocalClockTrace(coordinator, prepared); err == nil {
				t.Fatal("corrupted source count was accepted")
			}
		})
	})
}
