package redislive

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/rueidis"

	"github.com/rungalileo/gcache/go"
)

// Live-Redis coverage for the rueidis adapter.
//
// The adapter is the one part of gcache that cannot be faked: every bug it has had -- a
// swallowed per-key error, a truncated TTL -- lived in how it translates the Client contract
// onto real Redis commands, which a fake Client by definition cannot show.
//
// These live in their own package on purpose. Gazelle emits one go_test per Go package, so
// keeping them beside cache_test.go would have made the whole package's hermetic tests
// require a running Redis -- `bazel test //libs/go/gcache/...` would then fail on any machine
// without one. //libs/go/gcache:gcache_test stays hermetic; this target is the live one.
//
// It hard-fails rather than skips when Redis is down. A silent skip would restore the
// coverage gap this file exists to close, and "the live test passed" would mean nothing.
//
// This is a pure Go test, so it cannot use the redislite fixture the Python suite starts.
// It reads GALILEO_REDIS_HOST/PORT and defaults to localhost:6379; the go workflow
// supplies a Redis service container for exactly this reason.
//
// Every key is namespaced per run and deleted afterwards -- never FLUSHDB, since api test
// shards share db 0.

func liveClient(t *testing.T) (rueidis.Client, func()) {
	t.Helper()
	// This suite builds a static-password client, like the one under test. On an IAM
	// deployment that would connect unauthenticated and fail with an opaque auth error, so
	// say which it is. Anything but an explicit false counts as requested, so a typo fails
	// loudly here rather than turning into a connection mystery.
	switch strings.ToLower(strings.TrimSpace(os.Getenv("GALILEO_REDIS_USE_ELASTICACHE_IAM"))) {
	case "", "0", "f", "false", "n", "no", "off":
	default:
		t.Fatal("GALILEO_REDIS_USE_ELASTICACHE_IAM is set, and this client supports only a " +
			"static password; point the suite at a password or unauthenticated Redis")
	}
	host := os.Getenv("GALILEO_REDIS_HOST")
	if host == "" {
		host = "localhost"
	}
	port := os.Getenv("GALILEO_REDIS_PORT")
	if port == "" {
		port = "6379"
	}
	opt := rueidis.ClientOption{
		InitAddress: []string{host + ":" + port},
		Password:    os.Getenv("GALILEO_REDIS_PASSWORD"),
	}
	// Honour GALILEO_REDIS_PROTOCOL, the way gcachectl and the Python half of the suite
	// both do. Without it this suite dialled plain text and hard-failed on a TLS endpoint
	// while gcachectl connected, and the rediss branch of NewRueidisClient had no live
	// coverage at all. Same "rediss anywhere in the string" convention as RueidisOptions.
	if strings.Contains(os.Getenv("GALILEO_REDIS_PROTOCOL"), "rediss") {
		opt.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	c, err := rueidis.NewClient(opt)
	if err != nil {
		t.Fatalf("redis at %s:%s is required for this test: %v", host, port, err)
	}
	return c, c.Close
}

// liveAdapter builds the adapter under test over a live connection, plus a unique key
// prefix and a cleanup that removes only this test's keys.
func liveAdapter(t *testing.T, disableCSC bool) (gcache.Client, string) {
	t.Helper()
	raw, closeRaw := liveClient(t)
	t.Cleanup(closeRaw)

	prefix := fmt.Sprintf("gcache-test:%s:%d:", t.Name(), time.Now().UnixNano())
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		// Two patterns, matching the urn_prefix fixture in tests/test_cross_language.py: an
		// invalidation-tracked key is wrapped in a hash tag, so it starts with "{" and
		// prefix+"*" never sees it. Missing those left a 4h watermark behind on every run.
		//
		// SCAN, not KEYS: KEYS walks the whole keyspace and blocks the server, and the api
		// test shards share db 0 with this suite.
		for _, pattern := range []string{prefix + "*", "{" + prefix + "*"} {
			for cursor := uint64(0); ; {
				entry, err := raw.Do(ctx, raw.B().Scan().Cursor(cursor).Match(pattern).Count(500).Build()).AsScanEntry()
				if err != nil {
					t.Logf("cleanup scan for %q failed, leaving keys behind: %v", pattern, err)
					break
				}
				if len(entry.Elements) > 0 {
					if err := raw.Do(ctx, raw.B().Del().Key(entry.Elements...).Build()).Error(); err != nil {
						t.Logf("cleanup delete failed: %v", err)
					}
				}
				if entry.Cursor == 0 {
					break
				}
				cursor = entry.Cursor
			}
		}
	})

	client, closeClient, err := gcache.NewRueidisClient(gcache.RueidisOptions{
		Host: firstNonEmpty(os.Getenv("GALILEO_REDIS_HOST"), "localhost"),
		Port: firstNonEmpty(os.Getenv("GALILEO_REDIS_PORT"), "6379"),
		// Match Python's default: it reads a password only if one is configured.
		Password:               os.Getenv("GALILEO_REDIS_PASSWORD"),
		Protocol:               os.Getenv("GALILEO_REDIS_PROTOCOL"),
		DisableClientSideCache: disableCSC,
	})
	if err != nil {
		t.Fatalf("NewRueidisClient: %v", err)
	}
	t.Cleanup(closeClient)
	return client, prefix
}

