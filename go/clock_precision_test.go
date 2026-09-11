package dialcache

import (
	"context"
	"errors"
	"math"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

// synctest supplies a deterministic native monotonic clock. Each invocation
// starts 700us after construction, so truncating absolute milliseconds would
// discard most of its first millisecond. Production code receives no expected
// model state, private scheduling instruction, or fabricated source outcome.
func TestPreciseSourceDeadline(t *testing.T) {
	for _, work := range []time.Duration{350 * time.Microsecond, 999 * time.Microsecond, time.Millisecond, 1050 * time.Microsecond} {
		for _, rejected := range []bool{false, true} {
			name := work.String() + "/success"
			if rejected {
				name = work.String() + "/error"
			}
			t.Run(name, func(t *testing.T) {
				synctest.Test(t, func(t *testing.T) {
					sourceFinished := make(chan struct{})
					defer func() { <-sourceFinished }()
					var measured float64
					cache := New[int](Options[int]{Observe: func(event Event) {
						if event.Kind == "fallback" {
							measured = event.Seconds
						}
					}})
					time.Sleep(700 * time.Microsecond)
					budget := int64(1)
					op := Operation{Identity: Identity{KeyType: "clock", ID: "one", UseCase: "source"}, Policy: Policy{RequestLocal: true}, FallbackTimeoutMS: &budget}
					problem := errors.New("source failure")
					started := time.Now()
					var value int
					err := cache.Enable(context.Background(), func(ctx context.Context) error {
						var err error
						value, err = cache.GetOrLoad(ctx, op, func(context.Context) (int, error) {
							defer close(sourceFinished)
							time.Sleep(work)
							if rejected {
								return 0, problem
							}
							return 7, nil
						})
						return err
					})
					if work < time.Millisecond {
						if rejected && err != problem || !rejected && (err != nil || value != 7) {
							t.Fatalf("pre-deadline source outcome changed: value=%d error=%v", value, err)
						}
					} else {
						var timeout *FallbackTimeoutError
						if !errors.As(err, &timeout) || time.Since(started) < time.Millisecond {
							t.Fatalf("deadline boundary differs: elapsed=%s error=%v", time.Since(started), err)
						}
					}
					wantDuration := min(work, time.Millisecond).Seconds()
					if math.Abs(measured-wantDuration) > 1e-12 {
						t.Fatalf("source-relative duration got %g seconds, want %g", measured, wantDuration)
					}
				})
			})
		}
	}
}

func TestPreciseRemoteReadDeadline(t *testing.T) {
	for _, work := range []time.Duration{350 * time.Microsecond, 999 * time.Microsecond, time.Millisecond, 1050 * time.Microsecond} {
		t.Run(work.String(), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				readFinished := make(chan struct{})
				defer func() { <-readFinished }()
				remote := boundaryRemote{read: func(context.Context) (ReadResult, error) {
					defer close(readFinished)
					time.Sleep(work)
					return ReadResult{Kind: "hit", Frame: Frame{CreatedAtMS: uint64(time.Now().UnixMilli()), Payload: []byte("7")}}, nil
				}}
				cache := New[any](Options[any]{Remote: remote, RemoteReadTimeoutMS: 1})
				time.Sleep(700 * time.Microsecond)
				op := Operation{Identity: Identity{KeyType: "clock", ID: "one", UseCase: "read"}, Policy: Policy{RemoteTTLMS: 60000}}
				var sourceCalls int
				var value any
				started := time.Now()
				err := cache.Enable(context.Background(), func(ctx context.Context) error {
					var err error
					value, err = cache.GetOrLoad(ctx, op, func(context.Context) (any, error) { sourceCalls++; return 9, nil })
					return err
				})
				if err != nil {
					t.Fatal(err)
				}
				if work < time.Millisecond {
					if value != float64(7) || sourceCalls != 0 {
						t.Fatalf("pre-deadline read fell back: value=%v sources=%d", value, sourceCalls)
					}
				} else if value != 9 || sourceCalls != 1 || time.Since(started) < time.Millisecond {
					t.Fatalf("read deadline boundary differs: value=%v sources=%d elapsed=%s", value, sourceCalls, time.Since(started))
				}
			})
		})
	}
}

