// Package dialcache provides explicitly enabled, layered caching with runtime
// rollout, request coalescing, invalidation, stale recovery and shadow validation.
package dialcache

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"
)

type entry[T any] struct {
	value      T
	insertedMS int64
	ttlMS      int64
	used       uint64
}
type flight[T any] struct {
	done      chan struct{}
	value     T
	err       error
	started   time.Duration
	followers int
}
type scope[T any] struct {
	live    bool
	memo    map[string]T
	flights map[string]*flight[T]
}
type scopeState[T any] struct {
	enabled bool
	owner   *scope[T]
}

type Cache[T any] struct {
	mu         sync.Mutex
	options    Options[T]
	local      map[string]entry[T]
	flights    map[string]*flight[T]
	sequence   uint64
	shadows    map[string]*shadowFlight
	registered map[string]bool
}

func New[T any](options Options[T]) *Cache[T] {
	if options.Clock == nil {
		options.Clock = newSystemClock()
	}
	if options.Codec == nil {
		options.Codec = JSONCodec[T]{}
	}
	if options.Logger == nil {
		options.Logger = defaultLogger{}
	}
	options.Logger = FailureIsolatedLogger(options.Logger)
	if !options.DisableCompression {
		config, err := ResolveCompressionConfig(options.Compression)
		if err != nil {
			panic(err)
		}
		options.Compression = &config
	}
	if options.Namespace == "" && !options.NamespaceSet {
		options.Namespace = "urn"
	}
	if strings.ContainsAny(options.Namespace, "{}") {
		panic("DialCache namespace contains a reserved delimiter")
	}
	if options.LocalCapacity < 0 || uint64(options.LocalCapacity) > MaxSafeInteger {
		panic("DialCache local capacity must be a nonnegative safe integer")
	}
	if options.LocalCapacity == 0 && !options.LocalCapacitySet {
		options.LocalCapacity = 10000
	}
	if options.RemoteReadTimeoutMS == 0 {
		options.RemoteReadTimeoutMS = 50
	}
	if options.RemoteReadTimeoutMS < 1 || options.RemoteReadTimeoutMS > MaxDeadlineMS {
		panic("invalid DialCache remote read deadline")
	}
	if options.ShadowMaxInFlight == 0 {
		options.ShadowMaxInFlight = 1
	}
	if options.ShadowMaxInFlight < 1 || uint64(options.ShadowMaxInFlight) > MaxSafeInteger {
		panic("invalid DialCache shadow capacity")
	}
	return &Cache[T]{options: options, local: make(map[string]entry[T]), flights: make(map[string]*flight[T]), shadows: make(map[string]*shadowFlight), registered: make(map[string]bool)}
}

// Enable reuses a live outer lifetime, including when nested inside Disable.
// Completing an outer callback closes only that scope, preventing late memo
// publication. Context cancellation remains an application/source concern.
func (c *Cache[T]) Enable(ctx context.Context, fn func(context.Context) error) error {
	prior, _ := ctx.Value(c).(scopeState[T])
	c.mu.Lock()
	owned := prior.owner == nil || !prior.owner.live
	s := prior.owner
	if owned {
		s = &scope[T]{live: true, memo: make(map[string]T), flights: make(map[string]*flight[T])}
	}
	c.mu.Unlock()
	if owned {
		defer func() { c.mu.Lock(); s.live = false; clear(s.memo); clear(s.flights); c.mu.Unlock() }()
	}
	return fn(context.WithValue(ctx, c, scopeState[T]{enabled: true, owner: s}))
}

func (c *Cache[T]) Disable(ctx context.Context, fn func(context.Context) error) error {
	state, _ := ctx.Value(c).(scopeState[T])
	state.enabled = false
	return fn(context.WithValue(ctx, c, state))
}
func (c *Cache[T]) IsEnabled(ctx context.Context) bool {
	state, _ := ctx.Value(c).(scopeState[T])
	c.mu.Lock()
	defer c.mu.Unlock()
	return state.enabled && state.owner != nil && state.owner.live
}

func (c *Cache[T]) emit(event Event) {
	if c.options.Observe != nil {
		func() { defer func() { _ = recover() }(); c.options.Observe(event) }()
	}
}

func (c *Cache[T]) localGet(key string) (T, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	item, found := c.local[key]
	// Match the TypeScript local cache's whole-millisecond monotonic clock.
	// Source/read/shadow deadlines separately retain fractional elapsed time.
	if found && c.options.Clock.ElapsedMS()-item.insertedMS >= item.ttlMS {
		delete(c.local, key)
		found = false
	}
	if found {
		c.sequence++
		item.used = c.sequence
		c.local[key] = item
	}
	return item.value, found
}
func (c *Cache[T]) localPut(key string, value T, ttl int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.options.LocalCapacity <= 0 {
		return
	}
	c.sequence++
	c.local[key] = entry[T]{value: value, insertedMS: c.options.Clock.ElapsedMS(), ttlMS: ttl, used: c.sequence}
	if len(c.local) > c.options.LocalCapacity {
		var oldest string
		stamp := ^uint64(0)
		for candidate, item := range c.local {
			if item.used < stamp {
				oldest = candidate
				stamp = item.used
			}
		}
		delete(c.local, oldest)
	}
}

func (c *Cache[T]) Invalidate(ctx context.Context, identity Identity, futureBufferMS int64) (err error) {
	if futureBufferMS < 0 || futureBufferMS > 31536000000 {
		return errors.New("invalid future buffer")
	}
	if identity.Namespace == "" {
		identity.Namespace = c.options.Namespace
	}
	c.emit(Event{Kind: "invalidation", Data: map[string]any{"cacheNamespace": identity.Namespace, "keyType": identity.KeyType, "layer": "remote"}})
	defer func() {
		if err != nil {
			c.options.Logger.Warn("Error writing DialCache invalidation watermark", err)
			c.emit(Event{Kind: "error", Data: map[string]any{"cacheNamespace": identity.Namespace, "keyType": identity.KeyType, "useCase": "watermark", "layer": "remote", "error": "invalidation", "inFallback": false}})
		}
	}()
	if c.options.Remote == nil {
		return MissingRemoteError
	}
	identity.Tracked = true
	_, _, watermark, err := identity.Keys()
	if err != nil {
		return err
	}
	now := c.options.Clock.WallMS()
	if now < 0 || uint64(now) > MaxSafeInteger-uint64(futureBufferMS) {
		return errors.New("invalid invalidation timestamp")
	}
	_, err = callSafely(func() (struct{}, error) {
		return struct{}{}, c.options.Remote.Invalidate(ctx, watermark, now, futureBufferMS)
	})
	return err
}
