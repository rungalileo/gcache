package dialcache

import (
	"bytes"
	"context"
	"sync"
	"sync/atomic"
	"time"
)

type shadowFlight struct {
	abandoned atomic.Bool
	stop      chan struct{}
	once      sync.Once
}

func (f *shadowFlight) abandon() { f.abandoned.Store(true); f.once.Do(func() { close(f.stop) }) }

type shadowVerdict struct {
	outcome        string
	age            *int64
	cached, source any
}

func (x *execution[T]) darkSource(layer string, localMiss bool) (T, error) {
	start := elapsedNow(x.cache.options.Clock)
	source := startPending(func() (T, error) { return x.source(layer) })
	x.scheduleShadow(nil, source, start)
	<-source.done
	v, e := source.result.value, source.result.err
	if e == nil && localMiss {
		x.putLocal(v)
	}
	return v, e
}

func (x *execution[T]) scheduleShadow(frame *Frame, source *pending[T], started time.Duration) {
	c := x.cache
	p := x.policy.Shadow
	if p.ConfigError {
		x.errorEvent("remote", "config_resolution", false)
		return
	}
	if !p.Enabled || c.options.ShadowOutcome == nil {
		return
	}
	c.mu.Lock()
	if c.shadows[x.key] != nil || len(c.shadows) >= c.options.ShadowMaxInFlight {
		c.mu.Unlock()
		x.shadowEvent(shadowVerdict{outcome: "dropped"})
		return
	}
	f := &shadowFlight{stop: make(chan struct{})}
	c.shadows[x.key] = f
	c.mu.Unlock()
	if p.LoggingConfigError {
		x.errorEvent("remote", "config_resolution", false)
	}
	deferWork(c.options.Clock, func() { x.runShadow(f, frame, source, started) })
}

func (x *execution[T]) shadowEvent(v shadowVerdict) {
	d := x.labels("")
	d["outcome"] = v.outcome
	e := Event{Kind: "shadowValidation", Key: x.key, Data: d, Outcome: v.outcome}
	if cb := x.cache.options.ShadowOutcome; cb != nil {
		func() { defer func() { recover() }(); cb(e) }()
	}
	x.cache.emit(e)
	if v.age != nil {
		age := *v.age
		if age < 0 {
			age = 0
		}
		x.event("shadowAge", "", map[string]any{"outcome": v.outcome, "seconds": float64(age) / 1000})
	}
	if v.outcome == "mismatch" && x.policy.Shadow.LogMismatches && x.cache.options.Logger != nil {
		func() {
			defer func() { recover() }()
			details := x.labels("")
			details["outcome"] = "mismatch"

			preview := ShadowMismatchLogDetails(x.key, v.cached, v.source)
			details["cacheKey"] = preview.CacheKey
			if preview.CachedValueJSON != nil {
				details["cachedValueJson"] = *preview.CachedValueJSON
			} else {
				details["cachedValueJson"] = nil
			}
			if preview.SourceValueJSON != nil {
				details["sourceValueJson"] = *preview.SourceValueJSON
			} else {
				details["sourceValueJson"] = nil
			}
			x.cache.options.Logger.Warn("DialCache shadow validation mismatch", details)
		}()
	}
}