// sessionIdentity is the shape ingest-service caches, so the round trip exercises a real
// value rather than a string.
type sessionIdentity struct {
	SessionID string `json:"session_id"`
	CreatedAt string `json:"created_at"`
}

// quietLogger keeps the expected degradation warnings out of the test output.
func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func TestRueidisSetExAndMGetRoundTripInOrder(t *testing.T) {
	for _, csc := range []bool{false, true} {
		t.Run(fmt.Sprintf("client_side_cache=%v", csc), func(t *testing.T) {
			r, prefix := liveAdapter(t, !csc)
			ctx := context.Background()

			// One hash tag for the whole set, so this is a single slot in cluster mode
			// too -- the same property the real key grammar relies on.
			a, b := prefix+"{x}a", prefix+"{x}b"
			if err := r.SetEx(ctx, a, []byte("A"), time.Minute); err != nil {
				t.Fatalf("SetEx: %v", err)
			}

			// The middle key is absent: MGet must report it as a nil slot without
			// shifting the keys around it, since Cache.Get indexes positionally.
			got, err := r.MGet(ctx, a, prefix+"{x}missing", b)
			if err != nil {
				t.Fatalf("MGet: %v", err)
			}
			if len(got) != 3 {
				t.Fatalf("MGet returned %d values for 3 keys", len(got))
			}
			if string(got[0]) != "A" {
				t.Errorf("value at index 0 = %q, want %q", got[0], "A")
			}
			if got[1] != nil {
				t.Errorf("absent key at index 1 = %q, want nil", got[1])
			}
			if got[2] != nil {
				t.Errorf("unwritten key at index 2 = %q, want nil", got[2])
			}
		})
	}
}

func TestRueidisSetExPreservesBinaryValues(t *testing.T) {
	// Envelopes are bytes, and a base64 payload is not the only thing that lands here --
	// a value must survive verbatim rather than through a UTF-8 round trip.
	r, prefix := liveAdapter(t, true)
	ctx := context.Background()
	want := []byte{0x00, 0xff, 0x80, '{', '"', '}'}

	key := prefix + "binary"
	if err := r.SetEx(ctx, key, want, time.Minute); err != nil {
		t.Fatalf("SetEx: %v", err)
	}
	got, err := r.MGet(ctx, key)
	if err != nil {
		t.Fatalf("MGet: %v", err)
	}
	if string(got[0]) != string(want) {
		t.Errorf("round-tripped %v, want %v", got[0], want)
	}
}

func TestRueidisSetExHonoursASubSecondTTL(t *testing.T) {
	// SETEX takes whole seconds, so this TTL used to truncate to `SETEX key 0` -- which
	// Redis rejects outright, turning a short-lived write into a hard error.
	r, prefix := liveAdapter(t, true)
	ctx := context.Background()

	key := prefix + "subsecond"
	if err := r.SetEx(ctx, key, []byte("v"), 700*time.Millisecond); err != nil {
		t.Fatalf("SetEx with a sub-second TTL: %v", err)
	}

	raw, closeRaw := liveClient(t)
	defer closeRaw()
	ms, err := raw.Do(ctx, raw.B().Pttl().Key(key).Build()).AsInt64()
	if err != nil {
		t.Fatalf("PTTL: %v", err)
	}
	// Not rounded up to a whole second, and not the -1 that means "no expiry".
	if ms <= 0 || ms > 700 {
		t.Errorf("PTTL = %dms, want 0 < ttl <= 700", ms)
	}
}

