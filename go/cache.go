package gcache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

// watermarkTTL is how long an invalidation watermark lives.
//
// It is 4h because that is what Python's gcache hardcodes (WATERMARK_TTL_SECONDS). The
// value is not ours to choose: both languages write watermarks into the same key space, so
// they must agree.
const watermarkTTL = 4 * time.Hour

// maxEntryTTL caps how long a cached value may live.
//
// A value must never outlive the watermark that invalidated it. If it did, the watermark
// would expire, the value would stop looking stale, and the invalidated entry would
// resurrect. Keeping entry TTL at or under watermarkTTL makes that impossible for an
// invalidation with no future buffer; with one, Invalidate enforces a futureBuffer+TTL
// bound against its OWN ttl, which is not sufficient when another cache writes the same
// key type with a longer TTL -- see the read guard in Get for what survives that.
//
// This binds writes made through this package. Python's gcache has no equivalent ceiling,
// so it can write an entry that outlives the watermark invalidating it -- but Get no longer
// trusts one: a tracked entry declaring a lifetime longer than watermarkTTL is read as a
// miss. So this is enforced on read as well as write, rather than relying on every language
// configuring a shared key type under 4h.
const maxEntryTTL = watermarkTTL

// defaultTimeout bounds every Redis call. Short on purpose: a cache must degrade to a miss
// long before it threatens the caller's own deadline (orbit AGENTS.md #11), and it matches
// the 300ms the ingest service already uses for Redis.
const defaultTimeout = 300 * time.Millisecond

// Result classifies a lookup, for metrics.
type Result string

const (
	ResultHit   Result = "hit"   // value found and fresh
	ResultMiss  Result = "miss"  // no value stored
	ResultStale Result = "stale" // value found but superseded by a watermark
	ResultError Result = "error" // Redis or decode failure; served as a miss
	// ResultCancelled is the caller's own context ending, not a cache fault. Kept out of
	// ResultError so a client disconnect -- or load shedding, when these arrive in bulk --
	// does not read as the cache breaking.
	ResultCancelled Result = "cancelled"
	// ResultDistrusted is a TRACKED entry that declares a lifetime longer than the
	// watermark's, so it could have outlived the watermark that suppressed it.
	//
	// Separate from ResultMiss, which an empty cache also records, because otherwise no
	// metric can show this guard firing -- and separate from ResultStale, which means a
	// watermark said so. The cures differ: ResultStale points an operator at an
	// invalidation, while this points at a use case's TTL configured in another language
	// and another repository, which is undiagnosable from a miss count.
	ResultDistrusted Result = "distrusted"
)

// Recorder receives cache events. It is an interface rather than a Prometheus dependency
// so this library stays dependency-light; services implement it with promauto, the same
// way ingest-service implements otterstats.Recorder for its otter caches.
//
// A nil Recorder is fine -- all calls are skipped.
type Recorder interface {
	RecordResult(useCase string, result Result)
	RecordLatency(useCase, op string, d time.Duration)
	RecordError(useCase, op string, err error)
}

// Client is the narrow slice of Redis this package needs.
//
// Kept deliberately small so tests can fake it and so the concrete client stays swappable:
// rueidis (whose RESP3 client-side caching is verified working against Galileo's
// ElastiCache) today, go-redis if a deployment's Redis rejects CLIENT TRACKING.
type Client interface {
	// MGet fetches keys in one round trip. The result has one entry per requested key, in
	// order; a nil entry means that key was absent.
	MGet(ctx context.Context, keys ...string) ([][]byte, error)
	// SetEx writes a value with an expiry.
	SetEx(ctx context.Context, key string, value []byte, ttl time.Duration) error
}

// Codec converts a value to and from the bytes carried in the envelope payload.
//
// Exists so a payload whose schema is shared with another language can be a generated
// type rather than a struct hand-written on each side -- which is how the six
// cross-language divergences found in review got there. See libs/proto/cache.
//
// Unmarshal takes *V so a codec can populate a pointer receiver (every generated
// protobuf message) without allocating in the caller.
type Codec[V any] interface {
	Marshal(V) ([]byte, error)
	Unmarshal([]byte, *V) error
}

// jsonCodec is the default, so a general-purpose cache still takes a plain struct
// without its caller taking on protobuf.
type jsonCodec[V any] struct{}

func (jsonCodec[V]) Marshal(v V) ([]byte, error)    { return json.Marshal(v) }
func (jsonCodec[V]) Unmarshal(b []byte, v *V) error { return json.Unmarshal(b, v) }