func TestPreciseShadowDeadline(t *testing.T) {
	for _, dark := range []bool{false, true} {
		for _, work := range []time.Duration{350 * time.Microsecond, time.Millisecond} {
			name := "served/" + work.String()
			if dark {
				name = "dark/" + work.String()
			}
			t.Run(name, func(t *testing.T) {
				synctest.Test(t, func(t *testing.T) {
					outcomes := make(chan string, 1)
					var writes atomic.Int64
					remote := boundaryRemote{read: func(context.Context) (ReadResult, error) {
						if dark {
							return ReadResult{Kind: "miss", Reason: "value_absent"}, nil
						}
						return ReadResult{Kind: "hit", Frame: Frame{CreatedAtMS: uint64(time.Now().UnixMilli()), Payload: []byte("7")}}, nil
					}, write: func(Frame) error { writes.Add(1); return nil }}
					cache := New[any](Options[any]{Remote: remote, ShadowOutcome: func(event Event) { outcomes <- event.Outcome }})
					time.Sleep(700 * time.Microsecond)
					budget, full, zero := int64(1), float64(100), float64(0)
					op := Operation{Identity: Identity{KeyType: "clock", ID: "one", UseCase: "shadow"}, Policy: Policy{RemoteTTLMS: 60000, Shadow: &ShadowPolicy{Ramp: &full}}, FallbackTimeoutMS: &budget}
					if dark {
						op.Policy.RemoteRamp = &zero
					}
					err := cache.Enable(context.Background(), func(ctx context.Context) error {
						_, err := cache.GetOrLoad(ctx, op, func(context.Context) (any, error) { time.Sleep(work); return float64(7), nil })
						return err
					})
					if !(dark && work >= time.Millisecond) && err != nil {
						t.Fatal(err)
					}
					want := "timeout"
					if work < time.Millisecond {
						want = "match"
						if dark {
							want = "filled"
						}
					}
					if got := <-outcomes; got != want {
						t.Fatalf("shadow work=%s got %s, want %s", work, got, want)
					}
					if (writes.Load() == 1) != (want == "filled") {
						t.Fatalf("shadow write authority changed: writes=%d outcome=%s", writes.Load(), want)
					}
				})
			})
		}
	}
}

func TestLocalInsertionExpiryUsesWholeMilliseconds(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cache := New[int](Options[int]{Clock: systemClock{origin: time.Now()}})
		time.Sleep(700 * time.Microsecond)
		op := Operation{Identity: Identity{KeyType: "clock", ID: "one", UseCase: "local"}, Policy: Policy{LocalTTLMS: 1000}}
		sources := 0
		call := func() int {
			var value int
			if err := cache.Enable(context.Background(), func(ctx context.Context) error {
				var err error
				value, err = cache.GetOrLoad(ctx, op, func(context.Context) (int, error) { sources++; return sources, nil })
				return err
			}); err != nil {
				t.Fatal(err)
			}
			return value
		}
		if call() != 1 {
			t.Fatal("initial source result differs")
		}
		// Local cache age uses absolute whole milliseconds, matching TS. The
		// entry inserted at 0.7ms expires at 1000ms, before 1000.7ms.
		time.Sleep(999200 * time.Microsecond)
		if call() != 1 || sources != 1 {
			t.Fatal("entry expired before its whole-millisecond boundary")
		}
		time.Sleep(100 * time.Microsecond)
		if call() != 2 || sources != 2 {
			t.Fatal("entry survived its whole-millisecond boundary")
		}
	})
}

func TestDefaultInstancesShareLocalMillisecondGrid(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		// Align the external schedule to the native default clock's next tick.
		// Expected results below come only from public calls, not cache state.
		probe := New[int](Options[int]{})
		elapsed := elapsedNow(probe.options.Clock)
		if elapsed < 0 {
			t.Fatal("default clock started with negative elapsed time")
		}
		phase := elapsed % time.Millisecond
		time.Sleep(time.Millisecond - phase)
		first := New[int](Options[int]{})
		time.Sleep(400 * time.Microsecond)
		second := New[int](Options[int]{})
		time.Sleep(300 * time.Microsecond)
		caches := []*Cache[int]{first, second}
		sources := []int{0, 0}
		op := Operation{Identity: Identity{KeyType: "clock", ID: "one", UseCase: "shared-grid"}, Policy: Policy{LocalTTLMS: 1000}}
		call := func(index int) int {
			var value int
			if err := caches[index].Enable(context.Background(), func(ctx context.Context) error {
				var err error
				value, err = caches[index].GetOrLoad(ctx, op, func(context.Context) (int, error) { sources[index]++; return sources[index], nil })
				return err
			}); err != nil {
				t.Fatal(err)
			}
			return value
		}
		for index := range caches {
			if call(index) != 1 {
				t.Fatal("initial instance result differs")
			}
		}
		time.Sleep(999200 * time.Microsecond)
		for index := range caches {
			if call(index) != 1 || sources[index] != 1 {
				t.Fatalf("instance %d expired before the common millisecond boundary", index)
			}
		}
		time.Sleep(100 * time.Microsecond)
		for index := range caches {
			if call(index) != 2 || sources[index] != 2 {
				t.Fatalf("instance %d survived the common millisecond boundary", index)
			}
		}
	})
}

