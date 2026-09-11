package dialcache

import (
	"context"
	"errors"
)

type ProcessCoalescingState struct {
	ActiveLeaders     int
	ActiveFollowers   int
	OldestLeaderAgeMS *int64
}
type CoalescingState struct{ Process ProcessCoalescingState }

func (c *Cache[T]) GetCoalescingState() CoalescingState {
	c.mu.Lock()
	defer c.mu.Unlock()
	state := ProcessCoalescingState{ActiveLeaders: len(c.flights)}
	for _, f := range c.flights {
		state.ActiveFollowers += f.followers
		age := (elapsedNow(c.options.Clock) - f.started).Milliseconds()
		if age < 0 {
			age = 0
		}
		if state.OldestLeaderAgeMS == nil || age > *state.OldestLeaderAgeMS {
			copy := age
			state.OldestLeaderAgeMS = &copy
		}
	}
	return CoalescingState{Process: state}
}

func (c *Cache[T]) WithEnabled(ctx context.Context, f func(context.Context) error) error {
	return c.Enable(ctx, f)
}
func (c *Cache[T]) WithDisabled(ctx context.Context, f func(context.Context) error) error {
	return c.Disable(ctx, f)
}

// Cached binds a typed argument to an operation, preserving registration and
// snapshot semantics while allowing each invocation to select its logical key.
// An argument can be a scalar or a struct containing any number of source inputs.
func Cached[T, Arg any](cache *Cache[T], op Operation, selectKey func(Arg) (Identity, error), source func(context.Context, Arg) (T, error)) (func(context.Context, Arg) (T, error), error) {
	if selectKey == nil || source == nil {
		return nil, errors.New("cached requires a key selector and source")
	}
	if err := ValidatePolicy(op.Policy); err != nil {
		return nil, err
	}
	if op.Identity.UseCase == "watermark" {
		return nil, errors.New("reserved use case: watermark")
	}
	if op.FallbackTimeoutMS != nil && (*op.FallbackTimeoutMS < 1 || *op.FallbackTimeoutMS > MaxDeadlineMS) {
		return nil, errors.New("invalid fallback deadline")
	}
	op.Policy = SnapshotPolicy(op.Policy)
	if op.FallbackTimeoutMS != nil {
		n := *op.FallbackTimeoutMS
		op.FallbackTimeoutMS = &n
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.registered[op.Identity.UseCase] {
		return nil, errors.New("use case already registered: " + op.Identity.UseCase)
	}
	cache.registered[op.Identity.UseCase] = true
	return func(ctx context.Context, arg Arg) (T, error) {
		invocation := op
		invocation.IdentityProvider = func() (Identity, error) {
			key, err := selectKey(arg)
			key.UseCase = op.Identity.UseCase
			key.KeyType = op.Identity.KeyType
			key.Tracked = op.Identity.Tracked
			key.Namespace = op.Identity.Namespace
			return key, err
		}
		return cache.GetOrLoad(ctx, invocation, func(ctx context.Context) (T, error) { return source(ctx, arg) })
	}, nil
}

func (x *execution[T]) codec() Codec[T] {
	if x.op.Codec != nil {
		if codec, ok := x.op.Codec.(Codec[T]); ok {
			return codec
		}
		return invalidCodec[T]{}
	}
	return x.cache.options.Codec
}

type invalidCodec[T any] struct{}

func (invalidCodec[T]) Encode(T) (Payload, error) {
	return Payload{}, errors.New("operation codec does not implement Codec for this value type")
}
func (invalidCodec[T]) Decode(Payload) (T, error) {
	var zero T
	return zero, errors.New("operation codec does not implement Codec for this value type")
}
