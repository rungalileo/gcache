package dialcache

import (
	"sync"
	"time"
)

type completion[T any] struct {
	value T
	err   error
}
type pending[T any] struct {
	done   chan struct{}
	result completion[T]
}

func callSafely[T any](f func() (T, error)) (value T, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = &CallbackPanicError{Value: p}
		}
	}()
	return f()
}

func startPending[T any](f func() (T, error)) *pending[T] {
	p := &pending[T]{done: make(chan struct{})}
	go func() { p.result.value, p.result.err = callSafely(f); close(p.done) }()
	return p
}

func elapsedNow(clock Clock) time.Duration {
	if precise, ok := clock.(PreciseClock); ok {
		return precise.ElapsedTime()
	}
	return time.Duration(clock.ElapsedMS()) * time.Millisecond
}

func after(clock Clock, delay time.Duration, f func()) Timer {
	if delay < 0 {
		delay = 0
	}
	if timers, ok := clock.(TimerClock); ok {
		// A millisecond timer must never shorten a fractional remaining budget.
		ms := int64(delay / time.Millisecond)
		if delay%time.Millisecond != 0 {
			ms++
		}
		return timers.AfterFunc(ms, f)
	}
	return time.AfterFunc(delay, f)
}

// awaitDeadline accepts only results observed strictly before the deadline.
// Raw work keeps ownership of its resources after the caller stops waiting.
func awaitDeadline[T any](clock Clock, p *pending[T], started time.Duration, budget int64, timeout func() error, onTimeout func()) (T, error) {
	if budget < 0 {
		<-p.done
		return p.result.value, p.result.err
	}
	duration := time.Duration(budget) * time.Millisecond
	for {
		var once sync.Once
		expired := make(chan struct{})
		timer := after(clock, duration-(elapsedNow(clock)-started), func() { once.Do(func() { close(expired) }) })
		select {
		case <-p.done:
			timer.Stop()
			if elapsedNow(clock)-started < duration {
				return p.result.value, p.result.err
			}
		case <-expired:
			timer.Stop()
			// Timer precision and delivery do not define the semantic boundary.
			if elapsedNow(clock)-started < duration {
				continue
			}
		}
		break
	}
	if onTimeout != nil {
		onTimeout()
	}
	var zero T
	return zero, timeout()
}

func deferWork(clock Clock, f func()) {
	if executor, ok := clock.(DeferredExecutor); ok {
		executor.Defer(f)
		return
	}
	go f()
}