// Options configures a Cache. It carries the value type so Codec can be typed; New
// infers V, so callers name the type once:
// gcache.New(gcache.Options[*cachev1.SessionIdentity]{...}).
type Options[V any] struct {
	// Client is the Redis client. Required.
	Client Client
	// URNPrefix namespaces every key. Must match the Python side's
	// galileo_gcache_urn_prefix() -- "urn:galileo:<customer_name>" -- or the two languages
	// write into disjoint key spaces and never see each other's entries.
	URNPrefix string
	// TTL is how long written values live. Required, and must be <= 4h (see maxEntryTTL).
	TTL time.Duration
	// Timeout bounds each Redis call. Defaults to 300ms.
	Timeout time.Duration
	// Recorder receives cache events. Optional.
	Recorder Recorder
	// Codec serializes the value. Defaults to encoding/json; use protocodec.ProtoJSON
	// for a payload shared with another language. The envelope records the framing, not
	// the payload's encoding, so a mismatch is undetected -- it yields a zero value.
	Codec Codec[V]
	// Logger receives degradation warnings. Defaults to slog.Default().
	Logger *slog.Logger
	// now is a test seam for the clock.
	now func() time.Time
}

// Cache is a Redis-backed cache speaking the gcache wire protocol.
//
// Reads never fail: any Redis, decode or protocol problem is recorded and reported as a
// miss, so a degraded cache slows the caller down but cannot break it. Writes return their
// error, because a caller that fails to publish or invalidate an entry usually wants to
// know.
type Cache[V any] struct {
	client    Client
	urnPrefix string
	ttl       time.Duration
	timeout   time.Duration
	recorder  Recorder
	log       *slog.Logger
	now       func() time.Time
	codec     Codec[V]
}