func TestPreciseCoalescingAge(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cache := New[int](Options[int]{})
		time.Sleep(700 * time.Microsecond)
		started, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
		op := Operation{Identity: Identity{KeyType: "clock", ID: "one", UseCase: "coalescing"}, Policy: Policy{LocalTTLMS: 1000}}
		go func() {
			done <- cache.Enable(context.Background(), func(ctx context.Context) error {
				_, err := cache.GetOrLoad(ctx, op, func(context.Context) (int, error) { close(started); <-release; return 7, nil })
				return err
			})
		}()
		<-started
		time.Sleep(350 * time.Microsecond)
		state := cache.GetCoalescingState().Process
		close(release)
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		if state.ActiveLeaders != 1 || state.OldestLeaderAgeMS == nil || *state.OldestLeaderAgeMS != 0 {
			t.Fatalf("submillisecond leader age was rounded before subtraction: %+v", state)
		}
	})
}

type earlyPrecisionTimer struct {
	origin time.Time
	timers atomic.Int64
}

func (c *earlyPrecisionTimer) WallMS() int64              { return time.Now().UnixMilli() }
func (c *earlyPrecisionTimer) ElapsedMS() int64           { return c.ElapsedTime().Milliseconds() }
func (c *earlyPrecisionTimer) ElapsedTime() time.Duration { return time.Since(c.origin) }
func (c *earlyPrecisionTimer) AfterFunc(ms int64, f func()) Timer {
	if c.timers.Add(1) == 1 {
		return time.AfterFunc(200*time.Microsecond, f)
	}
	return time.AfterFunc(time.Duration(ms)*time.Millisecond, f)
}

func TestPreciseDeadlineRechecksEarlyTimer(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		clock := &earlyPrecisionTimer{origin: time.Now()}
		cache := New[int](Options[int]{Clock: clock})
		budget := int64(1)
		op := Operation{Identity: Identity{KeyType: "clock", ID: "one", UseCase: "timer"}, Policy: Policy{RequestLocal: true}, FallbackTimeoutMS: &budget}
		if err := cache.Enable(context.Background(), func(ctx context.Context) error {
			value, err := cache.GetOrLoad(ctx, op, func(context.Context) (int, error) { time.Sleep(350 * time.Microsecond); return 7, nil })
			if err == nil && value != 7 {
				t.Fatalf("source value=%d", value)
			}
			return err
		}); err != nil {
			t.Fatalf("early timer replaced pre-deadline source: %v", err)
		}
		if clock.timers.Load() != 2 {
			t.Fatalf("timer was not rearmed exactly once: %d", clock.timers.Load())
		}
	})
}

type integerPrecisionClock struct{ now atomic.Int64 }

func (c *integerPrecisionClock) WallMS() int64    { return 1 }
func (c *integerPrecisionClock) ElapsedMS() int64 { return c.now.Load() }

func TestPreciseClockPreservesIntegerClockCompatibility(t *testing.T) {
	for _, work := range []int64{9, 10} {
		clock := &integerPrecisionClock{}
		clock.now.Store(100000)
		cache := New[int](Options[int]{Clock: clock})
		budget := int64(10)
		op := Operation{Identity: Identity{KeyType: "clock", ID: "one", UseCase: "legacy"}, Policy: Policy{RequestLocal: true}, FallbackTimeoutMS: &budget}
		err := cache.Enable(context.Background(), func(ctx context.Context) error {
			value, err := cache.GetOrLoad(ctx, op, func(context.Context) (int, error) { clock.now.Add(work); return 7, nil })
			if err == nil && value != 7 {
				t.Fatalf("source value=%d", value)
			}
			return err
		})
		if work < budget && err != nil {
			t.Fatalf("integer pre-deadline source rejected: %v", err)
		}
		var timeout *FallbackTimeoutError
		if work == budget && !errors.As(err, &timeout) {
			t.Fatalf("integer exact deadline accepted: %v", err)
		}
	}
}

func TestPreciseLocalTTLAcceptsLargeIntegerClockOrigin(t *testing.T) {
	clock := &integerPrecisionClock{}
	// Clock does not require a zero origin. This offset leaves less than 1s
	// before a duration representation wraps, while millisecond values remain
	// valid. Expiry must compare elapsed age, not an absolute summed cutoff.
	clock.now.Store(9_223_372_036_800)
	cache := New[int](Options[int]{Clock: clock})
	op := Operation{Identity: Identity{KeyType: "clock", ID: "one", UseCase: "large-origin"}, Policy: Policy{LocalTTLMS: 1000}}
	sources := 0
	call := func() int {
		var value int
		if err := cache.Enable(context.Background(), func(ctx context.Context) error {
			var err error
			value, err = cache.GetOrLoad(ctx, op, func(context.Context) (int, error) { sources++; return sources, nil })
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return value
	}
	if call() != 1 || call() != 1 {
		t.Fatal("large clock origin expired a newly inserted local entry")
	}
	clock.now.Add(999)
	if call() != 1 {
		t.Fatal("large clock origin shortened insertion TTL")
	}
	clock.now.Add(1)
	if call() != 2 || sources != 2 {
		t.Fatal("large clock origin changed the exact TTL boundary")
	}
}
