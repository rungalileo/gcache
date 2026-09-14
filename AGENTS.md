# AGENTS.md

## Project Overview

gcache is a fine-grained caching library with multi-layer support (local + Redis) and a decorator-based API. It works with both sync and async functions.

## Structure

```
src/gcache/
├── __init__.py              # Public API exports
├── config.py                # GCacheKey, GCacheKeyConfig, GCacheConfig, RedisConfig, Envelope,
│                            #   Serializer, JsonSerializer, Fallback
├── exceptions.py            # All exception classes
├── gcache.py                # GCache main class, @cached decorator, aget/aput direct keys
├── proto_serializer.py      # ProtoJsonSerializer (protobuf extra; imported lazily)
└── _internal/               # Implementation details (not public API)
    ├── constants.py         # Named constants (cache sizes, TTLs, thresholds)
    ├── envelope.py          # Value framing: pickle vs the cross-language JSON envelope
    ├── event_loop_thread.py # EventLoopThread, EventLoopThreadPool
    ├── local_cache.py       # LocalCache (TTLCache-based)
    ├── metrics.py           # GCacheMetrics (Prometheus)
    ├── redis_cache.py       # RedisCache
    └── wrappers.py          # CacheController, CacheChain

tests/
├── conftest.py              # Fixtures (redis_server, gcache, cache_config_provider)
├── test_conformance.py      # Python half of the shared cross-language corpus
├── test_cross_language.py   # Go<->Python round trip, drives a locally-built gcachectl
└── test_*.py                # Test suites

packages/gcache-ts/          # TypeScript port (pnpm workspace member, versioned separately)
├── src/                     # Mirrors src/gcache/ module-for-module
└── test/gcache-conformance.test.ts   # TypeScript half of the shared corpus

go/                          # Go client (module github.com/rungalileo/gcache/go)
├── cache.go                 # Cache[V]: Get/Put/Invalidate, Result, Options
├── envelope.go              # The cross-language JSON envelope; refuses pickle
├── key.go                   # Key grammar, ValueKey, WatermarkKey
├── rueidis_client.go        # Client impl over rueidis, with OTel spans
├── conformance_test.go      # Go half of the shared corpus
├── protocodec/              # protojson Codec, kept out of the core import graph
├── redislive/               # Live-Redis tests, in their own package to keep core hermetic
└── cmd/gcachectl/           # CLI; also what the Go<->Python suite drives
```

**Three implementations, one wire protocol.** Python is the reference and the published
package; TypeScript and Go are independent ports that must agree with it on the wire. They are
versioned separately (`gcache-ts` at 0.1.0, `go/` at v0.1.0, Python at 2.x) because a package
version is the wrong instrument for wire compatibility -- see the conformance section below
for the one that is.

Commands are the same shape for each:

```bash
inv test          inv test-ts          inv test-go       inv test-all
inv type-check    inv typecheck-ts     inv vet-go
inv test-conformance                   # all three against the shared corpus
```

These shell out to each language's own tooling -- poetry/pytest, pnpm/tsc, go build/test.
Deliberately not a build system: three independent ports share no build graph, which is the
only thing Bazel or Nx exists to exploit. The Go client arrived carrying five BUILD.bazel
files and they were dropped for that reason.

## Key Components

- **GCache**: Singleton main class, provides `@cached` decorator
- **CacheLayer**: Enum - `NOOP`, `LOCAL` (TTLCache), `REMOTE` (Redis)
- **CacheChain**: Chains local → redis with read-through strategy
- **EventLoopThreadPool**: Runs async code from sync cached functions (16 threads)
- **GCacheKey**: Frozen dataclass for cache keys (key_type, id, use_case, args)

## Critical Patterns

1. **Context-based enable**: Cache is disabled by default - use `with gcache.enable():`

2. **Sync functions use thread pool**: Sync `@cached` functions run through `EventLoopThreadPool`

3. **Don't call sync cached functions from async**: Blocks event loop (logs warning)

4. **No reentrant sync calls**: Raises `ReentrantSyncFunctionDetected` - convert to async

5. **Thread-local Redis clients**: `RedisCache` stores client per-thread via `threading.local()`

## Code Conventions

- Type hints required, line length 120, ruff + mypy
- Python 3.10+ (uses `|` union syntax)
- Always use `poetry run` for all commands including git (e.g., `poetry run pytest`, `poetry run git push`)

## Testing