// New builds a Cache.
func New[V any](o Options[V]) (*Cache[V], error) {
	switch {
	case o.Client == nil:
		return nil, errors.New("gcache: Options.Client is required")
	case o.URNPrefix == "":
		// An empty prefix still produces syntactically valid keys, in a key space no
		// Python or TypeScript client will ever look in. That failure is invisible: the
		// cache writes fine and simply never hits.
		return nil, errors.New("gcache: Options.URNPrefix is required (\"urn:galileo:<customer_name>\")")
	case strings.ContainsAny(o.URNPrefix, "{}#?"):
		// These are the grammar's own delimiters. A prefix carrying one produces a key
		// that parses as a different key -- and in cluster mode a stray brace moves the
		// hash tag, splitting a value from its watermark across slots and making the
		// single MGET illegal.
		return nil, fmt.Errorf("gcache: Options.URNPrefix %q must not contain any of {}#?", o.URNPrefix)
	case o.TTL <= 0:
		return nil, errors.New("gcache: Options.TTL is required")
	case o.TTL.Milliseconds() == 0:
		// The wire resolution is milliseconds, so a sub-millisecond TTL cannot be
		// expressed. Left unchecked it fails far from its cause: rueidisClient.SetEx
		// rejects the rounded-to-zero PX on EVERY Put, and encodeEnvelope stamps
		// expiresAtMs equal to createdAtMs, which every reader -- including this one --
		// treats as already expired. Refuse at construction instead.
		return nil, fmt.Errorf(
			"gcache: Options.TTL %s rounds to zero milliseconds; the wire resolution is milliseconds", o.TTL)
	case o.TTL > maxEntryTTL:
		// Refuse rather than silently clamp: a caller asking for a longer TTL has a
		// resurrection bug in mind that they should see, not have quietly papered over.
		return nil, fmt.Errorf(
			"gcache: Options.TTL %s exceeds the %s watermark lifetime; an entry outliving its "+
				"watermark would resurrect after invalidation", o.TTL, maxEntryTTL)
	}
	if o.Timeout <= 0 {
		o.Timeout = defaultTimeout
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	if o.now == nil {
		o.now = time.Now
	}
	if o.Codec == nil {
		o.Codec = jsonCodec[V]{}
	}
	return &Cache[V]{
		client: o.Client, urnPrefix: o.URNPrefix, ttl: o.TTL,
		timeout: o.Timeout, recorder: o.Recorder, log: o.Logger, now: o.now,
		codec: o.Codec,
	}, nil
}

// Get returns the cached value for key.
//
// It returns ok=false for a genuine miss, a stale entry, or any failure -- deliberately
// there is no error return, so a caller cannot accidentally propagate a cache problem into
// its own request path.
func (c *Cache[V]) Get(ctx context.Context, key Key) (value V, ok bool) {
	var zero V
	if err := key.Validate(); err != nil {
		c.fail(ctx, key.UseCase, "get", err)
		return zero, false
	}

	callerCtx := ctx
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	valueKey := ValueKey(c.urnPrefix, key)
	keys := []string{valueKey}
	if key.Tracked {
		// One round trip for both. They share a hash tag, so this is legal in cluster mode.
		keys = append(keys, WatermarkKey(c.urnPrefix, key.KeyType, key.ID))
	}

	start := c.now()
	vals, err := c.client.MGet(ctx, keys...)
	c.observe(key.UseCase, "get", start)
	if err != nil {
		c.fail(callerCtx, key.UseCase, "get", err)
		return zero, false
	}
	if len(vals) != len(keys) {
		c.fail(callerCtx, key.UseCase, "get", fmt.Errorf("MGet returned %d values for %d keys", len(vals), len(keys)))
		return zero, false
	}
	if vals[0] == nil {
		c.record(key.UseCase, ResultMiss)
		return zero, false
	}

	payload, createdAtMs, expiresAtMs, err := decodeEnvelope(vals[0])
	if err != nil {
		// A pickle value is an expected condition, not corruption: a Python caller wrote
		// it under the default envelope. Report it as a plain miss and let the value be
		// rewritten, without the noise of an error.
		if errors.Is(err, ErrPickleEnvelope) {
			c.record(key.UseCase, ResultMiss)
			return zero, false
		}
		c.fail(callerCtx, key.UseCase, "decode", err)
		return zero, false
	}

	// Honour the writer's own expiry, not just Redis's TTL. The two can disagree -- Python
	// has no ceiling on a use case's TTL, and any writer can PERSIST a key -- and the
	// TypeScript reader already treats a past expiresAtMs as a miss, so ignoring it here
	// would make one key answer differently per language.
	//
	// No sign test. There used to be an `expiresAtMs > 0` guard, which skipped a zero or
	// negative expiry and served the entry. Both other readers compare the raw value --
	// Python's redis_cache.py does `expires_at_ms <= now_ms` with no sign check -- so they
	// call such an entry expired where Go called it a hit. decodeEnvelope rejects an ABSENT
	// expiresAtMs, so a non-positive one is a value some writer really stored rather than a
	// field Go had to default; there is no "0 means never expires" convention to honour.
	if c.now().UnixMilli() >= expiresAtMs {
		c.record(key.UseCase, ResultMiss)
		return zero, false
	}

	// Distrust a TRACKED entry that declares a lifetime longer than the watermark's.
	//
	// The expiry check above does NOT close the resurrection gap on its own, and an earlier
	// version of this code claimed it did. Concretely: Python writes with a 6h TTL at t=0,
	// someone invalidates at t=1h so the watermark lives to t=5h, and Go reads at t=5h30m.
	// The key is present, the declared expiry is still in the future, and the watermark has
	// expired -- so the invalidated value is served as a hit. The expiry only helps when the
	// declared lifetime is SHORTER than the window the watermark covers.
	//
	// Go's own writes always pass this, because New caps TTL at watermarkTTL. It is Python's
	// per-use-case TTL, which has no ceiling, that can produce such an entry.
	//
	// The bound is watermarkTTL because that is all a reader knows. Invalidate's real
	// ceiling is tighter -- futureBuffer+TTL -- so an entry whose lifetime sits between
	// watermarkTTL-futureBuffer and watermarkTTL passes here and can still outlive a
	// buffered watermark. Closing that would mean reading futureBuffer off the wire, which
	// the watermark does not carry.
	//
	// Invalidate's own refusal does not close it either, and it is narrower than it looks:
	// it compares futureBuffer against the INVALIDATING cache's ttl, but a watermark covers
	// every use case under the key type. Two Go caches sharing a key type are enough -- a
	// 1h-TTL cache invalidating with a 3h buffer is accepted, and a 3h30m-TTL cache writing
	// inside that buffer produces exactly the entry above. So the residual gap is any
	// writer whose TTL exceeds the invalidator's, not just one that skips this client.
	//
	// Compared in float64 because the int64 subtraction overflows on a crafted pair that is
	// individually in range -- createdAtMs -9e18 with expiresAtMs 9e18 -- and an overflowed
	// difference comes out NEGATIVE, which passes this guard silently rather than failing
	// it. float64 cannot overflow here, and a 53-bit mantissa is far more precision than a
	// comparison against four hours of milliseconds needs. The float form also subsumes the
	// expiresAtMs > createdAtMs check it replaces: a non-positive difference is never
	// greater than the limit.
	//
	// Runs AFTER the watermark check, and that order is load-bearing for diagnosis. This
	// guard used to come first, so a tracked entry with a long declared lifetime reported
	// ResultDistrusted even when the watermark was unreadable (no ResultError and no
	// RecordError) or said the entry was genuinely stale (no ResultStale) -- measured, not
	// theorised. Every path still ended in a miss, so nothing was served wrongly. But the
	// watermark is direct evidence about THIS entry while the declared-lifetime bound is a
	// heuristic, and reporting the heuristic sent an operator to a use-case TTL when the
	// real answer was "someone invalidated it" or "this watermark is corrupt".
	if key.Tracked && vals[1] != nil {
		watermarkMs, err := parseWatermark(vals[1])
		if err != nil {
			// An unreadable watermark must not be treated as "no watermark" -- that would
			// serve an entry someone tried to invalidate. Fail to a miss instead.
			c.fail(callerCtx, key.UseCase, "watermark", err)
			return zero, false
		}
		if isStale(watermarkMs, createdAtMs) {
			c.record(key.UseCase, ResultStale)
			return zero, false
		}
	}

	if key.Tracked && float64(expiresAtMs)-float64(createdAtMs) > float64(watermarkTTL.Milliseconds()) {
		c.record(key.UseCase, ResultDistrusted)
		return zero, false
	}

	if err := c.codec.Unmarshal(payload, &value); err != nil {
		c.fail(callerCtx, key.UseCase, "unmarshal", err)
		return zero, false
	}
	c.record(key.UseCase, ResultHit)
	return value, true
}

// Put stores value under key.
func (c *Cache[V]) Put(ctx context.Context, key Key, value V) error {
	if err := key.Validate(); err != nil {
		return err
	}
	payload, err := c.codec.Marshal(value)
	if err != nil {
		return fmt.Errorf("gcache: marshaling value for %s: %w", key.UseCase, err)
	}
	raw, err := encodeEnvelope(c.now(), c.ttl, payload)
	if err != nil {
		return fmt.Errorf("gcache: encoding envelope for %s: %w", key.UseCase, err)
	}

	callerCtx := ctx
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	start := c.now()
	err = c.client.SetEx(ctx, ValueKey(c.urnPrefix, key), raw, c.ttl)
	c.observe(key.UseCase, "put", start)
	if err != nil {
		// Same rule as the read path: a caller that gave up is not a cache fault. The
		// error is still returned -- unlike Get, Put's caller decides what to do.
		if callerCtx.Err() == nil {
			c.recordErr(key.UseCase, "put", err)
		}
		return fmt.Errorf("gcache: writing %s: %w", key.UseCase, err)
	}
	return nil
}

// Invalidate marks every TRACKED entry under (keyType, id) stale, across every use case and
// every language's client.
//
// An untracked entry is unaffected: Get reads a watermark only when key.Tracked is set, so
// nothing on its read path consults one. Python behaves the same way for
// track_for_invalidation=False. Stated here because a caller reads this, not Key.Tracked.
//
// futureBuffer extends the watermark past now, which also suppresses write-back for that
// window -- use it when the underlying data is still settling and a read during the window
// could otherwise re-cache a value that is about to change again.
//
// That suppression is not durable, and the limit is worth knowing before relying on it. The
// watermark is written with a plain SET, in this client and in Python's alike, so a LATER
// invalidation carrying a smaller buffer lowers it: invalidate at t=0 with a 1h buffer, then
// again at t=10m with none, and the watermark is t+10m -- a write at t=20m is fresh and a
// tracked read serves it, though the first call asked for suppression until t+1h. Making the
// update monotonic would need a compare-and-set on the Client interface and the same change
// in Python, since a Go-only fix would just make the two clients disagree about one key.
func (c *Cache[V]) Invalidate(ctx context.Context, keyType, id string, futureBuffer time.Duration) error {
	if keyType == "" || id == "" {
		return errors.New("gcache: Invalidate requires both keyType and id")
	}
	if futureBuffer < 0 {
		// A watermark in the past suppresses only part of the key type -- anything written
		// after that instant stays fresh -- while the call still reports success. Every
		// other bad argument here is rejected; this one hid.
		return fmt.Errorf("gcache: futureBuffer %s is negative; it moves the watermark into the past", futureBuffer)
	}
	// The watermark must outlive every entry it suppresses, or the entry resurrects. An
	// entry written just before the buffer elapses lives until futureBuffer+TTL from now,
	// so that sum is the real ceiling -- the TTL check in New is this same invariant at
	// futureBuffer=0. Refuse rather than clamp: a caller asking for a longer buffer wants
	// suppression they would not actually get.
	//
	// c.ttl only bounds what THIS cache writes, and a watermark covers every use case under
	// the key type. A cache configured with a longer TTL can still write an entry inside
	// this buffer that outlives the watermark; Get's declared-lifetime guard catches it
	// only past watermarkTTL, so the span above it stays open. See that guard.
	//
	// Compared rather than summed: futureBuffer+c.ttl overflows time.Duration for a large
	// buffer, and an overflowed sum is NEGATIVE, so the guard inverted and accepted exactly
	// what it exists to refuse. time.Duration(math.MaxInt64) passed on a 2h-TTL cache and
	// wrote a watermark dated 2318 while the key itself still lived 4h. New caps c.ttl at
	// watermarkTTL, so watermarkTTL-c.ttl cannot underflow.
	if futureBuffer > watermarkTTL-c.ttl {
		return fmt.Errorf(
			"gcache: futureBuffer %s plus TTL %s exceeds the %s watermark lifetime; an entry "+
				"written inside the buffer would outlive the watermark and resurrect",
			futureBuffer, c.ttl, watermarkTTL)
	}

	callerCtx := ctx
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	expMs := c.now().Add(futureBuffer).UnixMilli()
	// Decimal ASCII, matching what Python's redis-py writes for an int.
	body := []byte(fmt.Sprintf("%d", expMs))

	// Invalidation is scoped to a key type, not a use case -- it clears every use case
	// under that id at once. Prefixing keeps the metric label one domain: key types are
	// bare names ("session_id") and use cases are qualified ("Service::method"), so an
	// unprefixed key type would read as just another use case in the same series.
	label := "invalidate:" + keyType

	start := c.now()
	err := c.client.SetEx(ctx, WatermarkKey(c.urnPrefix, keyType, id), body, watermarkTTL)
	c.observe(label, "invalidate", start)
	if err != nil {
		// Same rule as Get and Put: a caller that gave up is not a cache fault. Decided on
		// the CALLER's context rather than the error, because the timeout derived just
		// above makes a parent deadline surface as context.DeadlineExceeded too.
		if callerCtx.Err() == nil {
			c.recordErr(label, "invalidate", err)
		}
		return fmt.Errorf("gcache: invalidating %s:%s: %w", keyType, id, err)
	}
	return nil
}

func (c *Cache[V]) record(useCase string, r Result) {
	if c.recorder != nil {
		c.recorder.RecordResult(useCase, r)
	}
}

func (c *Cache[V]) observe(useCase, op string, start time.Time) {
	if c.recorder != nil {
		c.recorder.RecordLatency(useCase, op, c.now().Sub(start))
	}
}

func (c *Cache[V]) recordErr(useCase, op string, err error) {
	if c.recorder != nil {
		c.recorder.RecordError(useCase, op, err)
	}
}

// fail records a degradation and logs it. Read paths funnel through here so that "the
// cache broke" is always observable even though the caller only sees a miss.
//
// Caller termination is separated out and reaches ResultCancelled ONLY. It is not a cache
// fault -- the client hung up, or its own deadline fired -- and counting it as one inflates
// the error rate exactly when a service is shedding load.
//
// It is decided on the CALLER's context, not on the error. Get derives a child with
// c.timeout, so a parent deadline that fires first surfaces as context.DeadlineExceeded --
// byte-identical to the cache's own timeout. Inspecting the error alone cannot tell a
// client that gave up from a Redis that did not answer.
//
// Everything else logs at Debug, not Warn. The Recorder already counts every one of these,
// which is what alerting should read; the log line is for a human already looking. At the
// ingest hot path's ~13 lookups/sec/pod, a Redis outage at Warn would emit 13 lines per
// second per pod for the duration, drowning the logs that explain it.
func (c *Cache[V]) fail(callerCtx context.Context, useCase, op string, err error) {
	if callerCtx != nil && callerCtx.Err() != nil {
		c.record(useCase, ResultCancelled)
		return
	}
	c.record(useCase, ResultError)
	c.recordErr(useCase, op, err)
	c.log.Debug("gcache degraded to a miss", "use_case", useCase, "op", op, "error", err)
}
