// Command gcachectl is a thin CLI over the gcache client, so the Python cross-language
// test can drive the Go side. Config from GALILEO_REDIS_HOST/PORT/PASSWORD/PROTOCOL.
//
// Usage:
//
//	gcachectl -op put        -key-type K -id I -use-case U [-tracked] -value '<json>'
//	gcachectl -op get        -key-type K -id I -use-case U [-tracked]
//	              ... add -envelope proto to drive the BINARY envelope instead of JSON
//	gcachectl -op invalidate -key-type K -id I [-future-buffer-ms N]
//	gcachectl -op key        -key-type K -id I -use-case U [-tracked]   # print keys, no I/O
//
// `get` exits 0 with the payload on a hit, 10 on a miss, 1 on error -- so the caller can
// tell a miss from a failure.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/descriptorpb"

	"github.com/rungalileo/gcache/go"
	"github.com/rungalileo/gcache/go/protocodec"
)

// exitMiss distinguishes "no value" from "something went wrong". A plain non-zero exit
// would conflate the two and make the integration test unable to assert on a miss.
const exitMiss = 10

func main() {
	var (
		op       = flag.String("op", "", "put | get | invalidate | key")
		keyType  = flag.String("key-type", "", "invalidation namespace; must match Python KeyTypes.<member>.name")
		id       = flag.String("id", "", "entity id")
		useCase  = flag.String("use-case", "", "use case")
		value    = flag.String("value", "", "value for -op put: JSON, or protojson when -envelope proto")
		envelope = flag.String("envelope", "json",
			"json | proto -- the framing written and expected. MUST match the Python key's envelope=.")
		tracked        = flag.Bool("tracked", false, "participate in watermark invalidation")
		urnPrefix      = flag.String("urn-prefix", "urn:galileo:test", "key namespace; must match the Python side")
		ttl            = flag.Duration("ttl", time.Hour, "entry TTL, for -op put")
		futureBufferMs = flag.Int("future-buffer-ms", 0, "watermark future buffer, for -op invalidate")
		args           = flag.String("args", "", "comma-separated k=v pairs folded into the key")
		disableCSC     = flag.Bool("disable-client-side-cache", true,
			"disable RESP3 CLIENT TRACKING; on by default because a one-shot process gains nothing from it")
	)
	flag.Parse()

	if err := run(*op, *urnPrefix, *keyType, *id, *useCase, *value, *args, *tracked, *ttl, *futureBufferMs, *disableCSC, *envelope); err != nil {
		fmt.Fprintln(os.Stderr, "gcachectl:", err)
		os.Exit(1)
	}
}

