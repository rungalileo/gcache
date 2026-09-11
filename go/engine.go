package dialcache

import (
	"context"
	"errors"
	"sync/atomic"
	"time"
)

type execution[T any] struct {
	cache                     *Cache[T]
	ctx                       context.Context
	op                        Operation
	key, remoteKey, watermark string
	policy                    ResolvedPolicy
	load                      func(context.Context) (T, error)
	timedOut                  atomic.Bool
}

func (x *execution[T]) labels(layer string) map[string]any {
	d := map[string]any{"cacheNamespace": x.op.Identity.Namespace, "useCase": x.op.Identity.UseCase, "keyType": x.op.Identity.KeyType}
	if layer != "" {
		d["layer"] = layer
	}
	return d
}
func (x *execution[T]) event(kind, layer string, extra map[string]any) {
	d := x.labels(layer)
	for k, v := range extra {
		d[k] = v
	}
	e := Event{Kind: kind, Key: x.key, Data: d}
	if scope, ok := d["scope"].(string); ok {
		e.Scope = scope
	}
	if n, ok := d["seconds"].(float64); ok {
		e.Seconds = n

	}
	if n, ok := d["bytes"].(int64); ok {
		e.Bytes = n

	}
	if outcome, ok := d["outcome"].(string); ok {
		e.Outcome = outcome
	}
	x.cache.emit(e)
}
func (x *execution[T]) errorEvent(layer, kind string, inFallback bool) {
	x.event("error", layer, map[string]any{"error": kind, "inFallback": inFallback})
}
func (x *execution[T]) elapsed(start time.Duration) float64 {
	n := elapsedNow(x.cache.options.Clock) - start
	if n < 0 {
		n = 0
	}
	return n.Seconds()
}
func (x *execution[T]) duration(kind, layer string, start time.Duration, extra map[string]any) {
	if extra == nil {
		extra = map[string]any{}
	}
	extra["seconds"] = x.elapsed(start)
	x.event(kind, layer, extra)
}

func (c *Cache[T]) GetOrLoad(ctx context.Context, op Operation, load func(context.Context) (T, error)) (T, error) {
	var zero T
	if err := ValidatePolicy(op.Policy); err != nil {
		return zero, err
	}
	op.Policy = SnapshotPolicy(op.Policy)
	if op.FallbackTimeoutMS != nil && (*op.FallbackTimeoutMS < 1 || *op.FallbackTimeoutMS > MaxDeadlineMS) {
		return zero, errors.New("invalid fallback deadline")
	}
	if op.FallbackTimeoutMS != nil {
		budget := *op.FallbackTimeoutMS
		op.FallbackTimeoutMS = &budget
	}
	if op.Identity.UseCase == "watermark" {
		return zero, errors.New("reserved use case: watermark")
	}
	if op.Identity.Namespace == "" {
		op.Identity.Namespace = c.options.Namespace
	}
	x := &execution[T]{cache: c, ctx: ctx, op: op, load: load}
	if !c.IsEnabled(ctx) {
		x.event("disabled", "noop", map[string]any{"reason": "context"})
		return callSafely(func() (T, error) { return load(ctx) })
	}
	if op.IdentityProvider != nil {
		identity, err := callSafely(op.IdentityProvider)
		// Computed identities are cache plumbing: invalid results fail open,
		// while invalid static operation metadata is rejected above.
		if err == nil && identity.UseCase == "watermark" {
			err = errors.New("reserved use case: watermark")
		}
		if err != nil {
			c.options.Logger.Error("Could not construct DialCache key", err)
			x.errorEvent("noop", "key_construction", false)
			return x.source("noop")
		}
		if identity.Namespace == "" {
			identity.Namespace = c.options.Namespace
		}
		op.Identity = identity
	}
	// Freeze the logical identity before the asynchronous provider runs. Policy
	// cohorts and subsequent effects must refer to the key accepted at admission.
	op.Identity.Args = append([][2]string(nil), op.Identity.Args...)
	x.op = op
	key, remoteKey, watermark, err := op.Identity.Keys()
	if err != nil {
		c.options.Logger.Error("Could not construct DialCache key", err)
		x.errorEvent("noop", "key_construction", false)
		return x.source("noop")
	}
	x.key, x.remoteKey, x.watermark = key, remoteKey, watermark
	var overlay any
	if c.options.PolicyProvider != nil {
		overlay, err = callSafely(func() (any, error) { return c.options.PolicyProvider(ctx, op.Identity) })
	}
	if err == nil {
		x.policy, err = ResolvePolicy(op.Policy, overlay, op.Identity, PolicyDefaults{RemoteReadTimeoutMS: c.options.RemoteReadTimeoutMS})
	}
	if err != nil {
		c.options.Logger.Warn("Could not resolve DialCache key config", err)
		x.errorEvent("noop", "config_resolution", false)
		x.event("disabled", "noop", map[string]any{"reason": "config_error"})
		return x.source("noop")
	}
	if !c.IsEnabled(ctx) {
		x.event("disabled", "noop", map[string]any{"reason": "context"})
		return x.source("noop")
	}
	if !x.policy.RequestLocal {
		return x.shared("local")
	}
	state, _ := ctx.Value(c).(scopeState[T])
	run := func() (T, error) {
		start := elapsedNow(c.options.Clock)
		c.mu.Lock()
		v, found := state.owner.memo[key]
		live := state.owner.live
		c.mu.Unlock()
		x.event("request", "request_local", nil)
		x.duration("get", "request_local", start, nil)
		if live && found {
			return v, nil
		}
		x.event("miss", "request_local", map[string]any{"reason": "value_absent"})
		v, err = x.shared("request_local")
		if err == nil {
			c.mu.Lock()
			if state.owner.live {
				state.owner.memo[key] = v
			}
			c.mu.Unlock()
		}
		return v, err
	}
	if !x.policy.Coalesce {
		return run()
	}
	return x.singleFlight(state.owner.flights, state.owner, "request_local", run)
}