```bash
poetry run pytest tests/          # Python
pnpm ts:gcache:test               # TypeScript
```

### Cross-language conformance vectors

`src/gcache/conformance/envelope_vectors.json` is the single source of truth for envelope wire
behaviour and key rendering. It is read by ALL THREE suites: `tests/test_conformance.py`,
`packages/gcache-ts/test/gcache-conformance.test.ts` and `go/conformance_test.go`.

Run them together with `inv test-conformance`. CI runs it on **every** PR with no path filter,
unlike the per-language workflows -- it is the only job that checks the three clients agree,
and filtering it would recreate the hole that bringing the Go client in-repo closed.

**Do not copy a case into either suite.** Parity used to be asserted by hand-mirrored literals
in two suites that run in separate CI workflows, so a divergence was only caught by a human
reading both — and two escaped that way (an empty `urn_prefix`, and a fractional timestamp)
and were found in review rather than by a test. A mirrored copy restores exactly that failure
mode: each suite then passes against its own assumptions.

To add a case, edit the JSON and run all three suites. Every vector must carry a `why`, and an
`expect: "accept"` case must declare what it decodes to. Changing a vector's expectation
should fail **all three**; if only two fail, the third is not really reading the file. The
conformance workflow asserts that property by mutating a vector and requiring three failures.

`keyRendering.cases` carry an `agreeingClients` partition rather than a boolean, because the
real situation is 2-of-3: Go and Python render identically, TypeScript percent-encodes. Each
suite asserts its own client's column against what it actually renders, plus that the
partition matches the recorded strings -- so the file cannot claim an agreement its own values
contradict. More than one group requires a `reason`.

## Releasing

Two independent release paths, both manual `workflow_dispatch`.

**Python** — `release.yaml`. python-semantic-release reads Conventional Commit titles, bumps
`pyproject.toml:project.version`, writes CHANGELOG.md, tags `vX.Y.Z`, and publishes to PyPI.

**Go** — `go-release.yaml`, input e.g. `v0.1.0`. A Go release is a **git tag and nothing
else**: no registry, no artifact, no publish step. Consumers fetch through
`proxy.golang.org`.

```
git tag           go/v0.1.0        <- what the workflow creates
consumer go.mod   github.com/rungalileo/gcache/go v0.1.0
```

The `go/` prefix is only how git stores a subdirectory module's tag; consumers write the bare
version and Go maps between them. Pass `v0.1.0`, not `go/v0.1.0` — the workflow adds the
prefix and rejects input that already has it.

**A published Go version is permanent.** `proxy.golang.org` caches module versions immutably,
so a broken `go/v0.1.0` cannot be re-tagged — you burn the version and ship `go/v0.1.1`. The
workflow therefore validates *before* tagging: version format, tag collision, gofmt, vet,
`go test`, and the full three-client conformance suite. It is the only irreversible action in
this repo.

**Do not tag by hand.** A bare `v0.1.0` already exists from the Python package's history
(`0bc6951`, 2025-02-24), so a mistyped tag attaches silently to the wrong thing. The workflow
guards both forms.

**Why not one version for all three.** Lockstep versioning is a real argument for a monorepo,
and it is declined here for a concrete reason: Go requires a major-version suffix in the
module path from v2, so sharing the namespace would make a future Python 3.0.0 force a
breaking import-path change (`/v2/go` → `/v3/go`) on Go consumers for reasons unrelated to Go.
The thing lockstep is *for* — knowing two clients agree on the wire — is covered mechanically
by `envelopeVersion` in the shared corpus, which a package version cannot do because it cannot
fail a test.

Do not wire the Go module into python-semantic-release. It emits bare `v{version}` from
`pyproject.toml` and has no concept of a second module; making it produce `go/` tags means
`tag_format` changes that would break the Python tags.

## Common Gotchas

- GCache is singleton - second instantiation raises `GCacheAlreadyInstantiated`
- "watermark" is reserved use_case name - rejected by both `@cached` and `GCacheKey`
- Local cache cannot be invalidated across instances (TTL-only)
- `WATERMARK_TTL_SECONDS` (4 hours) must exceed your longest cache TTL for invalidation to work
- uvloop is optional - falls back to asyncio on Windows/PyPy

## Dependencies

Core: pydantic, prometheus-client, cachetools, redis
Optional: uvloop; protobuf (extra `protobuf`, needed only for `ProtoJsonSerializer`)