func run(op, urnPrefix, keyType, id, useCase, value, rawArgs string, tracked bool, ttl time.Duration, futureBufferMs int, disableCSC bool, envelope string) error {
	args, err := parseArgs(rawArgs)
	if err != nil {
		return err
	}
	key := gcache.Key{KeyType: keyType, ID: id, UseCase: useCase, Tracked: tracked, Args: args}

	// `key` needs no Redis at all -- it just renders what this client would use, which is
	// what lets the test compare Go's key bytes against Python's without a server.
	if op == "key" {
		out := map[string]string{
			"value_key":     gcache.ValueKey(urnPrefix, key),
			"watermark_key": gcache.WatermarkKey(urnPrefix, keyType, id),
		}
		return json.NewEncoder(os.Stdout).Encode(out)
	}

	// Refuse rather than connect unauthenticated: RueidisOptions has no credential provider,
	// so on an IAM deployment an empty Password would build an unauthenticated client and
	// fail with an opaque auth error. Any value but an explicit false fails closed as "requested".
	if v := os.Getenv("GALILEO_REDIS_USE_ELASTICACHE_IAM"); !isFalsey(v) {
		return fmt.Errorf(
			"gcachectl: GALILEO_REDIS_USE_ELASTICACHE_IAM=%q, and this client supports only a "+
				"static password -- see RueidisOptions.Password", v)
	}

	client, closer, err := gcache.NewRueidisClient(gcache.RueidisOptions{
		Host:                   envOr("GALILEO_REDIS_HOST", "localhost"),
		Port:                   envOr("GALILEO_REDIS_PORT", "6379"),
		Password:               os.Getenv("GALILEO_REDIS_PASSWORD"),
		Protocol:               envOr("GALILEO_REDIS_PROTOCOL", "redis"),
		DisableClientSideCache: disableCSC,
	})
	if err != nil {
		return err
	}
	defer closer()

	ctx := context.Background()

	switch envelope {
	case "proto":
		// descriptorpb.FileOptions, not a schema of our own: gcache deliberately has no
		// .proto and no codegen pipeline, and a well-known message is already compiled into
		// BOTH languages. Python's proto tests use descriptor_pb2.FileOptions for the same
		// reason, so the two sides share a type without this repo growing a protoc step.
		cache, err := gcache.New(gcache.Options[*descriptorpb.FileOptions]{
			Client: client, URNPrefix: urnPrefix, TTL: ttl,
			Timeout:  5 * time.Second, // generous: a test process, not a hot path
			Codec:    protocodec.Proto[*descriptorpb.FileOptions](),
			Envelope: gcache.EnvelopePROTO,
		})
		if err != nil {
			return err
		}
		return runOps(ctx, cache, op, key, keyType, id, value, futureBufferMs,
			func(raw string) (*descriptorpb.FileOptions, error) {
				msg := &descriptorpb.FileOptions{}
				if err := protojson.Unmarshal([]byte(raw), msg); err != nil {
					return nil, fmt.Errorf("-value is not valid protojson for FileOptions: %w", err)
				}
				return msg, nil
			},
			// protojson on the way out, NOT the raw wire bytes: the caller must compare
			// PARSED values. Go's protojson injects randomised whitespace (internal/detrand)
			// so its output is not byte-stable even for one message, and the binary payload
			// is not text at all.
			func(msg *descriptorpb.FileOptions) ([]byte, error) { return protojson.Marshal(msg) },
		)

	case "json", "":
		// json.RawMessage keeps the payload opaque: gcachectl round-trips whatever JSON the
		// test supplies without imposing a schema on it.
		cache, err := gcache.New(gcache.Options[json.RawMessage]{
			Client: client, URNPrefix: urnPrefix, TTL: ttl,
			Timeout: 5 * time.Second, // generous: a test process, not a hot path
		})
		if err != nil {
			return err
		}
		return runOps(ctx, cache, op, key, keyType, id, value, futureBufferMs,
			func(raw string) (json.RawMessage, error) {
				if !json.Valid([]byte(raw)) {
					return nil, fmt.Errorf("-value is not valid JSON: %q", raw)
				}
				return json.RawMessage(raw), nil
			},
			func(v json.RawMessage) ([]byte, error) { return v, nil },
		)

	default:
		return fmt.Errorf("unknown -envelope %q: want json or proto", envelope)
	}
}

// runOps is the op switch, generic over the value type so the JSON and PROTO paths cannot
// drift apart -- a miss must exit with exitMiss on both, or the Python test could not tell
// a miss from a failure for one envelope and not the other.
func runOps[V any](
	ctx context.Context, cache *gcache.Cache[V], op string, key gcache.Key,
	keyType, id, value string, futureBufferMs int,
	decode func(string) (V, error), encode func(V) ([]byte, error),
) error {
	switch op {
	case "put":
		v, err := decode(value)
		if err != nil {
			return err
		}
		return cache.Put(ctx, key, v)

	case "get":
		v, ok := cache.Get(ctx, key)
		if !ok {
			os.Exit(exitMiss)
		}
		out, err := encode(v)
		if err != nil {
			return err
		}
		_, err = os.Stdout.Write(out)
		return err

	case "invalidate":
		return cache.Invalidate(ctx, keyType, id, time.Duration(futureBufferMs)*time.Millisecond)

	default:
		return fmt.Errorf("unknown -op %q", op)
	}
}

// parseArgs turns "a=1,b=2" into key args (order doesn't matter -- the key renderer
// sorts). A pair with no "=" errors rather than silently skips: since this binary compares
// key rendering against Python, dropping it would surface as a key MISMATCH, not a flag typo.
func parseArgs(raw string) ([]gcache.Arg, error) {
	if raw == "" {
		return nil, nil
	}
	var out []gcache.Arg
	for _, pair := range strings.Split(raw, ",") {
		name, val, found := strings.Cut(pair, "=")
		if !found {
			return nil, fmt.Errorf("malformed -args pair %q: expected name=value", pair)
		}
		out = append(out, gcache.Arg{Name: name, Value: val})
	}
	return out, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// isFalsey reports whether an env var means "off". Empty counts as off; anything else not
// an explicit false counts as ON, so a typo refuses rather than silently disabling the
// check. These are the spellings pydantic accepts for a bool, matching the Python side.
func isFalsey(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "0", "f", "false", "n", "no", "off":
		return true
	}
	return false
}