func (x *execution[T]) singleFlight(flights map[string]*flight[T], owner *scope[T], label string, run func() (T, error)) (T, error) {
	c := x.cache
	c.mu.Lock()
	if owner != nil && !owner.live {
		c.mu.Unlock()
		return run()
	}
	if f := flights[x.key]; f != nil {
		f.followers++
		c.mu.Unlock()
		x.event("coalesced", "", map[string]any{"scope": label})
		<-f.done
		return f.value, f.err
	}
	f := &flight[T]{done: make(chan struct{}), started: elapsedNow(c.options.Clock)}
	flights[x.key] = f
	c.mu.Unlock()
	f.value, f.err = callSafely(run)
	c.mu.Lock()
	if flights[x.key] == f {
		delete(flights, x.key)
	}
	close(f.done)
	c.mu.Unlock()
	return f.value, f.err
}

func (x *execution[T]) layer(layer string, r ResolvedLayer) {
	if !r.Enabled {
		x.event("disabled", layer, map[string]any{"reason": r.Reason})
		if r.Reason == "invalid_ttl" || r.Reason == "invalid_ramp" {
			x.errorEvent(layer, "config_resolution", false)
		}
	}
}
func (x *execution[T]) shared(fallbackLayer string) (T, error) {
	c := x.cache
	p := x.policy
	x.layer("local", p.Local)
	run := func() (T, error) {
		localMiss := false
		if p.Local.Enabled {
			start := elapsedNow(c.options.Clock)
			item, readErr := callSafely(func() (localResult[T], error) {
				value, found := c.localGet(x.key)
				return localResult[T]{value, found}, nil
			})
			if readErr != nil {
				c.options.Logger.Error("Error getting value from local cache", readErr)
				x.errorEvent("local", "cache_read", false)
				x.event("disabled", "local", map[string]any{"reason": "config_error"})
			} else {
				x.event("request", "local", nil)
				x.duration("get", "local", start, nil)
				if item.found {
					return item.value, nil
				}
				localMiss = true
				x.event("miss", "local", map[string]any{"reason": "value_absent"})
			}
			fallbackLayer = "local"
		}
		if c.options.Remote == nil {
			v, e := x.source(fallbackLayer)
			if e == nil && localMiss {
				x.putLocal(v)
			}
			return v, e
		}
		if p.StaleOnErrorConfigError {
			x.errorEvent("remote", "config_resolution", false)
		}
		x.layer("remote", p.Remote)
		if !p.Remote.Enabled {
			if p.Remote.Reason == "ramped_down" {
				return x.darkSource(fallbackLayer, localMiss)
			}
			v, e := x.source(fallbackLayer)
			if e == nil && localMiss {
				x.putLocal(v)
			}
			return v, e
		}
		remote := x.readServing()
		if remote.kind == "hit" {
			if localMiss {
				x.putLocal(remote.value)
			}
			x.scheduleShadow(remote.frame, nil, 0)
			return remote.value, nil
		}
		v, err := x.source("remote")
		if err != nil {
			if remote.kind != "error" && remote.kind != "decode_error" && p.StaleOnErrorMaxAgeMS > 0 && x.canRecover(err) {
				if value, ok := x.recover(remote.frame); ok {
					return value, nil
				}
			}
			return v, err
		}
		if remote.kind != "error" {
			if _, writeErr := x.putRemote(v, remote.fence, "remote", nil); writeErr != nil {
				c.options.Logger.Warn("Error putting value in Redis cache", writeErr)
			}
		}
		if localMiss && !x.op.Identity.Tracked {
			x.putLocal(v)
		}
		return v, nil
	}
	if p.Local.Enabled {
		if p.Coalesce {
			return x.singleFlight(c.flights, nil, "process", run)
		}
		return run()
	}
	// Remote admission is decided before joining, while traversal belongs to the leader.
	if p.Remote.Enabled && c.options.Remote != nil && p.Coalesce {
		return x.singleFlight(c.flights, nil, "process", run)
	}
	return run()
}

