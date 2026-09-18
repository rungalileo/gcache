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

// watermarkTTL is how long an invalidation watermark lives. 5h, matching Python's
// WATERMARK_TTL_SECONDS: both languages write into the same key space and must agree, and
// the shared conformance corpus pins this number and the two caps below in both.
//
// This comment said 4h for a while after the constant became 5h, in the one file whose whole
// premise is that the two clients agree on it -- which is why the corpus pin exists now
// rather than a comment asserting the agreement.
const watermarkTTL = 5 * time.Hour

// The resurrection invariant is `futureBuffer + entryTTL <= watermarkTTL`: a watermark must
// outlive every entry it suppresses, or the entry becomes readable again when the tombstone
// expires. Those two numbers are chosen by DIFFERENT parties -- the buffer by whoever
// invalidates, the TTL by each writer -- across every use case and both languages. So no
// single check can see both: an invalidate-time check must guess about writers it cannot
// see, and a write-time check must guess about invalidations that have not happened.
//
// Rather than guess, the sum is split into two caps that hold BY CONSTRUCTION:
//
//	maxEntryTTL + maxFutureBuffer <= watermarkTTL      (4h + 1h <= 5h)
//
// The watermark lifetime was raised from 4h to 5h rather than lowering the entry cap to 3h.
// The entry TTL is what consumers configure per use case, so capping it lower would break
// existing callers; the buffer is a settling window for replication lag, measured in seconds
// in practice and defaulting to zero, so a 1h ceiling costs nobody anything. The price is one
// extra hour of tombstone lifetime per invalidated key.
//
// Each is then enforced locally against a value its own caller owns -- Put against the TTL,
// Invalidate against the buffer -- and neither needs the other party's number. The previous
// bound here (`futureBuffer > watermarkTTL - c.ttl`) only covered entries THIS cache wrote;
// another cache, or the Python client, could still write a longer-lived entry under the same
// key type and resurrect past the watermark.
//
// Mirrored exactly in Python (constants.py) and pinned by the shared conformance corpus, so
// the two clients cannot drift on the numbers this contract rests on.
const maxEntryTTL = 4 * time.Hour

// maxFutureBuffer caps Invalidate's settling window. See maxEntryTTL for why this and the
// entry TTL are capped separately rather than checked as a sum.
const maxFutureBuffer = watermarkTTL - maxEntryTTL

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
	// ResultDistrusted is an entry no watermark can vouch for, in any of four ways: a
	// TRACKED entry declaring a lifetime longer than maxEntryTTL (4h -- NOT watermarkTTL,
	// which is 5h), a tracked entry stamped more than maxFutureBuffer ahead and so out of
	// every reachable watermark's range, a reversed envelope, or a payload the two clients
	// would decode differently. Separate from ResultMiss/Stale because the fix is a writer
	// somewhere else -- a use case's TTL, a clock, a serializer -- not an invalidation.
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
// Envelope is the framing a Cache writes. Reads never need it -- see Options.Envelope.
type Envelope int

