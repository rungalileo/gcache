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

// Live-Redis coverage for the rueidis adapter: the one part of gcache that cannot be faked,
// since its bugs (a swallowed per-key error, a truncated TTL) live in how it translates the
// Client contract onto real Redis commands. Hard-fails rather than skips when Redis is down; keys are namespaced per run and deleted after -- never FLUSHDB, since api test shards share db 0.

func liveClient(t *testing.T) (rueidis.Client, func()) {
	t.Helper()
	// This suite builds a static-password client. On an IAM deployment that would connect
	// unauthenticated and fail with an opaque auth error, so fail loudly here instead.
	// Anything but an explicit false counts as requested, so a typo can't hide as a connection mystery.
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
	// Honour GALILEO_REDIS_PROTOCOL, as gcachectl and Python both do. Without it this suite
	// dialled plain text and hard-failed on a TLS endpoint, leaving the rediss branch of
	// NewRueidisClient with no live coverage. Same "rediss anywhere in the string" convention.
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
		// Two patterns: a tracked key is wrapped in a hash tag, so it starts with "{" and
		// prefix+"*" never sees it -- missing that left a 4h watermark behind every run.
		// SCAN, not KEYS: KEYS walks the whole keyspace and blocks the server.
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
	// The bug this covers: AsBytes' error was swallowed and the slot left nil, which reads
	// as "absent" and would let an invalidated (wrong-type) watermark be served. Only
	// reachable with client-side caching ON (the default): plain MGET reports a wrong-type key as nil, but MGetCache lets AsBytes fail with WRONGTYPE.
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
// PROTOCOL, not flake: isStale is INCLUSIVE, so without this gap the re-Put below lands on
// the watermark's own millisecond and reads as stale -- measured, it failed 4 runs in 5.
const gapRequiredByInclusiveStaleness = 2 * time.Millisecond

// waitForCacheState polls Get until it reports the wanted hit/miss, or fails. Required
// because RESP3 invalidation pushes are ASYNCHRONOUS: measured, a read issued the same
// instant as an invalidation served stale 6/10 times (300us-7.2ms); cscTTL bounds a lost push.
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
	// The adapter under the real Cache, end to end, since the watermark comparison is only
	// meaningful against real key expiry. Runs for BOTH client-side-cache settings and
	// invalidates from a SECOND client: client_side_cache=true (the default) was previously untested here, since this test and gcachectl both disabled it.
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
