package dialcache

import (
	"context"
	"errors"
	"net"
	"reflect"
	"testing"

	"github.com/redis/go-redis/v9"
)

type redisCommandHook struct{ run func(redis.Cmder) error }

func (h redisCommandHook) DialHook(next redis.DialHook) redis.DialHook {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		return nil, errors.New("unexpected network access")
	}
}
func (h redisCommandHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error { return h.run(cmd) }
}
func (h redisCommandHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return next
}
func hookedRedis(t *testing.T, run func(redis.Cmder) error) *RedisAdapter {
	t.Helper()
	client := redis.NewClient(&redis.Options{Addr: "unused", MaxRetries: -1})
	client.AddHook(redisCommandHook{run})
	t.Cleanup(func() { _ = client.Close() })
	return NewRedisAdapter(client)
}

func TestRedisAdapterMutationDispatch(t *testing.T) {
	var calls [][]any
	adapter := hookedRedis(t, func(cmd redis.Cmder) error {
		calls = append(calls, append([]any{}, cmd.Args()...))
		cmd.(*redis.Cmd).SetVal("OK")
		return nil
	})
	frame := Frame{CreatedAtMS: 1700000000000, Binary: true, Payload: []byte{0, 1, 255}}
	if err := adapter.WriteMilliseconds(context.Background(), "value", frame, 1.1); err != nil {
		t.Fatal(err)
	}
	encoded, _ := EncodeFrame(frame)
	if len(calls) != 1 || !reflect.DeepEqual(calls[0], []any{"SET", "value", encoded, "PX", "2"}) {
		t.Fatalf("commands %#v", calls)
	}
	for _, ttl := range []float64{0, -1, 31536000000.1} {
		if err := adapter.WriteMilliseconds(context.Background(), "value", frame, ttl); err == nil {
			t.Fatal("invalid TTL accepted")
		}
	}
	if len(calls) != 1 {
		t.Fatal("invalid input dispatched")
	}
	calls = nil
	adapter = hookedRedis(t, func(cmd redis.Cmder) error {
		calls = append(calls, append([]any{}, cmd.Args()...))
		if cmd.Name() == "evalsha" {
			return errors.New("ambiguous response loss")
		}
		cmd.(*redis.Cmd).SetVal(int64(1))
		return nil
	})
	if err := adapter.Invalidate(context.Background(), "watermark", 1700000000000, 100); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 || calls[0][0] != "evalsha" || calls[1][0] != "eval" || !reflect.DeepEqual(calls[0][2:], calls[1][2:]) {
		t.Fatalf("retry changed logical arguments %#v", calls)
	}
	calls = nil
	adapter = hookedRedis(t, func(cmd redis.Cmder) error {
		calls = append(calls, cmd.Args())
		cmd.(*redis.Cmd).SetVal("1")
		return nil
	})
	if err := adapter.Invalidate(context.Background(), "watermark", 1, 0); err == nil || len(calls) != 1 {
		t.Fatal("invalid accepted reply retried", calls, err)
	}
}
func TestRedisAdapterReadsAndBoundaries(t *testing.T) {
	raw, _ := EncodeFrame(Frame{CreatedAtMS: 2, Payload: []byte("1")})
	for _, test := range []struct {
		reply        []any
		kind, reason string
		fails        bool
	}{
		{[]any{string(raw), "1"}, "hit", "", false},
		{[]any{string(raw), "2"}, "miss", "watermark_fenced", false},
		{[]any{nil, "5"}, "miss", "value_absent", false},
		{[]any{string(raw), nil}, "hit", "", false},
		{[]any{string(raw), "bad"}, "miss", "unclassified", false},
		{[]any{string(raw)}, "", "", true}, {[]any{12, nil}, "", "", true}, {[]any{string(raw), false}, "", "", true},
	} {
		adapter := hookedRedis(t, func(cmd redis.Cmder) error {
			if !reflect.DeepEqual(cmd.Args(), []any{"mget", "value", "watermark"}) {
				t.Fatal(cmd.Args())
			}
			cmd.(*redis.SliceCmd).SetVal(test.reply)
			return nil
		})
		got, err := adapter.Read(context.Background(), "value", "watermark")
		if (err != nil) != test.fails || !test.fails && (got.Kind != test.kind || got.Reason != test.reason) {
			t.Fatalf("reply %#v: %#v %v", test.reply, got, err)
		}
	}
	for _, reply := range []any{nil, "", 0, int64(0), float64(1), "1", []byte("1")} {
		if ValidateRedisInvalidationReply(reply) == nil {
			t.Fatalf("invalid invalidation reply %T accepted", reply)
		}
	}
	for _, reply := range []any{nil, "ok", true, 1} {
		if ValidateRedisSetReply(reply) == nil {
			t.Fatalf("invalid SET reply %T accepted", reply)
		}
	}
}
func TestNormalizeReadResultBoundary(t *testing.T) {
	fence := uint64(10)
	tests := []struct {
		raw     any
		tracked bool
		reason  string
		fence   *uint64
		hit     bool
	}{
		{nil, true, "unclassified", nil, false}, {42, true, "unclassified", nil, false},
		{map[string]any{"kind": "miss", "reason": "invented", "observedWatermarkMs": 10}, true, "unclassified", &fence, false},
		{map[string]any{"kind": "miss", "reason": "watermark_fenced"}, true, "unclassified", nil, false},
		{map[string]any{"kind": "miss", "reason": "watermark_fenced", "observedWatermarkMs": 10}, false, "unclassified", nil, false},
		{map[string]any{"kind": "miss", "reason": "value_absent", "observedWatermarkMs": 1.5}, true, "value_absent", nil, false},
		{map[string]any{"kind": "miss", "reason": "value_absent", "createdAtMs": 2, "payload": "1"}, true, "value_absent", nil, false},
		{map[string]any{"reason": "value_absent", "observedWatermarkMs": 10, "createdAtMs": 2, "payload": "1"}, true, "", nil, true},
	}
	for _, test := range tests {
		got := NormalizeReadResult(RawReadResult(test.raw), test.tracked)
		if (got.Kind == "hit") != test.hit || got.Reason != test.reason || !reflect.DeepEqual(got.ObservedWatermarkMS, test.fence) {
			t.Fatalf("%#v: %#v", test.raw, got)
		}
	}
}
