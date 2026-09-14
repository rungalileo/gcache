package gcache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// testPrefix is the namespace every test in this file writes under.
const testPrefix = "urn:galileo:test"

type sessionIdentity struct {
	SessionID string `json:"session_id"`
	CreatedAt string `json:"created_at"`
}

// fakeClient is an in-memory stand-in for Redis. It records the calls made so tests can
// assert on round trips, and can be told to fail.
type fakeClient struct {
	mu       sync.Mutex
	data     map[string][]byte
	ttls     map[string]time.Duration
	mgetErr  error
	setErr   error
	mgetKeys [][]string
}

func newFakeClient() *fakeClient {
	return &fakeClient{data: map[string][]byte{}, ttls: map[string]time.Duration{}}
}

func (f *fakeClient) MGet(_ context.Context, keys ...string) ([][]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.mgetKeys = append(f.mgetKeys, append([]string(nil), keys...))
	if f.mgetErr != nil {
		return nil, f.mgetErr
	}
	out := make([][]byte, len(keys))
	for i, k := range keys {
		if v, ok := f.data[k]; ok {
			out[i] = v
		}
	}
	return out, nil
}

func (f *fakeClient) SetEx(_ context.Context, key string, value []byte, ttl time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.setErr != nil {
		return f.setErr
	}
	f.data[key] = value
	f.ttls[key] = ttl
	return nil
}