func TestRueidisSetExRejectsATTLThatRoundsToZero(t *testing.T) {
	r, prefix := liveAdapter(t, true)
	if err := r.SetEx(context.Background(), prefix+"zero", []byte("v"), 100*time.Microsecond); err == nil {
		t.Error("SetEx accepted a TTL below one millisecond")
	}
}

func TestRueidisMGetReportsAPerKeyFailureInsteadOfNil(t *testing.T) {
	// The bug this covers: AsBytes' error was swallowed and the slot left nil. Nil means
	// "absent", and Cache.Get reads an absent watermark as "never invalidated" -- so a
	// wrong-type watermark would serve an entry someone had invalidated. Failing the
	// batch degrades the lookup to a miss instead, which is the safe direction.
	//
	// Client-side caching must be ON to reach it, and that is the default. The two paths
	// differ (verified against Redis 8): plain MGET reports a wrong-type key as a nil
	// element, indistinguishable from absent, while MGetCache reports it non-nil and lets
	// AsBytes fail with WRONGTYPE. So the swallow was only reachable on the path every
	// service actually runs.
	r, prefix := liveAdapter(t, false)
	ctx := context.Background()

	raw, closeRaw := liveClient(t)
	defer closeRaw()

	// A list is not a string, so reading it as bytes fails.
	key := prefix + "wrongtype"
	if err := raw.Do(ctx, raw.B().Rpush().Key(key).Element("x").Build()).Error(); err != nil {
		t.Fatalf("RPUSH: %v", err)
	}
	if err := raw.Do(ctx, raw.B().Expire().Key(key).Seconds(60).Build()).Error(); err != nil {
		t.Fatalf("EXPIRE: %v", err)
	}

	got, err := r.MGet(ctx, key)
	if err == nil {
		t.Fatalf("MGet returned %v with no error for a non-string value", got)
	}
	if got != nil {
		t.Errorf("MGet returned values alongside an error: %v", got)
	}
}

func TestRueidisMGetOnNoKeys(t *testing.T) {
	r, _ := liveAdapter(t, true)
	got, err := r.MGet(context.Background())
	if err != nil || got != nil {
		t.Errorf("MGet() = %v, %v; want nil, nil", got, err)
	}
}

func TestNewRueidisClientRequiresAHost(t *testing.T) {
	if _, _, err := gcache.NewRueidisClient(gcache.RueidisOptions{}); err == nil {
		t.Error("NewRueidisClient accepted an empty Host")
	}
}

func TestNewRueidisClientReportsAnUnreachableEndpoint(t *testing.T) {
	// Port 1 is reserved and never listening; the constructor must fail rather than hand
	// back a client that errors on first use.
	_, _, err := gcache.NewRueidisClient(gcache.RueidisOptions{Host: "127.0.0.1", Port: "1"})
	if err == nil {
		t.Error("NewRueidisClient accepted an unreachable endpoint")
	}
}

// gapRequiredByInclusiveStaleness separates an Invalidate from the write that follows it.
//
// PROTOCOL, not flake, and named so it does not read as a stray sleep someone can delete.
// isStale is INCLUSIVE (watermarkMs >= createdAtMs), so a value written in the same
// millisecond as the preceding invalidation is deliberately suppressed -- loosening that
// would let a write which raced an invalidation survive. Without this gap the re-Put below
// lands on the watermark's own millisecond and reads as stale: it failed 4 runs in 5.
//
// The consumer relies on the same rule for the opposite reason: ingest-service's
// fetchSessionByIDCached (added by #2165) deliberately does NOT re-prime after dropping a
// stale entry, because its write would land in the watermark's millisecond and be
// swallowed.
const gapRequiredByInclusiveStaleness = 2 * time.Millisecond

