// Command gcachectl is a thin CLI over the gcache client, so the Python cross-language
// test can drive the Go side. Config from GALILEO_REDIS_HOST/PORT/PASSWORD/PROTOCOL.
//
// Usage:
//
//	gcachectl -op put        -key-type K -id I -use-case U [-tracked] -value '<json>'
//	gcachectl -op get        -key-type K -id I -use-case U [-tracked]
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

	"github.com/rungalileo/gcache/go"
)

// exitMiss distinguishes "no value" from "something went wrong". A plain non-zero exit
// would conflate the two and make the integration test unable to assert on a miss.
const exitMiss = 10

func main() {
	var (
		op             = flag.String("op", "", "put | get | invalidate | key")
		keyType        = flag.String("key-type", "", "invalidation namespace; must match Python KeyTypes.<member>.name")
		id             = flag.String("id", "", "entity id")
		useCase        = flag.String("use-case", "", "use case")
		value          = flag.String("value", "", "JSON value, for -op put")
		tracked        = flag.Bool("tracked", false, "participate in watermark invalidation")
		urnPrefix      = flag.String("urn-prefix", "urn:galileo:test", "key namespace; must match the Python side")
		ttl            = flag.Duration("ttl", time.Hour, "entry TTL, for -op put")
		futureBufferMs = flag.Int("future-buffer-ms", 0, "watermark future buffer, for -op invalidate")
		args           = flag.String("args", "", "comma-separated k=v pairs folded into the key")
		disableCSC     = flag.Bool("disable-client-side-cache", true,
			"disable RESP3 CLIENT TRACKING; on by default because a one-shot process gains nothing from it")
	)
	flag.Parse()

	if err := run(*op, *urnPrefix, *keyType, *id, *useCase, *value, *args, *tracked, *ttl, *futureBufferMs, *disableCSC); err != nil {
		fmt.Fprintln(os.Stderr, "gcachectl:", err)
		os.Exit(1)
	}
}

func run(op, urnPrefix, keyType, id, useCase, value, rawArgs string, tracked bool, ttl time.Duration, futureBufferMs int, disableCSC bool) error {
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

	// json.RawMessage keeps the payload opaque: gcachectl round-trips whatever JSON the
	// test supplies without imposing a schema on it.
	cache, err := gcache.New(gcache.Options[json.RawMessage]{
		Client: client, URNPrefix: urnPrefix, TTL: ttl,
		Timeout: 5 * time.Second, // generous: a test process, not a hot path
	})
	if err != nil {
		return err
	}

	ctx := context.Background()
	switch op {
	case "put":
		if !json.Valid([]byte(value)) {
			return fmt.Errorf("-value is not valid JSON: %q", value)
		}
		return cache.Put(ctx, key, json.RawMessage(value))

	case "get":
		v, ok := cache.Get(ctx, key)
		if !ok {
			os.Exit(exitMiss)
		}
		_, err := os.Stdout.Write(v)
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