func (f *fakeClient) get(key string) []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.data[key]
}

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func newTestCache(t *testing.T, c Client) *Cache[sessionIdentity] {
	t.Helper()
	cache, err := New(Options[sessionIdentity]{
		Client: c, URNPrefix: testPrefix, TTL: 2 * time.Hour, Logger: quietLogger(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return cache
}

var testKey = Key{KeyType: "session_id", ID: "sid-1", UseCase: "ingest::session_identity", Tracked: true}

func TestPutThenGetRoundTrips(t *testing.T) {
	f := newFakeClient()
	cache := newTestCache(t, f)
	want := sessionIdentity{SessionID: "sid-1", CreatedAt: "2026-09-08T02:42:19.068724Z"}

	if err := cache.Put(context.Background(), testKey, want); err != nil {
		t.Fatalf("Put: %v", err)
	}
	got, ok := cache.Get(context.Background(), testKey)
	if !ok {
		t.Fatal("Get returned not-ok after Put")
	}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestGetOnTrackedKeyIsASingleRoundTrip(t *testing.T) {
	// Value and watermark must be fetched together; two round trips on the ingest hot path
	// would defeat the point of the cache.
	f := newFakeClient()
	cache := newTestCache(t, f)
	cache.Get(context.Background(), testKey)

	if len(f.mgetKeys) != 1 {
		t.Fatalf("made %d MGet calls, want 1", len(f.mgetKeys))
	}
	if len(f.mgetKeys[0]) != 2 {
		t.Errorf("MGet fetched %d keys, want 2 (value + watermark): %v", len(f.mgetKeys[0]), f.mgetKeys[0])
	}
}

func TestGetOnUntrackedKeySkipsTheWatermark(t *testing.T) {
	f := newFakeClient()
	cache := newTestCache(t, f)
	cache.Get(context.Background(), Key{KeyType: "kt", ID: "id", UseCase: "uc"})

	if len(f.mgetKeys[0]) != 1 {
		t.Errorf("MGet fetched %v, want just the value key", f.mgetKeys[0])
	}
}

func TestGetMissOnEmptyCache(t *testing.T) {
	cache := newTestCache(t, newFakeClient())
	if _, ok := cache.Get(context.Background(), testKey); ok {
		t.Error("Get on an empty cache returned ok")
	}
}

func TestInvalidateMakesTheEntryStale(t *testing.T) {
	f := newFakeClient()
	cache := newTestCache(t, f)
	ctx := context.Background()

	if err := cache.Put(ctx, testKey, sessionIdentity{SessionID: "sid-1"}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if _, ok := cache.Get(ctx, testKey); !ok {
		t.Fatal("expected a hit before invalidation")
	}
	if err := cache.Invalidate(ctx, testKey.KeyType, testKey.ID, 0); err != nil {
		t.Fatalf("Invalidate: %v", err)
	}
	if _, ok := cache.Get(ctx, testKey); ok {
		t.Error("expected a miss after invalidation")
	}
}

func TestInvalidateAffectsEveryUseCaseUnderTheSameKeyTypeAndID(t *testing.T) {
	// The watermark carries no use case: (key_type, id) is the invalidation namespace, so
	// one invalidate must bust sibling entries too.
	f := newFakeClient()
	cache := newTestCache(t, f)
	ctx := context.Background()

	a := Key{KeyType: "session_id", ID: "sid-1", UseCase: "uc-a", Tracked: true}
	b := Key{KeyType: "session_id", ID: "sid-1", UseCase: "uc-b", Tracked: true}
	for _, k := range []Key{a, b} {
		if err := cache.Put(ctx, k, sessionIdentity{SessionID: "sid-1"}); err != nil {
			t.Fatalf("Put %s: %v", k.UseCase, err)
		}
	}
	if err := cache.Invalidate(ctx, "session_id", "sid-1", 0); err != nil {
		t.Fatalf("Invalidate: %v", err)
	}
	for _, k := range []Key{a, b} {
		if _, ok := cache.Get(ctx, k); ok {
			t.Errorf("%s survived invalidation", k.UseCase)
		}
	}
}

func TestInvalidateWritesDecimalAsciiMillis(t *testing.T) {
	// Python reads this with float() then int(). Anything but a bare decimal number breaks
	// the Python side of the protocol.
	f := newFakeClient()
	cache := newTestCache(t, f)
	if err := cache.Invalidate(context.Background(), "session_id", "sid-1", 30*time.Second); err != nil {
		t.Fatalf("Invalidate: %v", err)
	}

	raw := f.get(WatermarkKey("urn:galileo:test", "session_id", "sid-1"))
	ms, err := strconv.ParseInt(string(raw), 10, 64)
	if err != nil {
		t.Fatalf("watermark %q is not decimal ASCII: %v", raw, err)
	}
	// The future buffer must actually be in the future.
	if ms <= time.Now().UnixMilli() {
		t.Errorf("watermark %d is not in the future", ms)
	}
}

func TestInvalidateUsesTheProtocolWatermarkTTL(t *testing.T) {
	f := newFakeClient()
	cache := newTestCache(t, f)
	_ = cache.Invalidate(context.Background(), "session_id", "sid-1", 0)
	if got := f.ttls[WatermarkKey("urn:galileo:test", "session_id", "sid-1")]; got != watermarkTTL {
		t.Errorf("watermark TTL = %s, want %s (Python's hardcoded WATERMARK_TTL_SECONDS)", got, watermarkTTL)
	}
}

func TestGetFailsOpenOnRedisError(t *testing.T) {
	// The whole contract: a broken cache slows callers down, it never breaks them.
	f := newFakeClient()
	f.mgetErr = errors.New("connection refused")
	cache := newTestCache(t, f)

	if _, ok := cache.Get(context.Background(), testKey); ok {
		t.Error("Get returned ok despite a Redis error")
	}
}

func TestGetFailsOpenOnCorruptValue(t *testing.T) {
	f := newFakeClient()
	cache := newTestCache(t, f)
	f.data[ValueKey("urn:galileo:test", testKey)] = []byte("\x01\x02 garbage")

	if _, ok := cache.Get(context.Background(), testKey); ok {
		t.Error("Get returned ok for a corrupt value")
	}
}

func TestGetTreatsAPickleValueAsAPlainMiss(t *testing.T) {
	// Written by a Python caller using the default envelope. Expected, not corruption.
	f := newFakeClient()
	rec := &recordingRecorder{}
	cache, err := New(Options[sessionIdentity]{
		Client: f, URNPrefix: testPrefix, TTL: time.Hour, Logger: quietLogger(), Recorder: rec,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	f.data[ValueKey("urn:galileo:test", testKey)] = []byte{0x80, 0x05, 0x95, 0x01}

	if _, ok := cache.Get(context.Background(), testKey); ok {
		t.Error("Get returned ok for a pickle value")
	}
	if got := rec.results[len(rec.results)-1]; got != ResultMiss {
		t.Errorf("recorded %q, want %q -- a pickle value is expected, not an error", got, ResultMiss)
	}
}

func TestGetFailsClosedOnAnUnreadableWatermark(t *testing.T) {
	// An unparseable watermark must NOT be read as "no watermark": that would serve an
	// entry someone tried to invalidate.
	f := newFakeClient()
	cache := newTestCache(t, f)
	ctx := context.Background()
	if err := cache.Put(ctx, testKey, sessionIdentity{SessionID: "sid-1"}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	f.data[WatermarkKey("urn:galileo:test", "session_id", "sid-1")] = []byte("not-a-number")

	if _, ok := cache.Get(ctx, testKey); ok {
		t.Error("served an entry despite an unreadable watermark")
	}
}

func TestPutReportsWriteFailures(t *testing.T) {
	// Unlike reads, writes surface their error -- a caller that failed to publish usually
	// wants to know.
	f := newFakeClient()
	f.setErr = errors.New("READONLY")
	cache := newTestCache(t, f)

	if err := cache.Put(context.Background(), testKey, sessionIdentity{}); err == nil {
		t.Error("Put returned nil despite a Redis error")
	}
	if err := cache.Invalidate(context.Background(), "session_id", "sid-1", 0); err == nil {
		t.Error("Invalidate returned nil despite a Redis error")
	}
}

func TestNewRejectsATTLThatWouldOutliveItsWatermark(t *testing.T) {
	_, err := New(Options[sessionIdentity]{Client: newFakeClient(), URNPrefix: testPrefix, TTL: watermarkTTL + time.Second})
	if err == nil {
		t.Fatal("New accepted a TTL longer than the watermark lifetime")
	}
	if _, err := New(Options[sessionIdentity]{Client: newFakeClient(), URNPrefix: testPrefix, TTL: watermarkTTL}); err != nil {
		t.Errorf("New rejected a TTL exactly at the limit: %v", err)
	}
}

func TestNewRejectsAURNPrefixThatCannotWork(t *testing.T) {
	// An empty prefix and one carrying a grammar delimiter both fail the same way -- the
	// cache writes without error into a key space no other client reads.
	for _, prefix := range []string{"", "urn:galileo:{cust}", "urn:galileo:cust#1", "urn:galileo:a?b"} {
		if _, err := New(Options[sessionIdentity]{
			Client: newFakeClient(), URNPrefix: prefix, TTL: time.Hour,
		}); err == nil {
			t.Errorf("New accepted URNPrefix %q", prefix)
		}
	}
}

func TestInvalidateRejectsAFutureBufferTheWatermarkCannotOutlive(t *testing.T) {
	// The watermark lives 4h. An entry written just before the buffer elapses lives
	// futureBuffer+TTL from now, so a buffer that pushes that sum past 4h would let the
	// entry outlive the watermark suppressing it and resurrect.
	client := newFakeClient()
	cache, err := New(Options[sessionIdentity]{Client: client, URNPrefix: testPrefix, TTL: 2 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if err := cache.Invalidate(context.Background(), "kt", "id", 2*time.Hour+time.Second); err == nil {
		t.Error("Invalidate accepted a futureBuffer that outlives the watermark")
	}
	if err := cache.Invalidate(context.Background(), "kt", "id", 2*time.Hour); err != nil {
		t.Errorf("Invalidate rejected a futureBuffer exactly at the limit: %v", err)
	}
}

func TestNewRequiresAClientAndTTL(t *testing.T) {
	if _, err := New(Options[sessionIdentity]{URNPrefix: testPrefix, TTL: time.Hour}); err == nil {
		t.Error("New accepted a nil Client")
	}
	if _, err := New(Options[sessionIdentity]{Client: newFakeClient(), URNPrefix: testPrefix}); err == nil {
		t.Error("New accepted a zero TTL")
	}
}

func TestGetRejectsAReservedUseCase(t *testing.T) {
	cache := newTestCache(t, newFakeClient())
	bad := Key{KeyType: "kt", ID: "id", UseCase: "watermark"}
	if _, ok := cache.Get(context.Background(), bad); ok {
		t.Error("Get accepted the reserved 'watermark' use case")
	}
	if err := cache.Put(context.Background(), bad, sessionIdentity{}); err == nil {
		t.Error("Put accepted the reserved 'watermark' use case")
	}
}

func TestStoredValueIsTheCrossLanguageEnvelope(t *testing.T) {
	// Assert on the bytes, not a round trip: a round trip would pass for any framing.
	f := newFakeClient()
	cache := newTestCache(t, f)
	if err := cache.Put(context.Background(), testKey, sessionIdentity{SessionID: "sid-1", CreatedAt: "t"}); err != nil {
		t.Fatalf("Put: %v", err)
	}

	var stored map[string]any
	if err := json.Unmarshal(f.get(ValueKey("urn:galileo:test", testKey)), &stored); err != nil {
		t.Fatalf("stored value is not JSON: %v", err)
	}
	if stored["version"] != float64(envelopeVersion) || stored["encoding"] != "utf8" {
		t.Errorf("unexpected envelope: %+v", stored)
	}
	var payload sessionIdentity
	if err := json.Unmarshal([]byte(stored["payload"].(string)), &payload); err != nil {
		t.Fatalf("payload is not JSON: %v", err)
	}
	if payload.SessionID != "sid-1" {
		t.Errorf("payload = %+v", payload)
	}
}

type recordingRecorder struct {
	mu      sync.Mutex
	results []Result
	errs    []error
}

func (r *recordingRecorder) RecordResult(_ string, res Result) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.results = append(r.results, res)
}
func (r *recordingRecorder) RecordLatency(_, _ string, _ time.Duration) {}
func (r *recordingRecorder) RecordError(_, _ string, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.errs = append(r.errs, err)
}

func TestRecorderSeesHitMissStaleAndError(t *testing.T) {
	f := newFakeClient()
	rec := &recordingRecorder{}
	cache, err := New(Options[sessionIdentity]{
		Client: f, URNPrefix: testPrefix, TTL: time.Hour, Logger: quietLogger(), Recorder: rec,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx := context.Background()

	cache.Get(ctx, testKey)                                   // miss
	_ = cache.Put(ctx, testKey, sessionIdentity{})            //
	cache.Get(ctx, testKey)                                   // hit
	_ = cache.Invalidate(ctx, testKey.KeyType, testKey.ID, 0) //
	cache.Get(ctx, testKey)                                   // stale
	f.mgetErr = errors.New("boom")
	cache.Get(ctx, testKey) // error

	want := []Result{ResultMiss, ResultHit, ResultStale, ResultError}
	if len(rec.results) != len(want) {
		t.Fatalf("recorded %v, want %v", rec.results, want)
	}
	for i := range want {
		if rec.results[i] != want[i] {
			t.Errorf("result[%d] = %q, want %q", i, rec.results[i], want[i])
		}
	}
}

func TestNilRecorderIsSafe(t *testing.T) {
	cache := newTestCache(t, newFakeClient())
	ctx := context.Background()
	_ = cache.Put(ctx, testKey, sessionIdentity{})
	cache.Get(ctx, testKey)
	_ = cache.Invalidate(ctx, "session_id", "sid-1", 0)
}

func TestGetTreatsAnExpiredEnvelopeAsAMiss(t *testing.T) {
	// The envelope's own expiry is the only cross-language ceiling on how long a value may
	// live. Go caps its own writes under the 4h watermark lifetime, but Python's
	// per-use-case TTL has none, so an entry written there can outlive the watermark that
	// invalidated it -- and without this check Go would serve it as fresh. The TypeScript
	// reader already treats a past expiresAtMs as a miss.
	client := newFakeClient()
	cache, err := New(Options[sessionIdentity]{
		Client: client, URNPrefix: testPrefix, TTL: time.Hour, Logger: quietLogger(),
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	key := Key{KeyType: "session_id", ID: "expired", UseCase: "test::expired"}

	// Written an hour ago with a one-minute lifetime, but still present in the store --
	// exactly what a PERSIST, or a longer Redis TTL than the envelope says, leaves behind.
	raw, err := encodeEnvelope(time.Now().Add(-time.Hour), time.Minute, []byte(`{"session_id":"s","created_at":"t"}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := client.SetEx(ctx, ValueKey(testPrefix, key), raw, time.Hour); err != nil {
		t.Fatal(err)
	}

	if _, ok := cache.Get(ctx, key); ok {
		t.Error("Get served an entry past its expiresAtMs")
	}
}

func TestGetServesAnUnexpiredEnvelope(t *testing.T) {
	// The other direction, so the expiry check cannot pass by rejecting everything.
	client := newFakeClient()
	cache, err := New(Options[sessionIdentity]{
		Client: client, URNPrefix: testPrefix, TTL: time.Hour, Logger: quietLogger(),
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	key := Key{KeyType: "session_id", ID: "fresh", UseCase: "test::fresh"}
	want := sessionIdentity{SessionID: "s-1", CreatedAt: "2026-09-09T00:00:00Z"}

	if err := cache.Put(ctx, key, want); err != nil {
		t.Fatal(err)
	}
	got, ok := cache.Get(ctx, key)
	if !ok || got != want {
		t.Errorf("Get = %+v, %v; want %+v, true", got, ok, want)
	}
}

func TestGetDistrustsATrackedEntryDeclaringMoreThanTheWatermarkLifetime(t *testing.T) {
	// The scenario the expiry check alone does NOT cover, and which an earlier version of
	// this code wrongly claimed was closed: Python writes with a 6h TTL at t=0, someone
	// invalidates at t=1h so the watermark lives to t=5h, and Go reads at t=5h30m. The key
	// is present, the declared expiry is still in the future, and the watermark is gone --
	// so without this guard the invalidated value is served as a hit.
	client := newFakeClient()
	cache, err := New(Options[sessionIdentity]{
		Client: client, URNPrefix: testPrefix, TTL: time.Hour, Logger: quietLogger(),
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	key := Key{KeyType: "session_id", ID: "long", UseCase: "test::long", Tracked: true}

	// A 6h declared lifetime, written half an hour ago: unexpired, but longer than the 4h
	// watermark can cover. The watermark itself has already expired and is absent.
	raw, err := encodeEnvelope(time.Now().Add(-30*time.Minute), 6*time.Hour, []byte(`{"session_id":"s","created_at":"t"}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := client.SetEx(ctx, ValueKey(testPrefix, key), raw, 6*time.Hour); err != nil {
		t.Fatal(err)
	}

	if _, ok := cache.Get(ctx, key); ok {
		t.Error("Get served a tracked entry that could have outlived its watermark")
	}
}

func TestDistrustedEntryIsRecordedDistinctlyFromAPlainMiss(t *testing.T) {
	// An empty cache also records ResultMiss, so recording the guard as a miss made it
	// invisible to metrics. That matters more here than on the other miss paths: the cure
	// is a use-case TTL configured in another language and another repository, which an
	// operator cannot reach from a miss count.
	client := newFakeClient()
	rec := &recordingRecorder{}
	cache, err := New(Options[sessionIdentity]{
		Client: client, URNPrefix: testPrefix, TTL: time.Hour, Logger: quietLogger(), Recorder: rec,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	key := Key{KeyType: "session_id", ID: "distrusted", UseCase: "test::distrust", Tracked: true}

	raw, err := encodeEnvelope(time.Now().Add(-30*time.Minute), 6*time.Hour, []byte(`{"session_id":"s"}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := client.SetEx(ctx, ValueKey(testPrefix, key), raw, 6*time.Hour); err != nil {
		t.Fatal(err)
	}

	if _, ok := cache.Get(ctx, key); ok {
		t.Fatal("Get served a distrusted entry")
	}
	if len(rec.results) != 1 || rec.results[0] != ResultDistrusted {
		t.Errorf("recorded %v, want exactly [%s]", rec.results, ResultDistrusted)
	}

	// An actually-absent key must still be a plain miss, so the two remain distinguishable.
	rec.results = nil
	if _, ok := cache.Get(ctx, Key{KeyType: "session_id", ID: "absent", UseCase: "test::distrust", Tracked: true}); ok {
		t.Fatal("Get served an absent key")
	}
	if len(rec.results) != 1 || rec.results[0] != ResultMiss {
		t.Errorf("absent key recorded %v, want exactly [%s]", rec.results, ResultMiss)
	}
}

func TestGetAcceptsAnUntrackedEntryWithALongLifetime(t *testing.T) {
	// The guard is about resurrection after invalidation, which only applies to tracked
	// keys. An untracked key has no watermark to outlive, so a long lifetime is legitimate
	// and must still be served.
	client := newFakeClient()
	cache, err := New(Options[sessionIdentity]{
		Client: client, URNPrefix: testPrefix, TTL: time.Hour, Logger: quietLogger(),
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	key := Key{KeyType: "session_id", ID: "untracked", UseCase: "test::untracked"}
	want := sessionIdentity{SessionID: "s-1", CreatedAt: "2026-09-09T00:00:00Z"}

	payload, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := encodeEnvelope(time.Now(), 6*time.Hour, payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.SetEx(ctx, ValueKey(testPrefix, key), raw, 6*time.Hour); err != nil {
		t.Fatal(err)
	}

	got, ok := cache.Get(ctx, key)
	if !ok || got != want {
		t.Errorf("Get = %+v, %v; want %+v, true", got, ok, want)
	}
}

// ctxAwareClient returns the context's error, the way a real Redis client does. fakeClient
// ignores the context entirely, so a cancellation test using it never reaches Cache.fail
// at all -- and an assertion of the form "no ResultError was recorded" then passes because
// NOTHING was recorded. That is how the original cancellation test was green.
type ctxAwareClient struct{ fakeClient }

func (c *ctxAwareClient) MGet(ctx context.Context, keys ...string) ([][]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return c.fakeClient.MGet(ctx, keys...)
}

func (c *ctxAwareClient) SetEx(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return c.fakeClient.SetEx(ctx, key, value, ttl)
}

func newCtxAwareClient() *ctxAwareClient {
	return &ctxAwareClient{fakeClient{data: map[string][]byte{}, ttls: map[string]time.Duration{}}}
}

func TestGetReportsACancelledCallerSeparatelyFromACacheFault(t *testing.T) {
	// A client hanging up is not the cache breaking. Counting it as ResultError inflates the
	// cache's error rate exactly when a service is shedding load.
	rec := &recordingRecorder{}
	cache, err := New(Options[sessionIdentity]{
		Client: newCtxAwareClient(), URNPrefix: testPrefix, TTL: time.Hour, Logger: quietLogger(), Recorder: rec,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, ok := cache.Get(ctx, Key{KeyType: "kt", ID: "id", UseCase: "test::cancel"}); ok {
		t.Fatal("Get returned a value for a cancelled context")
	}
	for _, r := range rec.results {
		if r == ResultError {
			t.Error("a cancelled caller was recorded as a cache error")
		}
	}
}

// upperCodec is a deliberately non-JSON codec: it stores the value as a bare uppercased
// string. Nothing about that shape is reachable through encoding/json, so a test using it
// cannot pass unless Cache really routes both directions through Options.Codec.
type upperCodec struct{}

func (upperCodec) Marshal(v string) ([]byte, error) { return []byte(strings.ToUpper(v)), nil }
func (upperCodec) Unmarshal(b []byte, v *string) error {
	*v = strings.ToLower(string(b))
	return nil
}

func TestPutAndGetBothRouteThroughTheConfiguredCodec(t *testing.T) {
	client := newFakeClient()
	cache, err := New(Options[string]{
		Client: client, URNPrefix: testPrefix, TTL: time.Hour, Codec: upperCodec{},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	key := Key{KeyType: "session_id", ID: "s1", UseCase: "Svc::m"}
	ctx := context.Background()

	if err := cache.Put(ctx, key, "hello"); err != nil {
		t.Fatalf("Put: %v", err)
	}

	// Assert the bytes on the wire, not just the round trip. A round trip alone passes for
	// the default JSON codec too, so it would prove nothing about the seam.
	var env struct {
		Payload string `json:"payload"`
	}
	if err := json.Unmarshal(client.get(ValueKey(testPrefix, key)), &env); err != nil {
		t.Fatalf("stored value is not an envelope: %v", err)
	}
	if env.Payload != "HELLO" {
		t.Fatalf("payload = %q, want %q (Put did not use the codec)", env.Payload, "HELLO")
	}

	got, ok := cache.Get(ctx, key)
	if !ok {
		t.Fatal("Get missed a value it had just written")
	}
	if got != "hello" {
		t.Fatalf("Get = %q, want %q (Get did not use the codec)", got, "hello")
	}
}

func TestOmittingTheCodecKeepsTheJSONDefault(t *testing.T) {
	client := newFakeClient()
	cache, err := New(Options[sessionIdentity]{Client: client, URNPrefix: testPrefix, TTL: time.Hour})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	key := Key{KeyType: "session_id", ID: "s1", UseCase: "Svc::m"}
	if err := cache.Put(context.Background(), key, sessionIdentity{SessionID: "abc"}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	var env struct {
		Payload string `json:"payload"`
	}
	if err := json.Unmarshal(client.get(ValueKey(testPrefix, key)), &env); err != nil {
		t.Fatalf("stored value is not an envelope: %v", err)
	}
	if !strings.Contains(env.Payload, `"session_id"`) && !strings.Contains(env.Payload, `"SessionID"`) {
		t.Fatalf("payload %q does not look like encoding/json output", env.Payload)
	}
}

func TestGetDoesNotCountACallerDeadlineAsACacheError(t *testing.T) {
	// Get derives a child context with c.timeout, so a caller deadline that fires first
	// surfaces as context.DeadlineExceeded -- indistinguishable from the cache's own
	// timeout by the error alone. Classifying on the CALLER's context is what separates
	// "the client gave up" from "Redis did not answer".
	rec := &recordingRecorder{}
	cache, err := New(Options[sessionIdentity]{
		Client: newCtxAwareClient(), URNPrefix: testPrefix, TTL: time.Hour, Logger: quietLogger(), Recorder: rec,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()

	if _, ok := cache.Get(ctx, Key{KeyType: "kt", ID: "id", UseCase: "test::deadline"}); ok {
		t.Fatal("Get returned a value for an expired caller deadline")
	}
	for _, r := range rec.results {
		if r == ResultError {
			t.Error("an expired caller deadline was recorded as a cache error")
		}
	}
	if len(rec.errs) != 0 {
		t.Errorf("caller termination reached the error series: %v", rec.errs)
	}
}

func TestGetKeepsACancelledCallerOutOfTheErrorSeries(t *testing.T) {
	// The docstring said cancellation is separated out so it does not inflate the error
	// rate, but recordErr still ran -- so galileo_gcache_errors_total counted every one.
	rec := &recordingRecorder{}
	cache, err := New(Options[sessionIdentity]{
		Client: newCtxAwareClient(), URNPrefix: testPrefix, TTL: time.Hour, Logger: quietLogger(), Recorder: rec,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	cache.Get(ctx, Key{KeyType: "kt", ID: "id", UseCase: "test::cancel-errs"})

	if len(rec.errs) != 0 {
		t.Errorf("a cancelled caller reached the error series: %v", rec.errs)
	}
	var sawCancelled bool
	for _, r := range rec.results {
		if r == ResultCancelled {
			sawCancelled = true
		}
	}
	if !sawCancelled {
		t.Error("a cancelled caller was not recorded as ResultCancelled")
	}
}

func TestInvalidateKeepsCallerTerminationOutOfTheErrorSeries(t *testing.T) {
	// Get and Put both exempt caller termination from galileo_gcache_errors_total.
	// Invalidate derives the same child timeout and so has the same ambiguity, but it was
	// counting both a hangup and an elapsed caller deadline as cache faults -- and it is
	// the path a shutdown cancels mid-flight, so the spike lands exactly when a service is
	// already degraded.
	for _, tc := range []struct {
		name string
		ctx  func() (context.Context, context.CancelFunc)
	}{
		{"cancelled", func() (context.Context, context.CancelFunc) {
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			return ctx, func() {}
		}},
		{"deadline elapsed", func() (context.Context, context.CancelFunc) {
			return context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := &recordingRecorder{}
			cache, err := New(Options[sessionIdentity]{
				Client: newCtxAwareClient(), URNPrefix: testPrefix, TTL: time.Hour,
				Logger: quietLogger(), Recorder: rec,
			})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := tc.ctx()
			defer cancel()

			// The error is still returned -- Invalidate's caller decides what to do with it.
			if err := cache.Invalidate(ctx, "session_id", "sid-1", 0); err == nil {
				t.Fatal("Invalidate returned nil for a terminated caller context")
			}
			if len(rec.errs) != 0 {
				t.Errorf("caller termination reached the error series: %v", rec.errs)
			}
		})
	}
}

func TestGetDistrustsALifetimeWhoseSubtractionOverflows(t *testing.T) {
	// Both timestamps fit in int64; their difference does not. The overflowed difference is
	// NEGATIVE, so a subtract-then-compare guard passes it instead of failing it -- and the
	// entry declares roughly 570 million years, which is exactly what the guard exists to
	// distrust. No watermark, because an expired watermark is the case it covers.
	client := newFakeClient()
	cache := newTestCache(t, client)
	key := Key{KeyType: "session_id", ID: "sid-overflow", UseCase: "test::overflow", Tracked: true}

	raw := fmt.Sprintf(
		`{"version":1,"createdAtMs":%d,"expiresAtMs":%d,"encoding":"utf8","payload":"{}"}`,
		int64(-9e18), int64(9e18))
	client.data[ValueKey(testPrefix, key)] = []byte(raw)

	if _, ok := cache.Get(context.Background(), key); ok {
		t.Error("served a tracked entry whose declared lifetime overflowed the guard")
	}
}

func TestNewRejectsATTLThatRoundsToZeroMilliseconds(t *testing.T) {
	// Caught at construction, not on every Put. Unchecked, rueidisClient.SetEx rejects the
	// rounded-to-zero PX on every write and encodeEnvelope stamps expiresAtMs == createdAtMs,
	// which reads as already expired -- both far from the cause.
	_, err := New(Options[sessionIdentity]{
		Client: newFakeClient(), URNPrefix: testPrefix, TTL: 500 * time.Microsecond,
	})
	if err == nil {
		t.Fatal("New accepted a sub-millisecond TTL")
	}
	if !strings.Contains(err.Error(), "rounds to zero milliseconds") {
		t.Errorf("error did not name the cause: %v", err)
	}

	// One millisecond is the smallest expressible TTL and must still be accepted.
	if _, err := New(Options[sessionIdentity]{
		Client: newFakeClient(), URNPrefix: testPrefix, TTL: time.Millisecond,
	}); err != nil {
		t.Errorf("New rejected a 1ms TTL: %v", err)
	}
}

func TestGetTreatsANonPositiveExpiryAsExpired(t *testing.T) {
	// An `expiresAtMs > 0` sign test used to skip these and serve the entry. Both other
	// readers compare the raw value -- Python's redis_cache.py does `expires_at_ms <= now`
	// with no sign check -- so they call it expired, and Go was the only client answering
	// hit. Untracked, so no watermark can mask the difference.
	for _, exp := range []string{"0", "-1"} {
		client := newFakeClient()
		cache := newTestCache(t, client)
		key := Key{KeyType: "session_id", ID: "sid-exp" + exp, UseCase: "test::nonpositive-expiry"}

		raw := fmt.Sprintf(
			`{"version":1,"createdAtMs":1757000000000,"expiresAtMs":%s,"encoding":"utf8","payload":"{\"session_id\":\"s\"}"}`,
			exp)
		client.data[ValueKey(testPrefix, key)] = []byte(raw)

		if _, ok := cache.Get(context.Background(), key); ok {
			t.Errorf("expiresAtMs=%s was served; Python and TypeScript both call it expired", exp)
		}
	}
}

func TestInvalidateRejectsAFutureBufferThatOverflowsTheGuard(t *testing.T) {
	// futureBuffer+c.ttl overflows time.Duration for a large buffer, and an overflowed sum
	// is NEGATIVE -- so a summing guard inverted and accepted precisely what it refuses.
	// Before the fix, time.Duration(math.MaxInt64) returned nil on this cache and wrote a
	// watermark dated 2318 while the watermark key itself still expired in 4h, so every
	// entry written in those 4h would resurrect.
	client := newFakeClient()
	cache, err := New(Options[sessionIdentity]{
		Client: client, URNPrefix: testPrefix, TTL: 2 * time.Hour, Logger: quietLogger(),
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := cache.Invalidate(context.Background(), "session_id", "sid-1", time.Duration(math.MaxInt64)); err == nil {
		t.Error("Invalidate accepted a futureBuffer that overflows futureBuffer+TTL")
	}
	if got := client.get(WatermarkKey(testPrefix, "session_id", "sid-1")); got != nil {
		t.Errorf("a rejected Invalidate still wrote a watermark: %s", got)
	}

	// The largest buffer that genuinely fits must still be accepted, so the guard is not
	// simply refusing everything: watermarkTTL - ttl = 2h here.
	if err := cache.Invalidate(context.Background(), "session_id", "sid-2", 2*time.Hour); err != nil {
		t.Errorf("Invalidate rejected the largest valid buffer: %v", err)
	}
}

func TestWatermarkOutranksTheDeclaredLifetimeGuard(t *testing.T) {
	// The two tracked guards can both fire, and the order decides what an operator sees.
	// The declared-lifetime guard used to run first, so a long-lifetime entry reported
	// ResultDistrusted even when the watermark was corrupt or said it was stale -- masking
	// a data-integrity signal and a working invalidation respectively. All four outcomes
	// are still a miss; what is pinned here is the CLASSIFICATION.
	//
	// No test covered the combination before, which is how the ordering survived: the
	// distrust tests write no watermark and the watermark tests use a normal lifetime.
	build := func(t *testing.T, lifetime time.Duration, watermark string) (*recordingRecorder, bool) {
		t.Helper()
		client := newFakeClient()
		rec := &recordingRecorder{}
		cache, err := New(Options[sessionIdentity]{
			Client: client, URNPrefix: testPrefix, TTL: time.Hour, Logger: quietLogger(), Recorder: rec,
		})
		if err != nil {
			t.Fatal(err)
		}
		key := Key{KeyType: "session_id", ID: "ordering", UseCase: "test::ordering", Tracked: true}
		raw, err := encodeEnvelope(time.Now().Add(-30*time.Minute), lifetime, []byte(`{"session_id":"s"}`))
		if err != nil {
			t.Fatal(err)
		}
		client.data[ValueKey(testPrefix, key)] = raw
		if watermark != "" {
			client.data[WatermarkKey(testPrefix, "session_id", "ordering")] = []byte(watermark)
		}
		_, ok := cache.Get(context.Background(), key)
		return rec, ok
	}

	longLife, okLife := 6*time.Hour, time.Hour
	stale := strconv.FormatInt(time.Now().UnixMilli(), 10)

	for _, tc := range []struct {
		name      string
		lifetime  time.Duration
		watermark string
		want      Result
		wantErrs  int
	}{
		{"long lifetime, no watermark", longLife, "", ResultDistrusted, 0},
		{"long lifetime, corrupt watermark", longLife, "abc", ResultError, 1},
		{"long lifetime, stale watermark", longLife, stale, ResultStale, 0},
		{"ok lifetime, corrupt watermark", okLife, "abc", ResultError, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec, ok := build(t, tc.lifetime, tc.watermark)
			if ok {
				t.Fatal("Get served the entry; every case here must be a miss")
			}
			if len(rec.results) != 1 || rec.results[0] != tc.want {
				t.Errorf("recorded %v, want exactly [%s]", rec.results, tc.want)
			}
			if len(rec.errs) != tc.wantErrs {
				t.Errorf("recorded %d errors, want %d: %v", len(rec.errs), tc.wantErrs, rec.errs)
			}
		})
	}
}

func TestATrackedEntryCannotBeServedOlderThanTheWatermarkLifetime(t *testing.T) {
	// gcache's Python client grew an explicit AGE check on the read path -- a tracked entry
	// older than the 4h watermark is distrusted regardless of what it declares. Go has no
	// such check and does not need one: the bound is IMPLIED by the two guards it already
	// has, and this test pins the implication so neither can be loosened quietly.
	//
	// Serving a tracked entry requires both
	//     now < expiresAtMs                              (the expiry guard)
	//     expiresAtMs - createdAtMs <= watermarkTTL       (the declared-lifetime guard)
	// and substituting the second into the first gives now - createdAtMs < watermarkTTL.
	// So age > watermarkTTL is unreachable rather than unchecked.
	//
	// Python needs the explicit check because of legacy pickle entries, which carry no
	// expiresAtMs at all, so neither guard applies there. Go is covered more strongly:
	// decodeEnvelope returns ErrPickleEnvelope and Get reports a plain miss, so it never
	// reads one. Asserted below rather than argued.
	base := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	key := Key{KeyType: "session_id", ID: "age", UseCase: "test::age", Tracked: true}

	serve := func(t *testing.T, age, declared time.Duration) (bool, []Result) {
		t.Helper()
		client := newFakeClient()
		rec := &recordingRecorder{}
		cache, err := New(Options[sessionIdentity]{
			Client: client, URNPrefix: testPrefix, TTL: time.Hour, Logger: quietLogger(),
			Recorder: rec, now: func() time.Time { return base },
		})
		if err != nil {
			t.Fatal(err)
		}
		created := base.Add(-age)
		raw := fmt.Sprintf(
			`{"version":1,"createdAtMs":%d,"expiresAtMs":%d,"encoding":"utf8","payload":"{\"session_id\":\"s\"}"}`,
			created.UnixMilli(), created.Add(declared).UnixMilli())
		client.data[ValueKey(testPrefix, key)] = []byte(raw)
		_, ok := cache.Get(context.Background(), key)
		return ok, rec.results
	}

	for _, tc := range []struct {
		name          string
		age, declared time.Duration
		wantServed    bool
		wantResult    Result
	}{
		// Old and declaring a long life: the declared-lifetime guard refuses it.
		{"5h old, 6h declared", 5 * time.Hour, 6 * time.Hour, false, ResultDistrusted},
		// Old but declaring a short life: it is necessarily EXPIRED, which is the step
		// that makes a separate age check redundant.
		{"5h old, 3h30m declared", 5 * time.Hour, 3*time.Hour + 30*time.Minute, false, ResultMiss},
		{"4h6m old, 4h declared", 4*time.Hour + 6*time.Minute, 4 * time.Hour, false, ResultMiss},
		// Inside both bounds, so served -- and necessarily younger than watermarkTTL.
		{"1h old, 3h30m declared", time.Hour, 3*time.Hour + 30*time.Minute, true, ResultHit},
		{"3h54m old, 4h declared", 3*time.Hour + 54*time.Minute, 4 * time.Hour, true, ResultHit},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ok, results := serve(t, tc.age, tc.declared)
			if ok != tc.wantServed {
				t.Errorf("served = %v, want %v", ok, tc.wantServed)
			}
			if len(results) != 1 || results[0] != tc.wantResult {
				t.Errorf("recorded %v, want exactly [%s]", results, tc.wantResult)
			}
			if ok && tc.age >= watermarkTTL {
				t.Errorf("INVARIANT BROKEN: served an entry %s old, at or past watermarkTTL (%s)",
					tc.age, watermarkTTL)
			}
		})
	}

	// The pickle case Python's age check exists for: unreadable here, so never served.
	client := newFakeClient()
	rec := &recordingRecorder{}
	cache := newTestCache(t, client)
	cache.recorder = rec
	client.data[ValueKey(testPrefix, key)] = []byte{0x80, 0x04, 0x95, 0x01}
	if _, ok := cache.Get(context.Background(), key); ok {
		t.Error("served a pickle entry, which carries no timestamps for either guard to check")
	}
}