type localResult[T any] struct {
	value T
	found bool
}

func (x *execution[T]) putLocal(value T) {
	_, err := callSafely(func() (struct{}, error) {
		x.cache.localPut(x.key, value, x.policy.Local.TTLMS)
		return struct{}{}, nil
	})
	if err != nil {
		x.cache.options.Logger.Warn("Error putting value in local cache", err)
		x.errorEvent("local", "cache_write", false)
	}
}

func (x *execution[T]) budget() int64 {
	if x.op.UnboundedFallback {
		return -1
	}
	if x.op.FallbackTimeoutMS != nil {
		return *x.op.FallbackTimeoutMS
	}
	return 60000
}
func (x *execution[T]) source(layer string) (T, error) {
	clock := x.cache.options.Clock
	start := elapsedNow(clock)
	budget := x.budget()
	p := startPending(func() (T, error) { return x.load(x.ctx) })
	v, err := awaitDeadline(clock, p, start, budget, func() error { return &FallbackTimeoutError{UseCase: x.op.Identity.UseCase, TimeoutMS: budget} }, func() { x.timedOut.Store(true) })
	if err != nil {
		x.errorEvent(layer, "fallback", true)
	}
	x.duration("fallback", layer, start, nil)
	return v, err
}

type remoteValue[T any] struct {
	kind  string
	value T
	frame *Frame
	fence *uint64
}

