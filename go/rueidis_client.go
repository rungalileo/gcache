package gcache

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/redis/rueidis"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// tracerName identifies the spans this client emits.
const tracerName = "github.com/rungalileo/gcache/go"

// cscTTL bounds how long rueidis' client-side cache may hold an entry locally.
//
// It is not the primary freshness mechanism -- with RESP3 CLIENT TRACKING the server
// pushes an invalidation when a key changes -- but it is not the only staleness bound
// either, and an earlier version of this comment claimed it was.
//
// The push is ASYNCHRONOUS, so there is a propagation window in normal operation:
// measured against the live container, an invalidation became visible 300us-7.2ms after
// Redis accepted the write, and a cross-client read inside that window served the
// pre-invalidation value 6 times in 10. At >=1ms it was 0 in 10. This is not the
// dropped-connection case; it is ordinary operation.
//
// It applies to the INVALIDATING client's own next Get as well, not just another pod's:
// Get MGETs the value and the watermark together, so both land in the local cache, and
// Invalidate's SETEX does not evict the caller's own cached watermark any faster than
// anyone else's. So this path is eventually consistent, not read-your-writes.
//
// Acceptable here because a stale hit is a slowdown rather than a wrong answer: the
// consumer's self-heal fails the primary-key lookup on a stale identity, drops the entry
// and re-reads (fetchSessionByIDCached in ingest-service, added by #2165 -- named by PR
// rather than by line, since it is not in this tree). A caller who needs read-your-writes must set DisableClientSideCache,
// which removes the window at the cost of the ~1ms L2 round trip.
//
// The TTL remains the bound for a push that is never delivered at all. Kept short for
// that reason -- the round trip it saves is ~1ms, so there is little to gain from holding
// entries longer.
const cscTTL = 30 * time.Second

// RueidisOptions configures the rueidis-backed Client.
type RueidisOptions struct {
	// Host and Port of the Redis endpoint.
	Host string
	Port string
	// Password, if the endpoint requires AUTH.
	//
	// STATIC credentials only. There is no CredentialProvider hook here, so a deployment
	// using ElastiCache IAM auth (GALILEO_REDIS_USE_ELASTICACHE_IAM, which Galileo's Python
	// Redis config honours via an ElastiCacheIAMProvider) is NOT supported: IAM issues
	// a short-lived token, ~15 minutes, so a value read once at construction would expire
	// under a long-lived client. Supporting it means a rueidis AuthCredentialsFn plus an
	// AWS sigv4 signer, which is a dependency this package deliberately does not carry.
	//
	// Callers that resolve the endpoint from the environment must therefore REFUSE when
	// that flag is set rather than passing an empty Password, which would build an
	// unauthenticated client and fail at connect with an opaque auth error. gcachectl and
	// the live test both do this; a service adopting this client needs the same check.
	Password string
	// Protocol follows the Galileo-wide convention: "rediss" anywhere in the string
	// enables TLS.
	//
	// Cluster mode needs nothing here -- see NewRueidisClient.
	Protocol string
	// DisableClientSideCache turns off RESP3 CLIENT TRACKING.
	//
	// Galileo's ElastiCache supports tracking (verified against rc0: Redis 7.2.4 accepts
	// CLIENT TRACKING in OPTIN, OPTOUT and BCAST modes), but some managed Redis offerings
	// reject the command outright -- see redis/rueidis#612. Set this when targeting one of
	// those; the cache then works purely against L2.
	DisableClientSideCache bool
	// CacheSizeEachConn bounds the client-side cache per connection. Zero uses the
	// rueidis default.
	CacheSizeEachConn int
}

// rueidisClient adapts rueidis to the narrow Client interface.
type rueidisClient struct {
	c            rueidis.Client
	cacheEnabled bool
	addr         string
}

// NewRueidisClient builds a Client backed by rueidis.
//
// Cluster mode is deliberately not configurable: rueidis probes the endpoint with CLUSTER
// SLOTS and picks the cluster or standalone implementation from the answer, so passing the
// "cluster" token from the protocol string buys nothing. (ShuffleInit only reorders
// InitAddress, a no-op for the single address we pass, and ForceSingleClient would defeat
// cluster mode rather than select it.) The key grammar keeps a value and its watermark
// under one hash tag precisely so this works either way.
//
// This dials the endpoint, so it returns an error when Redis is down. Do NOT treat that as
// fatal: log it and run without a cache, the way initSessionIdentityCache does. Failing
// startup on it would turn a Redis outage during a rollout into every new pod crash-looping
// -- the opposite of the fail-open contract the rest of the package keeps.
//
// The caller owns the returned closer and should call it during shutdown.
func NewRueidisClient(o RueidisOptions) (Client, func(), error) {
	if o.Host == "" {
		return nil, nil, errors.New("gcache: RueidisOptions.Host is required")
	}
	port := o.Port
	if port == "" {
		port = "6379"
	}
	addr := net.JoinHostPort(o.Host, port)

	opt := rueidis.ClientOption{
		InitAddress:       []string{addr},
		Password:          o.Password,
		DisableCache:      o.DisableClientSideCache,
		CacheSizeEachConn: o.CacheSizeEachConn,
	}
	if strings.Contains(o.Protocol, "rediss") {
		// No ServerName: Go fills SNI from the dial address, and rueidis dials through a
		// tls.Dialer. Pinning it to o.Host would be wrong in cluster mode, where rueidis
		// dials the node addresses CLUSTER SLOTS returns and every node would then be
		// presented the configuration endpoint's name. session_redis.go does the same.
		opt.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}

	c, err := rueidis.NewClient(opt)
	if err != nil {
		return nil, nil, fmt.Errorf("gcache: connecting to redis at %s: %w", addr, err)
	}
	return &rueidisClient{c: c, cacheEnabled: !o.DisableClientSideCache, addr: addr}, c.Close, nil
}

