package dialcache

import (
	"context"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/redis/go-redis/v9"
)

// These native observations intentionally supplement JSON-projected Quint
// traces: a trace value cannot distinguish copied objects from borrowed ones.
func TestBorrowedReferencesSurviveFollowersAndCacheHits(t *testing.T) {
	for _, layer := range []string{"request", "local"} {
		for _, kind := range []string{"pointer", "map"} {
			t.Run(layer+"/"+kind, func(t *testing.T) {
				synctest.Test(t, func(t *testing.T) {
					var original any = &struct{ Value int }{7}
					if kind == "map" {
						original = map[string]int{"value": 7}
					}
					cache := New(Options[any]{})
					op := Operation{Identity: Identity{KeyType: "item", ID: "borrowed", UseCase: "get"}}
					if layer == "request" {
						op.Policy.RequestLocal = true
					} else {
						op.Policy.LocalTTLMS = 60000
					}
					var calls atomic.Int32
					release := make(chan struct{})
					var releaseOnce sync.Once
					finishSource := func() { releaseOnce.Do(func() { close(release) }) }
					defer finishSource()
					load := func(context.Context) (any, error) {
						calls.Add(1)
						<-release
						return original, nil
					}
					assertBorrowed := func(value any, err error) {
						t.Helper()
						if err != nil || reflect.ValueOf(value).UnsafePointer() != reflect.ValueOf(original).UnsafePointer() {
							t.Fatalf("%s result was copied or failed: %v", kind, err)
						}
					}
					if err := cache.Enable(context.Background(), func(ctx context.Context) error {
						results := make(chan struct {
							value any
							err   error
						}, 2)
						invoke := func() {
							value, err := cache.GetOrLoad(ctx, op, load)
							results <- struct {
								value any
								err   error
							}{value, err}
						}
						go invoke()
						synctest.Wait()
						go invoke()
						synctest.Wait()
						if calls.Load() != 1 {
							t.Fatalf("followers started %d sources", calls.Load())
						}
						finishSource()
						for i := 0; i < 2; i++ {
							result := <-results
							assertBorrowed(result.value, result.err)
						}
						value, err := cache.GetOrLoad(ctx, op, load)
						assertBorrowed(value, err)
						return nil
					}); err != nil {
						t.Fatal(err)
					}
					if layer == "local" {
						if err := cache.Enable(context.Background(), func(ctx context.Context) error {
							value, err := cache.GetOrLoad(ctx, op, load)
							assertBorrowed(value, err)
							return nil
						}); err != nil {
							t.Fatal(err)
						}
					}
					if calls.Load() != 1 {
						t.Fatalf("cache hit repeated source: %d", calls.Load())
					}
				})
			})
		}
	}
}