func (x *execution[T]) rawRead() (*pending[ReadResult], *pending[ReadResult]) {
	ctx, cancel := context.WithCancel(context.WithValue(context.WithoutCancel(x.ctx), readBudgetKey{}, x.policy.RemoteReadTimeoutMS))
	clock := x.cache.options.Clock
	start := elapsedNow(clock)
	raw := startPending(func() (ReadResult, error) { return x.cache.options.Remote.Read(ctx, x.remoteKey, x.watermark) })
	bounded := startPending(func() (ReadResult, error) {
		r, e := awaitDeadline(clock, raw, start, x.policy.RemoteReadTimeoutMS, func() error { return &RemoteReadTimeoutError{TimeoutMS: x.policy.RemoteReadTimeoutMS} }, cancel)
		if e != nil {
			return r, e
		}
		r = NormalizeReadResult(r, x.op.Identity.Tracked)
		return r, r.Error()
	})
	return bounded, raw
}
func (x *execution[T]) frameAge(frame *Frame, layer string) (int64, bool) {
	if frame == nil || frame.CreatedAtMS > MaxSafeInteger {
		return 0, false
	}
	age := x.cache.options.Clock.WallMS() - int64(frame.CreatedAtMS)
	if age < 0 {
		x.event("futureOffset", layer, map[string]any{"seconds": float64(-age) / 1000})
		return age, false
	}
	return age, true
}
func (x *execution[T]) readServing() remoteValue[T] {
	start := elapsedNow(x.cache.options.Clock)
	x.event("request", "remote", nil)
	defer x.duration("get", "remote", start, nil)
	p, _ := x.rawRead()
	<-p.done
	r, err := p.result.value, p.result.err
	if err != nil {
		x.cache.options.Logger.Warn("Error getting value from Redis cache", err)
		kind := "cache_read"
		var timeout *RemoteReadTimeoutError
		if errors.As(err, &timeout) {
			kind = "cache_read_timeout"
		}
		x.errorEvent("remote", kind, false)
		return remoteValue[T]{kind: "error"}
	}
	if r.Kind == "miss" {
		x.event("miss", "remote", map[string]any{"reason": r.Reason})
		return remoteValue[T]{kind: "miss", fence: r.ObservedWatermarkMS}
	}
	age, valid := x.frameAge(&r.Frame, "remote")
	if !valid {
		x.event("miss", "remote", map[string]any{"reason": "unclassified"})
		return remoteValue[T]{kind: "miss"}
	}
	maxAge := x.policy.Remote.TTLMS
	if x.policy.StaleOnErrorMaxAgeMS > 0 {
		maxAge = x.policy.StaleOnErrorMaxAgeMS
	}
	if age >= maxAge {
		x.event("miss", "remote", map[string]any{"reason": "expired"})
		return remoteValue[T]{kind: "miss"}
	}
	if age >= x.policy.Remote.TTLMS {
		x.event("miss", "remote", map[string]any{"reason": "expired"})
		return remoteValue[T]{kind: "retained", frame: &r.Frame}
	}
	value, err := x.decode(r.Frame, "remote")
	if err != nil {
		x.event("miss", "remote", map[string]any{"reason": "unclassified"})
		return remoteValue[T]{kind: "decode_error"}
	}
	return remoteValue[T]{kind: "hit", value: value, frame: &r.Frame}
}

func (x *execution[T]) decode(frame Frame, layer string) (T, error) {
	payload := Payload{Bytes: frame.Payload, Binary: frame.Binary}
	decompressStarted := elapsedNow(x.cache.options.Clock)
	expanded := DecompressPayload(payload)
	if expanded.Outcome != "passthrough" {
		x.event("compression", layer, map[string]any{"outcome": expanded.Outcome})
		x.duration("compressionDuration", layer, decompressStarted, map[string]any{"operation": "decompress"})
	}
	start := elapsedNow(x.cache.options.Clock)
	value, err := callSafely(func() (T, error) {
		if codec, ok := x.codec().(ContextCodec[T]); ok {
			return codec.DecodeContext(x.ctx, expanded.Payload)
		}
		return x.codec().Decode(expanded.Payload)
	})
	if err != nil {
		x.errorEvent(layer, "serialization_load", false)
	}
	x.duration("serialization", layer, start, map[string]any{"operation": "load"})
	return value, err
}
func (x *execution[T]) putRemote(value T, fence *uint64, layer string, allowed func() bool) (bool, error) {
	clock := x.cache.options.Clock
	if !x.op.Identity.Tracked {
		fence = nil
	}
	if fence != nil {
		stamp, err := x.writeTimestamp(layer)
		if err != nil {
			return false, err
		}
		if stamp <= int64(*fence) {
			return false, nil
		}
	}
	start := elapsedNow(clock)
	payload, err := callSafely(func() (Payload, error) {
		if codec, ok := x.codec().(ContextCodec[T]); ok {
			return codec.EncodeContext(x.ctx, value)
		}
		return x.codec().Encode(value)
	})
	if err != nil {
		x.errorEvent(layer, "serialization_dump", false)
	}
	x.duration("serialization", layer, start, map[string]any{"operation": "dump"})
	if err != nil {
		return false, err
	}
	x.event("size", layer, map[string]any{"bytes": int64(len(payload.Bytes))})
	if !x.cache.options.DisableCompression {
		compressStarted := elapsedNow(clock)
		compressed, compressionErr := CompressPayload(payload, *x.cache.options.Compression)
		if compressionErr != nil {
			x.errorEvent(layer, "compression", false)
			return false, compressionErr
		}
		payload = compressed.Payload
		x.event("compression", layer, map[string]any{"outcome": compressed.Outcome})
		if compressed.Outcome == "compressed" || compressed.Outcome == "not_smaller" {
			x.duration("compressionDuration", layer, compressStarted, map[string]any{"operation": "compress"})
		}
		if compressed.Outcome == "compressed" {
			x.event("compressionRatio", layer, map[string]any{"value": float64(compressed.StoredBytes) / float64(compressed.OriginalBytes)})
		}
	} else {
		payload = EscapeRawPayload(payload)
	}
	x.event("storedSize", layer, map[string]any{"bytes": int64(len(payload.Bytes))})
	if allowed != nil && !allowed() {
		return false, nil
	}
	stamp, stampErr := x.writeTimestamp(layer)
	if stampErr != nil {
		return false, stampErr
	}
	if fence != nil && uint64(stamp) <= *fence {
		return false, nil
	}
	ttl := x.policy.Remote.TTLMS
	if x.policy.StaleOnErrorMaxAgeMS > 0 {
		ttl = x.policy.StaleOnErrorMaxAgeMS
	}
	if x.op.Identity.Tracked && ttl > 3600000 {
		ttl = 3600000
		x.errorEvent(layer, "tracked_ttl_clamped", false)
	}
	_, err = callSafely(func() (struct{}, error) {
		return struct{}{}, x.cache.options.Remote.Write(x.ctx, x.remoteKey, Frame{CreatedAtMS: uint64(stamp), Binary: payload.Binary, Payload: payload.Bytes}, ttl)
	})
	if err != nil {
		x.errorEvent(layer, "cache_write", false)
		return false, err
	}
	return true, nil
}

