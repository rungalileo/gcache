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

// cscTTL bounds how long rueidis' client-side cache may hold an entry locally. RESP3
// CLIENT TRACKING invalidates ASYNCHRONOUSLY: measured, a stale read served the
// pre-invalidation value 6/10 times in a 300us-7.2ms window (0/10 at >=1ms), even on the invalidating client's own next Get. Set DisableClientSideCache for read-your-writes.
const cscTTL = 30 * time.Second

// RueidisOptions configures the rueidis-backed Client.
type RueidisOptions struct {
	// Host and Port of the Redis endpoint.
	Host string
	Port string
	// Password, if the endpoint requires AUTH. STATIC credentials only: ElastiCache IAM
	// auth (GALILEO_REDIS_USE_ELASTICACHE_IAM) is NOT supported here, since its ~15min
	// token would expire under a long-lived client. Callers must REFUSE when that flag is set rather than pass an empty Password, which builds an unauthenticated client with an opaque connect error.
	Password string
	// Protocol follows the Galileo-wide convention: "rediss" anywhere in the string
	// enables TLS. Cluster mode needs nothing here -- see NewRueidisClient.
	Protocol string
	// TLSConfig replaces the default TLS config when Protocol enables TLS. The default
	// verifies the server against the system roots with TLS 1.2 or later. Pass one to
	// trust a private CA or to apply the caller's verification policy. It is ignored
	// without TLS, and cloned so the caller may reuse it.
	TLSConfig *tls.Config
	// DisableClientSideCache turns off RESP3 CLIENT TRACKING. Galileo's ElastiCache supports
	// it (verified against Redis 7.2.4, which accepts OPTIN/OPTOUT/BCAST), but some managed
	// Redis offerings, such as Memorystore, reject the command (redis/rueidis#612).
	// NewRueidisClient then retries with the cache off, so this is needed only to opt out.
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

// NewRueidisClient builds a Client backed by rueidis. Cluster mode is not configurable:
// rueidis probes with CLUSTER SLOTS and picks cluster vs standalone itself. This dials the
// endpoint and errors when Redis is unreachable. The caller decides whether that is fatal and owns the returned closer.
func NewRueidisClient(o RueidisOptions) (Client, func(), error) {
	if o.Host == "" {
		return nil, nil, errors.New("gcache: RueidisOptions.Host is required")
	}
	port := o.Port
	if port == "" {
		port = "6379"
	}
	addr := net.JoinHostPort(o.Host, port)

	c, err := newRueidis(clientOption(o, addr))
	if errors.Is(err, rueidis.ErrNoCache) && !o.DisableClientSideCache {
		o.DisableClientSideCache = true
		c, err = newRueidis(clientOption(o, addr))
	}
	if err != nil {
		return nil, nil, fmt.Errorf("gcache: connecting to redis at %s: %w", addr, err)
	}
	return &rueidisClient{c: c, cacheEnabled: !o.DisableClientSideCache, addr: addr}, c.Close, nil
}

// newRueidis is a seam so tests can simulate a server that rejects CLIENT TRACKING.
var newRueidis = rueidis.NewClient

// clientOption maps RueidisOptions onto rueidis' options, without dialing.
func clientOption(o RueidisOptions, addr string) rueidis.ClientOption {
	opt := rueidis.ClientOption{
		InitAddress:       []string{addr},
		Password:          o.Password,
		DisableCache:      o.DisableClientSideCache,
		CacheSizeEachConn: o.CacheSizeEachConn,
	}
	if strings.Contains(o.Protocol, "rediss") {
		// No ServerName: Go fills SNI from the dial address via rueidis' tls.Dialer.
		// Pinning it to o.Host would be wrong in cluster mode, where rueidis dials the node
		// addresses CLUSTER SLOTS returns.
		if o.TLSConfig != nil {
			opt.TLSConfig = o.TLSConfig.Clone()
		} else {
			opt.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
		}
	}
	return opt
}

// span opens a CLIENT-kind span for one Redis round trip: Redis speaks its own wire
// protocol, so no HTTP auto-instrumentation or Go OTel instrumentor reaches it. A no-op
// without an active parent, since cache reads run on detached paths with no root span to attach to.
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

// MGet fetches keys in one round trip, returning results in the order requested. With
// client-side caching on, it consults the local copy first, kept honest by RESP3
// invalidation pushes. The value key and its watermark share a hash tag, so this stays one command even in cluster mode.
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
			// Report the failure rather than leave the slot nil: nil means "absent", and
			// swallowing this would serve an entry someone had invalidated. Verified
			// against Redis 8: plain MGET reports a wrong-type key as nil (silent miss); only MGetCache lets AsBytes fail WRONGTYPE, so only this path needs the check.
			err = fmt.Errorf("gcache: reading %s: %w", k, aErr)
			return nil, err
		}
		out[i] = b
	}
	return out, nil
}

// SetEx writes a value with an expiry, using SET ... PX rather than SETEX: SETEX takes
// whole seconds, so a sub-second TTL truncates to `SETEX key 0`, which Redis rejects.
// Milliseconds round-trip the caller's TTL exactly; the shared protocol is the expiry, not the command.
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