func (x *execution[T]) runShadow(f *shadowFlight, frame *Frame, source *pending[T], started time.Duration) {
	clock := x.cache.options.Clock
	if source == nil {
		started = elapsedNow(clock)
	}
	budget := x.budget()
	if budget < 0 {
		budget = 60000
	}
	expired := func() bool {
		if elapsedNow(clock)-started >= time.Duration(budget)*time.Millisecond {
			f.abandon()
		}
		return f.abandoned.Load()
	}
	var reads []*pending[ReadResult]
	read := func(maxAge bool, retainFuture bool) (ReadResult, error) {
		begin := elapsedNow(clock)
		x.event("request", "remote_shadow", nil)
		bounded, raw := x.rawRead()
		reads = append(reads, raw)
		<-bounded.done
		r, err := bounded.result.value, bounded.result.err
		if err != nil {
			kind := "cache_read"
			if _, ok := err.(*RemoteReadTimeoutError); ok {
				kind = "cache_read_timeout"
			}
			x.errorEvent("remote_shadow", kind, false)
		} else {
			if r.Kind != "miss" {
				age, valid := x.frameAge(&r.Frame, "remote_shadow")
				if !valid && !(retainFuture && age < 0) {
					r = ReadResult{Kind: "miss", Reason: "unclassified"}
				} else if maxAge && age >= x.policy.Remote.TTLMS {
					r = ReadResult{Kind: "miss", Reason: "expired"}
				}
			}
			if r.Kind == "miss" {
				x.event("miss", "remote_shadow", map[string]any{"reason": r.Reason})
			}
		}
		x.duration("get", "remote_shadow", begin, nil)
		return r, err
	}
	validation := startPending(func() (shadowVerdict, error) {
		defer func() {
			// Reads keep the slot after a read timeout; owned source/codec/write
			// work already keeps this operation blocked until its raw completion.
			go func() {
				for _, r := range reads {
					<-r.done
				}
				x.cache.mu.Lock()
				if x.cache.shadows[x.key] == f {
					delete(x.cache.shadows, x.key)
				}
				x.cache.mu.Unlock()
			}()
		}()
		out := func(name string) (shadowVerdict, error) { return shadowVerdict{outcome: name}, nil }
		if expired() {
			return out("timeout")
		}
		fill := false
		var fence *uint64
		if source != nil {
			r, err := read(true, false)
			if err != nil {
				return out("redis_error")
			}
			if expired() {
				return out("timeout")
			}
			if r.Kind == "miss" {
				fill = true
				fence = r.ObservedWatermarkMS
			} else {
				copy := r.Frame
				frame = &copy
			}
		}
		var value T
		var err error
		if source != nil {
			select {
			case <-source.done:
				value, err = source.result.value, source.result.err
			case <-f.stop:
				return out("timeout")
			}
			if err == nil {
				done := make(chan struct{})
				deferWork(clock, func() { close(done) })
				<-done
			}
		} else {
			err = x.cache.Disable(x.ctx, func(ctx context.Context) error {
				value, err = callSafely(func() (T, error) { return x.load(ctx) })
				return err
			})
		}
		if err != nil {
			if source != nil && x.timedOut.Load() {
				return out("timeout")
			}
			return out("source_error")
		}
		if expired() {
			return out("timeout")
		}
		if fill {
			filled, writeErr := x.putRemote(value, fence, "remote_shadow", func() bool { return !expired() })
			if expired() {
				return out("timeout")
			}
			if filled {
				return out("filled")
			}
			if writeErr != nil {
				x.cache.options.Logger.Warn("Error populating Redis from DialCache shadow work", writeErr)
				return out("fill_error")
			}
			return out("fill_fenced")
		}
		if frame == nil {
			return out("timeout")
		}
		cached, err := x.decode(*frame, "remote_shadow")
		if err != nil {
			return out("deserialization_error")
		}
		if expired() {
			return out("timeout")
		}
		matches, err := callSafely(func() (bool, error) {
			if x.op.Comparator != nil {
				return x.op.Comparator(cached, value)
			}
			return SemanticEqual(cached, value), nil
		})
		if err != nil {
			return out("comparison_error")
		}
		if expired() {
			return out("timeout")
		}
		age := clock.WallMS() - int64(frame.CreatedAtMS)
		if matches {
			return shadowVerdict{outcome: "match", age: &age}, nil
		}
		confirmation, err := read(false, true)
		if err != nil {
			return out("confirmation_error")
		}
		if expired() {
			return out("timeout")
		}
		if confirmation.Kind == "miss" || !bytes.Equal(frame.Payload, confirmation.Frame.Payload) {
			return out("superseded")
		}
		age = clock.WallMS() - int64(frame.CreatedAtMS)
		return shadowVerdict{outcome: "mismatch", age: &age, cached: cached, source: value}, nil
	})
	verdict, err := awaitDeadline(clock, validation, started, budget, func() error { return &FallbackTimeoutError{UseCase: x.op.Identity.UseCase, TimeoutMS: budget} }, f.abandon)
	if err != nil {
		verdict = shadowVerdict{outcome: "timeout"}
	}
	x.shadowEvent(verdict)
}
