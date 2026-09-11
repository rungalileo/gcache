package dialcache

import (
	"bytes"
	"context"
	"errors"
	"sync/atomic"
	"testing"
)

type binaryCodec struct{}

func (binaryCodec) Encode(value []byte) (Payload, error) {
	return Payload{Bytes: append([]byte{}, value...), Binary: true}, nil
}

func (binaryCodec) Decode(payload Payload) ([]byte, error) {
	if !payload.Binary {
		return nil, errors.New("binary codec received text")
	}
	return append([]byte{}, payload.Bytes...), nil
}

func TestBinaryCodecRemoteRoundTripPreservesBytesAndTag(t *testing.T) {
	clock := &manualClock{wall: 1788868800000}
	remote := &memoryRemote{clock: clock, values: make(map[string]remoteEntry), watermarks: make(map[string]string)}
	cache := New(Options[[]byte]{Clock: clock, Remote: remote, Codec: binaryCodec{}, LocalCapacity: 10000})
	op := coreOperation("binaryRoundTrip")
	op.Policy.RemoteTTLMS = 60000
	want := []byte{0, 0xff, 0x80, 0xe2, 0x82}
	var sourceCalls atomic.Int64
	load := func(context.Context) ([]byte, error) { sourceCalls.Add(1); return append([]byte{}, want...), nil }
	for call := 0; call < 2; call++ {
		if err := cache.Enable(context.Background(), func(ctx context.Context) error {
			value, err := cache.GetOrLoad(ctx, op, load)
			if err != nil {
				return err
			}
			if !bytes.Equal(value, want) {
				t.Errorf("call %d: got %x, want %x", call, value, want)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	if sourceCalls.Load() != 1 {
		t.Fatalf("remote hit was lost: source invoked %d times", sourceCalls.Load())
	}
}

func TestClosedScopeCannotPublishIntoReplacement(t *testing.T) {
	c := New(Options[int64]{LocalCapacity: 10000})
	op := coreOperation("lifetime")
	op.Policy.RequestLocal = true
	started, release, done := make(chan struct{}), make(chan struct{}), make(chan callResult, 1)
	var detached context.Context
	if err := c.Enable(context.Background(), func(ctx context.Context) error {
		detached = ctx
		go func() {
			value, err := c.GetOrLoad(ctx, op, func(context.Context) (int64, error) { close(started); <-release; return 1, nil })
			done <- callResult{value, err}
		}()
		<-started
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if c.IsEnabled(detached) {
		t.Fatal("closed scope remains enabled")
	}
	if err := c.Enable(context.Background(), func(ctx context.Context) error {
		first, err := c.GetOrLoad(ctx, op, func(context.Context) (int64, error) { return 2, nil })
		if err != nil || first != 2 {
			t.Fatalf("replacement first: %v %v", first, err)
		}
		close(release)
		original := <-done
		if original.value != 1 || original.err != nil {
			t.Fatalf("old source: %+v", original)
		}
		second, err := c.GetOrLoad(ctx, op, func(context.Context) (int64, error) { t.Error("replacement memo lost"); return 3, nil })
		if err != nil || second != 2 {
			t.Fatalf("replacement memo: %v %v", second, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	value, err := c.GetOrLoad(detached, op, func(context.Context) (int64, error) { return 4, nil })
	if err != nil || value != 4 {
		t.Fatalf("detached source: %v %v", value, err)
	}
}

func TestNestedDisablePreservesMemoAndOutsideDoesNotShare(t *testing.T) {
	c := New(Options[int64]{LocalCapacity: 10000})
	op := coreOperation("nested")
	op.Policy.RequestLocal = true
	var calls atomic.Int64
	load := func(context.Context) (int64, error) { return calls.Add(1), nil }
	if err := c.Enable(context.Background(), func(ctx context.Context) error {
		value, err := c.GetOrLoad(ctx, op, load)
		if err != nil || value != 1 {
			t.Fatalf("first: %v %v", value, err)
		}
		return c.Disable(ctx, func(disabled context.Context) error {
			value, err := c.GetOrLoad(disabled, op, load)
			if err != nil || value != 2 {
				t.Fatalf("disabled: %v %v", value, err)
			}
			return c.Enable(disabled, func(reenabled context.Context) error {
				value, err := c.GetOrLoad(reenabled, op, load)
				if err != nil || value != 1 {
					t.Fatalf("reenabled: %v %v", value, err)
				}
				return nil
			})
		})
	}); err != nil {
		t.Fatal(err)
	}
	for expected := int64(3); expected <= 4; expected++ {
		value, err := c.GetOrLoad(context.Background(), op, load)
		if err != nil || value != expected {
			t.Fatalf("outside: %v %v", value, err)
		}
	}
}