func TestCachedRegistrationAfterInlineUseCase(t *testing.T) {
	cache := New(Options[int]{})
	op := Operation{Identity: Identity{KeyType: "item", ID: "same", UseCase: "inlineThenCached"}, Policy: Policy{LocalTTLMS: 60000}}
	if err := cache.Enable(context.Background(), func(ctx context.Context) error {
		value, err := cache.GetOrLoad(ctx, op, func(context.Context) (int, error) { return 7, nil })
		if err != nil || value != 7 {
			t.Fatalf("inline call failed: %v %v", value, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	selector := func(id string) (Identity, error) { return Identity{ID: id}, nil }
	calls := 0
	loader := func(context.Context, string) (int, error) { calls++; return 9, nil }
	bound, err := Cached(cache, op, selector, loader)
	if err != nil {
		t.Fatalf("inline call reserved wrapper registration: %v", err)
	}
	if _, err := Cached(cache, op, selector, loader); err == nil {
		t.Fatal("wrapper registration did not reserve the use case")
	}
	if err := cache.Enable(context.Background(), func(ctx context.Context) error {
		value, err := bound(ctx, "same")
		if err != nil || value != 7 || calls != 0 {
			t.Fatalf("registered wrapper lost compatible inline entry: %v %v calls=%d", value, err, calls)
		}
		value, err = cache.GetOrLoad(ctx, op, func(context.Context) (int, error) { return 10, nil })
		if err != nil || value != 7 {
			t.Fatalf("registration prevented later inline reuse: %v %v", value, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

type featureContextHook struct {
	redisCommandHook
	process func(context.Context, redis.Cmder) error
}

func (hook featureContextHook) ProcessHook(redis.ProcessHook) redis.ProcessHook {
	return hook.process
}

func TestRedisAdapterForwardsReadContextCancellation(t *testing.T) {
	for _, tracked := range []bool{false, true} {
		name, watermark := "GET", ""
		if tracked {
			name, watermark = "MGET", "watermark"
		}
		t.Run(name, func(t *testing.T) {
			client := redis.NewClient(&redis.Options{Addr: "unused", MaxRetries: -1})
			defer client.Close()
			received := make(chan context.Context, 1)
			abandon := make(chan struct{})
			defer close(abandon)
			client.AddHook(featureContextHook{process: func(ctx context.Context, cmd redis.Cmder) error {
				received <- ctx
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-abandon:
					return errors.New("test stopped observing read")
				}
			}})
			type contextKey struct{}
			ctx, cancel := context.WithCancel(context.WithValue(context.Background(), contextKey{}, "metadata"))
			defer cancel()
			finished := make(chan error, 1)
			go func() {
				_, err := NewRedisAdapter(client).Read(ctx, "value", watermark)
				finished <- err
			}()
			var observed context.Context
			select {
			case observed = <-received:
			case err := <-finished:
				t.Fatalf("adapter returned before dispatching the client read: %v", err)
			}
			if observed.Done() != ctx.Done() || observed.Value(contextKey{}) != "metadata" {
				t.Fatal("adapter lost the supplied read context or metadata")
			}
			cancel()
			if err := <-finished; !errors.Is(err, context.Canceled) {
				t.Fatalf("client cancellation did not reach read result: %v", err)
			}
		})
	}
}

type featureValueCodec struct {
	value   any
	decodes *atomic.Int32
}

func (codec featureValueCodec) Encode(any) (Payload, error) {
	return Payload{Bytes: []byte("stable codec token")}, nil
}
func (codec featureValueCodec) Decode(Payload) (any, error) {
	codec.decodes.Add(1)
	return cloneFeatureValue(codec.value), nil
}
func cloneFeatureValue(value any) any {
	switch value := value.(type) {
	case map[string]any:
		copy := make(map[string]any, len(value))
		for key, element := range value {
			copy[key] = cloneFeatureValue(element)
		}
		return copy
	case []any:
		copy := make([]any, len(value))
		for index, element := range value {
			copy[index] = cloneFeatureValue(element)
		}
		return copy
	case []byte:
		return append([]byte{}, value...)
	default:
		return value
	}
}

func TestDefaultShadowComparatorNativeValueBoundaries(t *testing.T) {
	cases := []struct {
		name           string
		cached, source any
		equal          bool
	}{
		{"absent versus null", Absent, nil, false},
		{"absent equality", Absent, Absent, true},
		{"null equality", nil, nil, true},
		{"false versus zero", false, 0, false},
		{"NaN equality", math.NaN(), math.NaN(), true},
		{"signed zero", float64(0), math.Copysign(0, -1), false},
		{"nested property order", map[string]any{"a": 1, "b": []any{nil, Absent}}, map[string]any{"b": []any{nil, Absent}, "a": 1}, true},
		{"missing versus absent property", map[string]any{"a": Absent}, map[string]any{}, false},
		{"binary byte equality", []byte{1, 2}, []byte{1, 2}, true},
		{"binary versus numeric array", []byte{1, 2}, []any{1, 2}, false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var reads, writes, decodes, sources atomic.Int32
				outcomes := make(chan string, 2)
				frame := Frame{CreatedAtMS: uint64(time.Now().UnixMilli()), Payload: []byte("stable codec token")}
				remote := boundaryRemote{read: func(context.Context) (ReadResult, error) {
					reads.Add(1)
					return ReadResult{Kind: "hit", Frame: frame}, nil
				}, write: func(Frame) error { writes.Add(1); return nil }}
				cache := New(Options[any]{Remote: remote, Codec: featureValueCodec{test.cached, &decodes}, ShadowOutcome: func(event Event) { outcomes <- event.Outcome }})
				full := float64(100)
				op := Operation{Identity: Identity{KeyType: "item", ID: "same", UseCase: "nativeComparator"}, Policy: Policy{RemoteTTLMS: 60000, Shadow: &ShadowPolicy{Ramp: &full}}}
				if err := cache.Enable(context.Background(), func(ctx context.Context) error {
					_, err := cache.GetOrLoad(ctx, op, func(context.Context) (any, error) { sources.Add(1); return test.source, nil })
					return err
				}); err != nil {
					t.Fatal(err)
				}
				want, wantReads := "mismatch", int32(2)
				if test.equal {
					want, wantReads = "match", 1
				}
				if got := <-outcomes; got != want {
					t.Fatalf("default comparator verdict = %s, want %s", got, want)
				}
				synctest.Wait()
				if len(outcomes) != 0 || sources.Load() != 1 || decodes.Load() != 2 || reads.Load() != wantReads || writes.Load() != 0 {
					t.Fatalf("wrong native verdict effects: extra outcomes=%d sources=%d decodes=%d reads=%d writes=%d", len(outcomes), sources.Load(), decodes.Load(), reads.Load(), writes.Load())
				}
			})
		})
	}
}

type featureInspectionSource struct {
	release chan struct{}
	once    sync.Once
	calls   atomic.Int32
	value   string
	err     error
}

func (source *featureInspectionSource) finish() {
	source.once.Do(func() { close(source.release) })
}
func (source *featureInspectionSource) load(context.Context) (string, error) {
	source.calls.Add(1)
	<-source.release
	return source.value, source.err
}

func TestCoalescingInspectionSeparatesKeysInstancesAndRequestWork(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		first, second := New(Options[string]{}), New(Options[string]{})
		firstSource := &featureInspectionSource{release: make(chan struct{}), value: "first"}
		sourceError := errors.New("second key failed")
		secondSource := &featureInspectionSource{release: make(chan struct{}), err: sourceError}
		otherInstanceSource := &featureInspectionSource{release: make(chan struct{}), value: "other instance"}
		requestSource := &featureInspectionSource{release: make(chan struct{}), value: "request"}
		for _, source := range []*featureInspectionSource{firstSource, secondSource, otherInstanceSource, requestSource} {
			defer source.finish()
		}
		type result struct {
			value string
			err   error
		}
		operation := func(id string) Operation {
			return Operation{Identity: Identity{KeyType: "item", ID: id, UseCase: "inspection"}, Policy: Policy{LocalTTLMS: 60000}}
		}
		startProcess := func(cache *Cache[string], id string, source *featureInspectionSource, count int) <-chan result {
			completed := make(chan result, count)
			for i := 0; i < count; i++ {
				go func() {
					_ = cache.Enable(context.Background(), func(ctx context.Context) error {
						value, err := cache.GetOrLoad(ctx, operation(id), source.load)
						completed <- result{value, err}
						return nil
					})
				}()
			}
			return completed
		}
		assertState := func(cache *Cache[string], leaders, followers int, ageMS *int64) {
			t.Helper()
			got := cache.GetCoalescingState().Process
			if got.ActiveLeaders != leaders || got.ActiveFollowers != followers || !reflect.DeepEqual(got.OldestLeaderAgeMS, ageMS) {
				t.Fatalf("inspection = %+v age=%v, want leaders=%d followers=%d age=%v", got, got.OldestLeaderAgeMS, leaders, followers, ageMS)
			}
		}
		assertResults := func(completed <-chan result, count int, value string, err error) {
			t.Helper()
			for i := 0; i < count; i++ {
				got := <-completed
				if got.value != value || got.err != err {
					t.Fatalf("settled result = %+v, want value=%q error=%v", got, value, err)
				}
			}
		}
		assertState(first, 0, 0, nil)
		assertState(second, 0, 0, nil)
		firstResults := startProcess(first, "first", firstSource, 3)
		synctest.Wait()
		time.Sleep(40 * time.Millisecond)
		secondResults := startProcess(first, "second", secondSource, 2)

		// Two request-only callers share within one live request, but must never
		// appear in either instance's process-flight inspection.
		requestResults := make(chan result, 2)
		requestScopeDone := make(chan error, 1)
		go func() {
			requestScopeDone <- second.Enable(context.Background(), func(ctx context.Context) error {
				op := operation("request")
				op.Policy = Policy{RequestLocal: true}
				settled := make(chan result, 2)
				for i := 0; i < 2; i++ {
					go func() {
						value, err := second.GetOrLoad(ctx, op, requestSource.load)
						settled <- result{value, err}
					}()
				}
				for i := 0; i < 2; i++ {
					requestResults <- <-settled
				}
				return nil
			})
		}()
		synctest.Wait()
		age40 := int64(40)
		assertState(first, 2, 3, &age40)
		assertState(second, 0, 0, nil)
		otherResults := startProcess(second, "first", otherInstanceSource, 1)
		synctest.Wait()
		time.Sleep(60 * time.Millisecond)
		age100, age60 := int64(100), int64(60)
		assertState(first, 2, 3, &age100)
		assertState(second, 1, 0, &age60)
		for _, source := range []*featureInspectionSource{firstSource, secondSource, otherInstanceSource, requestSource} {
			if source.calls.Load() != 1 {
				t.Fatalf("source started %d times while inspection was live", source.calls.Load())
			}
		}

		firstSource.finish()
		assertResults(firstResults, 3, "first", nil)
		assertState(first, 1, 1, &age60)
		assertState(second, 1, 0, &age60)
		secondSource.finish()
		assertResults(secondResults, 2, "", sourceError)
		assertState(first, 0, 0, nil)
		assertState(second, 1, 0, &age60)
		requestSource.finish()
		assertResults(requestResults, 2, "request", nil)
		if err := <-requestScopeDone; err != nil {
			t.Fatal(err)
		}
		assertState(second, 1, 0, &age60)
		otherInstanceSource.finish()
		assertResults(otherResults, 1, "other instance", nil)
		assertState(second, 0, 0, nil)
	})
}

func TestRedisAdapterSurfacesInvalidationRetryError(t *testing.T) {
	missingScript := errors.New("NOSCRIPT No matching script. Please use EVAL")
	terminalCause := errors.New("permission denied")
	terminalError := fmt.Errorf("EVAL rejected: %w", terminalCause)
	var calls [][]any
	adapter := hookedRedis(t, func(cmd redis.Cmder) error {
		calls = append(calls, append([]any{}, cmd.Args()...))
		if cmd.Name() == "evalsha" {
			return missingScript
		}
		if cmd.Name() == "eval" {
			return terminalError
		}
		return fmt.Errorf("unexpected mutation command %q", cmd.Name())
	})
	err := adapter.Invalidate(context.Background(), "watermark", 1700000000000, 123)
	if err != terminalError || !errors.Is(err, terminalCause) || errors.Is(err, missingScript) {
		t.Fatalf("Go adapter changed terminal EVAL error identity/cause: %v", err)
	}
	if len(calls) != 2 || calls[0][0] != "evalsha" || calls[1][0] != "eval" || calls[1][1] != InvalidationScript || !reflect.DeepEqual(calls[0][2:], calls[1][2:]) {
		t.Fatalf("fallback did not preserve one logical invalidation: %#v", calls)
	}
}

type featureTaggedCodec struct {
	tag              string
	binary           bool
	encodes, decodes atomic.Int32
}

func (codec *featureTaggedCodec) Encode(value int) (Payload, error) {
	codec.encodes.Add(1)
	return Payload{Bytes: []byte(codec.tag + ":" + strconv.Itoa(value)), Binary: codec.binary}, nil
}
func (codec *featureTaggedCodec) Decode(payload Payload) (int, error) {
	codec.decodes.Add(1)
	if payload.Binary != codec.binary || !strings.HasPrefix(string(payload.Bytes), codec.tag+":") {
		return 0, errors.New("payload reached the wrong native codec")
	}
	return strconv.Atoi(strings.TrimPrefix(string(payload.Bytes), codec.tag+":"))
}

func TestInlineOperationCodecOverridesDefaultOnReadAndWrite(t *testing.T) {
	for _, override := range []bool{false, true} {
		name := "default"
		if override {
			name = "operation"
		}
		t.Run(name, func(t *testing.T) {
			clock := &manualClock{wall: 1700000000000}
			remote := &memoryRemote{clock: clock, values: make(map[string]remoteEntry), watermarks: make(map[string]string)}
			defaultCodec := &featureTaggedCodec{tag: "default"}
			operationCodec := &featureTaggedCodec{tag: "operation", binary: true}
			cache := New(Options[int]{Clock: clock, Remote: remote, Codec: defaultCodec, DisableCompression: true})
			op := Operation{Identity: Identity{Namespace: "urn", KeyType: "item", ID: "same", UseCase: "inlineCodec"}, Policy: Policy{RemoteTTLMS: 60000}}
			selected, unused := defaultCodec, operationCodec
			if override {
				op.Codec = operationCodec
				selected, unused = operationCodec, defaultCodec
			}
			var sources atomic.Int32
			for i := 0; i < 2; i++ {
				if err := cache.Enable(context.Background(), func(ctx context.Context) error {
					value, err := cache.GetOrLoad(ctx, op, func(context.Context) (int, error) { sources.Add(1); return 7, nil })
					if err != nil || value != 7 {
						t.Fatalf("inline codec result: value=%d error=%v", value, err)
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			}
			if sources.Load() != 1 || selected.encodes.Load() != 1 || selected.decodes.Load() != 1 || unused.encodes.Load() != 0 || unused.decodes.Load() != 0 {
				t.Fatalf("codec selection effects: sources=%d selected=%d/%d unused=%d/%d", sources.Load(), selected.encodes.Load(), selected.decodes.Load(), unused.encodes.Load(), unused.decodes.Load())
			}
			_, remoteKey, _, err := op.Identity.Keys()
			if err != nil {
				t.Fatal(err)
			}
			remote.mu.Lock()
			stored := append([]byte{}, remote.values[remoteKey].raw...)
			reads, writes := remote.reads, remote.writes
			remote.mu.Unlock()
			frame := DecodeFrame(stored, false, nil)
			if frame.Kind != "hit" || string(frame.Frame.Payload) != name+":7" || frame.Frame.Binary != override || reads != 2 || writes != 1 {
				t.Fatalf("wrong native publication: frame=%+v reads=%d writes=%d", frame, reads, writes)
			}
		})
	}
}

func TestInlinePolicySnapshotsMutableRampPerInvocation(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	finishProvider := func() { once.Do(func() { close(release) }) }
	defer finishProvider()
	var policies, sources atomic.Int32
	cache := New(Options[int]{PolicyProvider: func(context.Context, Identity) (any, error) {
		if policies.Add(1) == 1 {
			close(entered)
			<-release
		}
		return nil, nil
	}})
	ramp := float64(100)
	op := Operation{Identity: Identity{KeyType: "item", ID: "same", UseCase: "inlinePolicy"}, Policy: Policy{LocalTTLMS: 60000, LocalRamp: &ramp}}
	type result struct {
		value int
		err   error
	}
	invoke := func() result {
		var got result
		got.err = cache.Enable(context.Background(), func(ctx context.Context) error {
			var err error
			got.value, err = cache.GetOrLoad(ctx, op, func(context.Context) (int, error) { return int(sources.Add(1)), nil })
			return err
		})
		return got
	}
	completed := make(chan result, 1)
	go func() { completed <- invoke() }()
	<-entered
	// The provider barrier is reached after validation and snapshot creation.
	// Mutation cannot race the caller's input read; release orders the provider
	// reply and all subsequent policy use after this deliberate input change.
	ramp = 0
	finishProvider()
	if got := <-completed; got.err != nil || got.value != 1 {
		t.Fatalf("first invocation failed: %+v", got)
	}
	if got := invoke(); got.err != nil || got.value != 2 {
		t.Fatalf("later invocation ignored changed default ramp: %+v", got)
	}
	ramp = 100
	if got := invoke(); got.err != nil || got.value != 1 {
		t.Fatalf("first invocation lost its captured caching policy: %+v", got)
	}
	if sources.Load() != 2 || policies.Load() != 3 {
		t.Fatalf("wrong snapshot effects: sources=%d policy resolutions=%d", sources.Load(), policies.Load())
	}
}

func TestCompressionConstructionDefaultsAndExplicitDisable(t *testing.T) {
	resolved, err := ResolveCompressionConfig(nil)
	if err != nil || resolved != (CompressionConfig{ThresholdBytes: 4096, Level: 3}) {
		t.Fatalf("wrong public compression defaults: %+v %v", resolved, err)
	}
	for _, invalid := range []CompressionConfig{{ThresholdBytes: -1, Level: 3}, {ThresholdBytes: 1, Level: 23}} {
		t.Run(fmt.Sprintf("invalid threshold=%d level=%d", invalid.ThresholdBytes, invalid.Level), func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Fatal("invalid enabled compression did not reject at construction")
				}
			}()
			_ = New(Options[any]{Compression: &invalid})
		})
	}
	for _, test := range []struct {
		name     string
		length   int
		disabled bool
		outcome  string
	}{
		{"below default threshold", 4093, false, "below_threshold"},
		{"at default threshold", 4094, false, "compressed"},
		{"explicitly disabled", 8192, true, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			value := strings.Repeat("x", test.length)
			var frame Frame
			var outcomes []string
			var mu sync.Mutex
			remote := boundaryRemote{read: func(context.Context) (ReadResult, error) {
				return ReadResult{Kind: "miss", Reason: "value_absent"}, nil
			}, write: func(written Frame) error {
				mu.Lock()
				defer mu.Unlock()
				frame = Frame{CreatedAtMS: written.CreatedAtMS, Binary: written.Binary, Payload: append([]byte{}, written.Payload...)}
				return nil
			}}
			cache := New(Options[string]{Remote: remote, DisableCompression: test.disabled, Observe: func(event Event) {
				if event.Kind == "compression" {
					mu.Lock()
					outcomes = append(outcomes, event.Outcome)
					mu.Unlock()
				}
			}})
			op := Operation{Identity: Identity{KeyType: "item", ID: "same", UseCase: "compressionDefaults"}, Policy: Policy{RemoteTTLMS: 60000}}
			if err := cache.Enable(context.Background(), func(ctx context.Context) error {
				got, err := cache.GetOrLoad(ctx, op, func(context.Context) (string, error) { return value, nil })
				if err != nil || got != value {
					t.Fatalf("compression changed source result: %v", err)
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			mu.Lock()
			defer mu.Unlock()
			if test.outcome == "" {
				if len(outcomes) != 0 {
					t.Fatalf("disabled compression reported write outcomes: %v", outcomes)
				}
			} else if !reflect.DeepEqual(outcomes, []string{test.outcome}) {
				t.Fatalf("wrong compression outcome: %v", outcomes)
			}
			rawJSON := `"` + value + `"`
			if test.outcome == "compressed" {
				decoded := DecompressPayload(Payload{Bytes: frame.Payload, Binary: frame.Binary})
				if !frame.Binary || len(frame.Payload) >= len(rawJSON) || decoded.Outcome != "decompressed" || string(decoded.Payload.Bytes) != rawJSON || decoded.Payload.Binary {
					t.Fatalf("default compression did not preserve a smaller text value: %+v", decoded)
				}
			} else if frame.Binary || string(frame.Payload) != rawJSON {
				t.Fatal("raw write unexpectedly compressed or changed serialized JSON")
			}
		})
	}
}

func TestCapacityConstructionOmissionAndBounds(t *testing.T) {
	for _, explicitZero := range []bool{false, true} {
		name := "zero options mean omission"
		if explicitZero {
			name = "explicit local zero disables settled storage"
		}
		t.Run(name, func(t *testing.T) {
			cache := New(Options[int]{LocalCapacity: 0, LocalCapacitySet: explicitZero, ShadowMaxInFlight: 0})
			// Go's zero-valued integer options are omission. The explicit local
			// presence bit permits zero storage; shadow has no explicit-zero mode.
			wantCapacity := 10000
			if explicitZero {
				wantCapacity = 0
			}
			if cache.options.LocalCapacity != wantCapacity || cache.options.ShadowMaxInFlight != 1 {
				t.Fatalf("wrong native construction defaults: local=%d shadow=%d", cache.options.LocalCapacity, cache.options.ShadowMaxInFlight)
			}
			op := Operation{Identity: Identity{KeyType: "item", ID: "same", UseCase: "capacityBinding"}, Policy: Policy{LocalTTLMS: 60000}}
			var sources atomic.Int32
			for call := 1; call <= 2; call++ {
				want := 1
				if explicitZero {
					want = call
				}
				if err := cache.Enable(context.Background(), func(ctx context.Context) error {
					value, err := cache.GetOrLoad(ctx, op, func(context.Context) (int, error) { return int(sources.Add(1)), nil })
					if err != nil || value != want {
						t.Fatalf("capacity binding result=%d error=%v, want %d", value, err, want)
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			}
			wantSources := int32(1)
			if explicitZero {
				wantSources = 2
			}
			if sources.Load() != wantSources {
				t.Fatalf("wrong retention behavior: source calls=%d", sources.Load())
			}
		})
	}
	for _, test := range []struct {
		name    string
		options Options[any]
	}{
		{"negative local", Options[any]{LocalCapacity: -1}},
		{"negative shadow", Options[any]{ShadowMaxInFlight: -1}},
	} {
		t.Run(test.name, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Fatal("invalid capacity did not reject at construction")
				}
			}()
			_ = New(test.options)
		})
	}
}
