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

// watermarkTTL is how long an invalidation watermark lives. It is 4h because that is what
// Python's gcache hardcodes (WATERMARK_TTL_SECONDS); both languages write into the same key
// space and must agree.
const watermarkTTL = 4 * time.Hour

// maxEntryTTL caps how long a cached value may live: it must never outlive the watermark
// that invalidated it, or the invalidated entry resurrects once the watermark expires.
// Python has no such ceiling, so Get also enforces this on read, not just on write here.
const maxEntryTTL = watermarkTTL

// defaultTimeout bounds every Redis call. 300ms, matching what Galileo's ingest service
// already uses for Redis, so a cache degrades to a miss well before the caller's own
// deadline.
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
	// ResultDistrusted is a TRACKED entry declaring a lifetime longer than the watermark's,
	// so it could outlive the watermark that suppressed it. Separate from ResultMiss/Stale
	// because the fix is a use case's TTL in another language, not an invalidation.
	ResultDistrusted Result = "distrusted"
)

// Recorder receives cache events, as an interface rather than a Prometheus dependency so
// this library stays dependency-light; services implement it with promauto, as
// a service does with its own metrics adapter. A nil Recorder is fine -- calls are skipped.
type Recorder interface {
	RecordResult(useCase string, result Result)
	RecordLatency(useCase, op string, d time.Duration)
	RecordError(useCase, op string, err error)
}

// Client is the narrow slice of Redis this package needs, kept small so tests can fake it
// and the concrete client stays swappable: rueidis today (RESP3 client-side caching
// verified against Galileo's ElastiCache), go-redis if a deployment's Redis rejects it.
type Client interface {
	// MGet fetches keys in one round trip. The result has one entry per requested key, in
	// order; a nil entry means that key was absent.
	MGet(ctx context.Context, keys ...string) ([][]byte, error)
	// SetEx writes a value with an expiry.
	SetEx(ctx context.Context, key string, value []byte, ttl time.Duration) error
}

// Codec converts a value to and from the bytes carried in the envelope payload. Exists so a
// shared-schema payload can be a generated type rather than a hand-written struct -- six
// cross-language divergences found in review came from the latter. See subpackage protocodec.
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

// Cache is a Redis-backed cache speaking the gcache wire protocol. Reads never fail: any
// Redis, decode, or protocol problem is recorded and reported as a miss, so a degraded
// cache slows the caller down but cannot break it. Writes return their error.
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
		// Python or Python client will ever look in. That failure is invisible: the
		// cache writes fine and simply never hits.
		return nil, errors.New("gcache: Options.URNPrefix is required (\"urn:galileo:<customer_name>\")")
	case strings.ContainsAny(o.URNPrefix, "{}#?"):
		// These are the grammar's own delimiters. A prefix carrying one produces a key that
		// parses as a different key, and in cluster mode a stray brace can move the hash
		// tag, splitting a value from its watermark across slots and breaking the MGET.
		return nil, fmt.Errorf("gcache: Options.URNPrefix %q must not contain any of {}#?", o.URNPrefix)
	case o.TTL <= 0:
		return nil, errors.New("gcache: Options.TTL is required")
	case o.TTL.Milliseconds() == 0:
		// The wire resolution is milliseconds; unchecked, a sub-millisecond TTL fails far
		// from its cause -- SetEx rejects the rounded-to-zero PX on every Put, and
		// encodeEnvelope stamps expiresAtMs==createdAtMs, read as already expired.
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

// Get returns the cached value for key. It returns ok=false for a genuine miss, a stale
// entry, or any failure -- deliberately there is no error return, so a caller cannot
// propagate a cache problem into its own request path.
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

	// Honour the writer's own expiry, not just Redis's TTL -- Python has no TTL ceiling and
	// any writer can PERSIST a key. No sign test: both other readers compare the raw value
	// with no sign check, and decodeEnvelope already rejects an absent expiresAtMs.
	if c.now().UnixMilli() >= expiresAtMs {
		c.record(key.UseCase, ResultMiss)
		return zero, false
	}

	// Distrust a TRACKED entry declaring a lifetime longer than the watermark's: the expiry
	// check alone does not close the resurrection gap, since Python's per-use-case TTL has
	// no ceiling. Runs AFTER the watermark check below so diagnosis blames the real cause.
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
// language. futureBuffer suppresses writes during a settling window, but is NOT durable: a
// later invalidation with a smaller buffer LOWERS the watermark (plain SET, not monotonic).
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
	// The watermark must outlive every entry it suppresses, so futureBuffer+TTL is the real
	// ceiling. Compared rather than summed: the sum overflows time.Duration and comes out
	// NEGATIVE -- time.Duration(math.MaxInt64) once passed on a 2h-TTL cache this way.
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

	// Invalidation is scoped to a key type, not a use case. Prefixing keeps the metric
	// label one domain: key types are bare names ("session_id"), use cases are qualified
	// ("Service::method"), and an unprefixed key type would collide with the latter.
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

// fail records a degradation and logs it, so a broken cache stays observable though the
// caller only sees a miss. Caller termination alone reaches ResultCancelled, decided on
// the CALLER's context since Get's own timeout looks identical. Logged at Debug, not Warn: ingest's ~13 lookups/sec/pod would flood the logs at Warn during an outage.
func (c *Cache[V]) fail(callerCtx context.Context, useCase, op string, err error) {
	if callerCtx != nil && callerCtx.Err() != nil {
		c.record(useCase, ResultCancelled)
		return
	}
	c.record(useCase, ResultError)
	c.recordErr(useCase, op, err)
	c.log.Debug("gcache degraded to a miss", "use_case", useCase, "op", op, "error", err)
}