func (x *execution[T]) writeTimestamp(layer string) (int64, error) {
	stamp := x.cache.options.Clock.WallMS()
	if stamp < 0 || uint64(stamp) > MaxSafeInteger {
		x.errorEvent(layer, "cache_write", false)
		return 0, errors.New("invalid Redis write timestamp")
	}
	return stamp, nil
}

func (x *execution[T]) canRecover(err error) bool {
	predicate := x.op.ShouldRecover
	if predicate == nil {
		predicate = x.cache.options.ShouldRecover
	}
	if predicate == nil {
		var deadline *FallbackTimeoutError
		return errors.As(err, &deadline)
	}
	ok, e := callSafely(func() (bool, error) { return predicate(err) })
	if e != nil {
		x.cache.options.Logger.Warn("DialCache stale recovery predicate threw; recovery was denied", e)
	}
	return e == nil && ok
}
func (x *execution[T]) recoveryEvent(outcome string, age *int64) {
	d := x.labels("")
	d["outcome"] = outcome
	e := Event{Kind: "staleRecovery", Key: x.key, Data: d, Outcome: outcome}
	if cb := x.cache.options.RecoveryOutcome; cb != nil {
		func() { defer func() { recover() }(); cb(e) }()
	}
	x.cache.emit(e)
	if age != nil {
		x.event("recoveryAge", "", map[string]any{"outcome": outcome, "seconds": float64(*age) / 1000})
	}
}
func (x *execution[T]) recover(frame *Frame) (T, bool) {
	var zero T
	if frame == nil {
		x.recoveryEvent("miss", nil)
		return zero, false
	}
	age, valid := x.frameAge(frame, "remote")
	if !valid || age >= x.policy.StaleOnErrorMaxAgeMS {
		x.recoveryEvent("miss", nil)
		return zero, false
	}
	value, err := x.decode(*frame, "remote")
	if err != nil {
		x.recoveryEvent("deserialization_error", nil)
		return zero, false
	}
	age, valid = x.frameAge(frame, "remote")
	if !valid || age >= x.policy.StaleOnErrorMaxAgeMS {
		x.recoveryEvent("miss", nil)
		return zero, false
	}
	x.recoveryEvent("served", &age)
	return value, true
}