// span opens a CLIENT-kind span for one Redis round trip, following the Galileo
// convention that every network hop is instrumented. Redis speaks its own wire protocol,
// so no HTTP
// auto-instrumentation reaches it and there is no Go OTel instrumentor for rueidis.
//
// Like tracing.StartSpan, this is a no-op without an active parent: cache reads run on
// detached paths (a background flush, a consumer with no root span), and minting a
// single-span trace per Redis call there inflates span volume without giving anyone a
// trace to follow it back from.
func (r *rueidisClient) span(ctx context.Context, op string, keys int) (context.Context, func(error)) {
	if !trace.SpanContextFromContext(ctx).IsValid() {
		return ctx, func(error) {}
	}
	ctx, sp := otel.Tracer(tracerName).Start(ctx, "redis "+op,
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("db.system", "redis"),
			attribute.String("db.operation", op),
			attribute.String("server.address", r.addr),
			attribute.Int("db.redis.key_count", keys),
		),
	)
	return ctx, func(err error) {
		if err != nil {
			sp.RecordError(err)
			sp.SetStatus(codes.Error, err.Error())
		}
		sp.End()
	}
}

// MGet fetches keys in one round trip, returning results in the order requested.
//
// When client-side caching is on this consults the local copy first; RESP3 invalidation
// pushes keep it honest. Because the value key and its watermark share a hash tag, they
// land in one slot and rueidis issues a single command for them even in cluster mode.
func (r *rueidisClient) MGet(ctx context.Context, keys ...string) (out [][]byte, err error) {
	if len(keys) == 0 {
		return nil, nil
	}

	op := "MGET"
	if r.cacheEnabled {
		op = "MGET (cached)"
	}
	ctx, end := r.span(ctx, op, len(keys))
	defer func() { end(err) }()

	var msgs map[string]rueidis.RedisMessage
	if r.cacheEnabled {
		msgs, err = rueidis.MGetCache(r.c, ctx, cscTTL, keys)
	} else {
		msgs, err = rueidis.MGet(r.c, ctx, keys)
	}
	if err != nil {
		return nil, err
	}

	// MGetCache returns a map; restore the caller's ordering.
	out = make([][]byte, len(keys))
	for i, k := range keys {
		msg, ok := msgs[k]
		if !ok || msg.IsNil() {
			continue
		}
		b, aErr := msg.AsBytes()
		if aErr != nil {
			// Report the failure rather than leaving the slot nil. Nil means "absent",
			// and Cache.Get reads an absent watermark as "never invalidated" -- so
			// swallowing this would serve an entry someone had invalidated, defeating
			// the fail-closed watermark check. Failing the batch degrades the whole
			// lookup to a miss, which is the safe direction.
			//
			// Only the MGetCache path gets here. Verified against Redis 8: plain MGET
			// reports a wrong-type key as a nil element, which is indistinguishable from
			// absent and so stays a silent miss; MGetCache reports it non-nil and lets
			// AsBytes fail with WRONGTYPE. Nothing in either language writes a non-string
			// to these keys, so the residual gap on the DisableClientSideCache path is
			// theoretical -- and not closable without a second round trip per key.
			err = fmt.Errorf("gcache: reading %s: %w", k, aErr)
			return nil, err
		}
		out[i] = b
	}
	return out, nil
}

// SetEx writes a value with an expiry.
//
// SET ... PX, not SETEX: SETEX takes whole seconds, so a sub-second TTL truncates to
// `SETEX key 0`, which Redis rejects ("invalid expire time"). Milliseconds also round-trip
// the caller's TTL exactly. What the protocol shares with Python is the expiry itself, not
// the command that sets it.
func (r *rueidisClient) SetEx(ctx context.Context, key string, value []byte, ttl time.Duration) (err error) {
	ms := ttl.Milliseconds()
	if ms <= 0 {
		return fmt.Errorf("gcache: TTL %s rounds to zero milliseconds", ttl)
	}

	ctx, end := r.span(ctx, "SET", 1)
	defer func() { end(err) }()

	cmd := r.c.B().Set().Key(key).Value(rueidis.BinaryString(value)).PxMilliseconds(ms).Build()
	err = r.c.Do(ctx, cmd).Error()
	return err
}