const (
	// EnvelopeJSON is the cross-language JSON envelope: readable from redis-cli and
	// parseable by Redis's Lua cjson, at ~102 bytes of overhead. The default.
	EnvelopeJSON Envelope = iota
	// EnvelopePROTO is the binary envelope: 18 bytes of overhead, no base64, and opaque to
	// redis-cli, jq and cjson alike. Pair it with protocodec.Proto.
	EnvelopePROTO
)

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
	// Codec serializes the value. Defaults to encoding/json; use protocodec.Proto
	// for a payload shared with another language. The envelope records the framing, not
	// the payload's encoding, so a mismatch is undetected -- it yields a zero value.
	Codec Codec[V]
	// Envelope is the framing written. Defaults to EnvelopeJSON, which is what a caller
	// sharing entries with a JSON-envelope Python key needs. EnvelopePROTO stores the
	// payload raw in a binary envelope -- 69 bytes against 204 for a small message -- and
	// MUST match the Python key's `envelope=`, or the two write framings that the other
	// reads but never produces.
	//
	// Reads do not consult this: every framing identifies itself by first byte, so a reader
	// handles whatever the writer left. It only selects what THIS client writes.
	Envelope Envelope
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
	envelope  Envelope
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
			"gcache: Options.TTL %s exceeds the %s entry-TTL cap; paired with the %s buffer "+
				"ceiling that keeps buffer+TTL inside the %s watermark lifetime, so an entry "+
				"cannot outlive the watermark and resurrect after invalidation",
			o.TTL, maxEntryTTL, maxFutureBuffer, watermarkTTL)
	}
	// Reject an Envelope this client cannot write. Put branches on `== EnvelopePROTO` and
	// treats everything else as JSON, so an out-of-range value -- Envelope(99), or a zero
	// value from a future constant the caller's build does not have -- would SILENTLY write
	// the wrong framing. A reader sniffs, so it would even decode; the mismatch would only
	// show as a cache that writes one shape and a peer that expects another.
	switch o.Envelope {
	case EnvelopeJSON, EnvelopePROTO:
	default:
		return nil, fmt.Errorf(
			"gcache: Options.Envelope %d is not a supported framing (EnvelopeJSON or EnvelopePROTO)",
			o.Envelope)
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
		codec: o.Codec, envelope: o.Envelope,
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

	// PARSE the watermark here, but COMPARE it last. Python splits the two the same way, and
	// for the same reason: an unreadable watermark is an operational fault in its own right,
	// so it must be reported whichever envelope guard fires afterwards. Reading it late meant
	// a malformed entry with a corrupt watermark reported only the malformation, and the
	// corrupt key -- the one a rewrite cannot repair -- went unrecorded.
	//
	// Failing closed on it, rather than treating unreadable as "no watermark", which would
	// serve an entry someone tried to invalidate. Python fails closed by substituting a
	// suppress-everything sentinel and carrying on; the effect for the caller is the same
	// here, and one Result per read is the Go model.
	var watermarkMs int64
	haveWatermark := false
	if key.Tracked && vals[1] != nil {
		parsed, err := parseWatermark(vals[1])
		if err != nil {
			c.fail(callerCtx, key.UseCase, "watermark", err)
			return zero, false
		}
		watermarkMs, haveWatermark = parsed, true
	}

	// ENVELOPE INTEGRITY FIRST, then expiry, then the watermark -- the order Python uses, and
	// it decides which outcome a reader sees when several conditions hold at once. These two
	// guards used to sit below both, so a reversed envelope that had also expired was
	// recorded as ResultMiss here and as reversed_envelope_timestamps in Python. Same bytes,
	// two diagnoses, and the one that says "malformed" is the one worth having.
	//
	// A REVERSED envelope -- expires before created -- is malformed, and the lifetime guard
	// below cannot catch it: the difference is negative, so the `>` comparison is false and
	// it passes as a plausible entry.
	if expiresAtMs < createdAtMs {
		c.record(key.UseCase, ResultDistrusted)
		return zero, false
	}

	// A createdAt far enough in the FUTURE makes a tracked entry immune to invalidation,
	// which is not the clock skew this envelope tolerates elsewhere. Staleness is
	// `watermarkMs >= createdAtMs` and a watermark carries a real clock time, so a stamp
	// beyond every reachable watermark can never be suppressed -- the entry survives every
	// Invalidate call for its whole Redis TTL, while the expiry and lifetime guards both pass
	// because a future createdAt with a legal declared lifetime is a plausible entry.
	//
	// The bound is the exact frontier, not "not in the future". An invalidation issued NOW
	// writes a watermark of at most now+maxFutureBuffer, so an entry created at or before
	// that instant is still suppressible and one created after it is not. The hour of skew
	// tolerance is a consequence, not the reason: a zero-tolerance test would turn a
	// one-millisecond clock lead into a permanent miss-and-rewrite loop.
	if key.Tracked && createdAtMs > c.now().UnixMilli()+maxFutureBuffer.Milliseconds() {
		c.record(key.UseCase, ResultDistrusted)
		return zero, false
	}

	// maxEntryTTL, NOT watermarkTTL. Raising the watermark to 5h while the write cap stayed
	// at 4h opened an hour-wide band: an entry declaring a 4h30m lifetime passed this guard
	// even though New refuses to build a cache that could write one. The correct threshold is
	// watermarkTTL - maxFutureBuffer, which IS maxEntryTTL -- an entry created at C can be
	// suppressed by a watermark written as early as C-B, and that watermark dies at C+(W-B),
	// so past that age no watermark can still vouch for it.
	if key.Tracked && float64(expiresAtMs)-float64(createdAtMs) > float64(maxEntryTTL.Milliseconds()) {
		c.record(key.UseCase, ResultDistrusted)
		return zero, false
	}

	// Honour the writer's own expiry, not just Redis's TTL -- Python has no TTL ceiling and
	// any writer can PERSIST a key. No sign test: both other readers compare the raw value
	// with no sign check, and decodeEnvelope already rejects an absent expiresAtMs.
	if c.now().UnixMilli() >= expiresAtMs {
		c.record(key.UseCase, ResultMiss)
		return zero, false
	}

	if haveWatermark && isStale(watermarkMs, createdAtMs) {
		c.record(key.UseCase, ResultStale)
		return zero, false
	}

	// The same rule the write path enforces, asked on the way in -- encodeEnvelope stops THIS
	// client creating a divergent entry and says nothing about one already in Redis, written
	// by a Python pod with a custom Serializer or by any other writer sharing the key space.
	// Reading it is where the harm lands, and it is the harm with no symptom.
	//
	// Before the codec, not after: the question is about the stored TEXT, and Unmarshal has
	// already substituted U+FFFD by the time it returns. Distrusted rather than a decode
	// failure -- the entry is well-formed, it just cannot be agreed upon.
	if reason := loneSurrogateReason(string(payload)); reason != "" {
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
	var raw []byte
	if c.envelope == EnvelopePROTO {
		raw, err = encodeProtoEnvelope(c.now(), c.ttl, payload)
	} else {
		raw, err = encodeEnvelope(c.now(), c.ttl, payload)
	}
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
	// Against maxFutureBuffer, NOT watermarkTTL-c.ttl. The old form used this cache's own
	// TTL, so it protected only entries this cache wrote -- Invalidate covers every use case
	// and both languages, and a longer-lived entry written elsewhere under the same key type
	// escaped it entirely. The constant pairs with maxEntryTTL to make the sum safe for every
	// writer, not just this one.
	if futureBuffer > maxFutureBuffer {
		return fmt.Errorf(
			"gcache: futureBuffer %s exceeds the %s ceiling; with the %s entry-TTL cap that "+
				"keeps buffer+TTL inside the %s watermark lifetime, so an entry written inside "+
				"the buffer cannot outlive the watermark and resurrect",
			futureBuffer, maxFutureBuffer, maxEntryTTL, watermarkTTL)
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
