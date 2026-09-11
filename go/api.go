package dialcache

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// Clock separates wall timestamps from elapsed-time expiration and deadlines.
type Clock interface {
	WallMS() int64
	ElapsedMS() int64
}

// PreciseClock optionally preserves fractional milliseconds for deadlines and
// diagnostics. Local TTL uses whole milliseconds from Clock.ElapsedMS.
// ElapsedTime and ElapsedMS must use the same monotonic origin. Existing integer
// clocks remain supported through Clock.ElapsedMS.
type PreciseClock interface {
	ElapsedTime() time.Duration
}

type Timer interface{ Stop() bool }

// TimerClock lets applications supply the timer source corresponding to Clock.
// Callbacks must run at most once; Stop prevents a callback which has not begun.
type TimerClock interface {
	AfterFunc(delayMS int64, callback func()) Timer
}

// DeferredExecutor controls detached work admission without changing its rules.
type DeferredExecutor interface{ Defer(func()) }

type systemClock struct{ origin time.Time }

var processClockOrigin = time.Now()

func newSystemClock() systemClock {
	now := time.Now()
	// Default instances share a millisecond grid, as performance.now does in
	// TypeScript. A nearby aligned origin keeps elapsed time nonnegative even
	// under a synthetic clock whose epoch precedes package initialization.
	phase := now.Sub(processClockOrigin) % time.Millisecond
	if phase < 0 {
		phase += time.Millisecond
	}
	return systemClock{origin: now.Add(-phase)}
}

func (c systemClock) WallMS() int64              { return time.Now().UnixMilli() }
func (c systemClock) ElapsedTime() time.Duration { return time.Since(c.origin) }
func (c systemClock) ElapsedMS() int64           { return c.ElapsedTime().Milliseconds() }
func (c systemClock) AfterFunc(ms int64, f func()) Timer {
	return time.AfterFunc(time.Duration(ms)*time.Millisecond, f)
}

// Remote supplies atomic primary snapshots and complete, client-stamped writes.
// Cancellation requests do not assert that a pending command has stopped.
type Remote interface {
	Read(context.Context, string, string) (ReadResult, error)
	Write(context.Context, string, Frame, int64) error
	Invalidate(context.Context, string, int64, int64) error
}

type Payload struct {
	Bytes  []byte
	Binary bool
}

// Codec borrows immutable payloads. Every Decode must produce an independent value.
type Codec[T any] interface {
	Encode(T) (Payload, error)
	Decode(Payload) (T, error)
}

type ContextCodec[T any] interface {
	EncodeContext(context.Context, T) (Payload, error)
	DecodeContext(context.Context, Payload) (T, error)
}

type RecoveryPredicate func(error) (bool, error)
type ShadowComparator func(any, any) (bool, error)

type Operation struct {
	Identity          Identity
	IdentityProvider  func() (Identity, error)
	Codec             any
	Policy            Policy
	FallbackTimeoutMS *int64
	UnboundedFallback bool
	ShouldRecover     RecoveryPredicate
	Comparator        ShadowComparator
}

// Event records public diagnostics; Data contains the backend-neutral labels.
type Event struct {
	Kind    string
	Scope   string
	Key     string
	Data    map[string]any
	Seconds float64
	Bytes   int64
	Outcome string
}

type Logger interface {
	Debug(message string, details any)
	Warn(message string, details any)
	Error(message string, details any)
}

type Options[T any] struct {
	Compression         *CompressionConfig
	DisableCompression  bool
	Remote              Remote
	Codec               Codec[T]
	Clock               Clock
	Namespace           string
	NamespaceSet        bool
	LocalCapacity       int
	LocalCapacitySet    bool
	Observe             func(Event)
	Logger              Logger
	PolicyProvider      func(context.Context, Identity) (any, error)
	RemoteReadTimeoutMS int64
	ShouldRecover       RecoveryPredicate
	ShadowMaxInFlight   int
	ShadowOutcome       func(Event)
	RecoveryOutcome     func(Event)
}

type FallbackTimeoutError struct {
	UseCase   string
	TimeoutMS int64
}

func (e *FallbackTimeoutError) Error() string {
	return fmt.Sprintf("DialCache fallback timed out for %s after %dms", e.UseCase, e.TimeoutMS)
}

type RemoteReadTimeoutError struct{ TimeoutMS int64 }

func (e *RemoteReadTimeoutError) Error() string {
	return fmt.Sprintf("DialCache Redis read timed out after %dms", e.TimeoutMS)
}

type CallbackPanicError struct{ Value any }

func (e *CallbackPanicError) Error() string {
	return fmt.Sprintf("DialCache callback panicked: %v", e.Value)
}

var MissingRemoteError = errors.New("DialCache invalidation requires a configured Redis client")

type readBudgetKey struct{}

func ReadBudget(ctx context.Context) (int64, bool) {
	n, ok := ctx.Value(readBudgetKey{}).(int64)
	return n, ok
}