// waitForCacheState polls Get until it reports the wanted hit/miss, or fails.
//
// Required because of the client-side cache, and only because of it. With CSC on this
// client holds the value and the absent watermark locally, so ANY write -- its own or
// another client's -- becomes visible when the RESP3 invalidation push propagates, which
// is asynchronous. Measured against the live container: 300us to 7.2ms, and a read issued
// in the same instant as an invalidation served the stale value 6 times in 10.
//
// So a single immediate assertion is flaky, and asserting the stale read would pin a race
// as the contract. Polling keeps the real guarantee testable: cscTTL (30s) is the bound
// when a push is never delivered, so a deployment whose Redis does not support tracking
// never converges and this fails.
func waitForCacheState(t *testing.T, cache *gcache.Cache[sessionIdentity], key gcache.Key, wantHit bool, what string) {
	t.Helper()
	ctx := context.Background()
	deadline := time.Now().Add(5 * time.Second)
	for {
		got, ok := cache.Get(ctx, key)
		if ok == wantHit {
			if wantHit && got == (sessionIdentity{}) {
				t.Errorf("%s: hit returned a zero value", what)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Errorf("%s: Get still reports hit=%v after 5s, want hit=%v", what, ok, wantHit)
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestCacheOverLiveRedisRoundTripsAndInvalidates(t *testing.T) {
	// The adapter under the real Cache, end to end: the two together are what a service
	// runs, and the watermark comparison is only meaningful against real key expiry.
	//
	// Run for BOTH client-side-cache settings, and invalidate from a SECOND client.
	//
	// client_side_cache=true is the one that matters, and it is what every service runs --
	// DisableClientSideCache defaults to false. It was previously untested here: this test
	// and gcachectl both disabled it, so nothing in the package invalidated an entry on the
	// transport production actually uses. The second client is what makes it meaningful;
	// invalidating through the same connection exercises a different path.
	for _, csc := range []bool{false, true} {
		t.Run(fmt.Sprintf("client_side_cache=%v", csc), func(t *testing.T) {
			r, prefix := liveAdapter(t, !csc)
			urn := prefix + "urn:galileo:test"
			cache, err := gcache.New(gcache.Options[sessionIdentity]{
				Client: r, URNPrefix: urn, TTL: time.Minute, Logger: quietLogger(),
			})
			if err != nil {
				t.Fatal(err)
			}
			// A second client on its own connection, standing in for another pod.
			other, _ := liveAdapter(t, !csc)
			otherCache, err := gcache.New(gcache.Options[sessionIdentity]{
				Client: other, URNPrefix: urn, TTL: time.Minute, Logger: quietLogger(),
			})
			if err != nil {
				t.Fatal(err)
			}

			ctx := context.Background()
			key := gcache.Key{KeyType: "session_id", ID: "abc", UseCase: "test::live", Tracked: true}
			want := sessionIdentity{SessionID: "s-1", CreatedAt: "2026-09-09T00:00:00Z"}

			if err := cache.Put(ctx, key, want); err != nil {
				t.Fatalf("Put: %v", err)
			}
			// Populates this client's local cache with the value and the absent watermark.
			got, ok := cache.Get(ctx, key)
			if !ok || got != want {
				t.Fatalf("Get = %+v, %v; want %+v, true", got, ok, want)
			}

			// Another pod invalidates; this client must stop serving it.
			if err := otherCache.Invalidate(ctx, key.KeyType, key.ID, 0); err != nil {
				t.Fatalf("Invalidate from the second client: %v", err)
			}
			waitForCacheState(t, cache, key, false, "after another client invalidated")

			// And its own Invalidate must take effect too.
			time.Sleep(gapRequiredByInclusiveStaleness)
			if err := cache.Put(ctx, key, want); err != nil {
				t.Fatalf("Put (second round): %v", err)
			}
			waitForCacheState(t, cache, key, true, "after re-writing the entry")

			if err := cache.Invalidate(ctx, key.KeyType, key.ID, 0); err != nil {
				t.Fatalf("Invalidate: %v", err)
			}
			waitForCacheState(t, cache, key, false, "after its own Invalidate")
		})
	}
}
