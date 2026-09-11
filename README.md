# DialCache

[![npm version](https://img.shields.io/npm/v/dialcache.svg)](https://www.npmjs.com/package/dialcache)
[![Codecov](https://codecov.io/gh/lan17/DialCache/branch/main/graph/badge.svg)](https://codecov.io/gh/lan17/DialCache)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/lan17/DialCache/badge)](https://scorecard.dev/viewer/?uri=github.com/lan17/DialCache)

DialCache is a TypeScript library that organizes caching into use cases, with
runtime control and observability for each one.

- **Off by default:** caching runs only inside an `enable()` scope.
- **Multi-layer:** request-local → process-local → Redis.
- **Runtime policies per use case:** layers, TTLs, and rollout ramps.
- **Targeted invalidation:** one call per entity for its tracked Redis results.
- **Coalescing:** same-key reads share work when a cache layer is active.
- **Fail-open:** cache failures fall back to the loader.
- **Stale-on-error (opt-in):** retained Redis values for selected source errors.
- **Shadow validation (opt-in):** cache coherence checks through sampling.
- **Observability:** Prometheus and Datadog metrics, including miss reasons.

[Documentation](https://lan17.github.io/DialCache/)
· [Getting started](https://lan17.github.io/DialCache/getting-started.html)
· [API reference](https://lan17.github.io/DialCache/api.html)

## Install

```bash
npm install dialcache
```

Requires Node.js 22.15.0 or newer within 22.x, or 23.8.0 and newer, for
`node:zlib` zstd support. Use a
[supported LTS release](https://nodejs.org/en/about/previous-releases) in production.
Install a [Redis or Valkey client](https://lan17.github.io/DialCache/redis.html)
and a [metrics client](https://lan17.github.io/DialCache/observability.html)
when using those integrations.

## Usage

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache();

// The loader: the database or service read.
async function fetchUser(userId: string) {
  console.log("Loading from source:", userId);
  return { id: userId, name: "Ada" };
}

// Register once; use getUser at read sites.
const getUser = dialcache.cached(fetchUser, {
  keyType: "user_id", // Entity kind; groups tracked results by id.
  useCase: "GetUser", // Operation name; part of the key and metric labels.
  cacheKey: (userId) => userId, // Include every input that changes the result.
  defaultConfig: new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.LOCAL]: 60 },
  }),
});

// In a service, wrap each request's reads in one enable() call.
await dialcache.enable(async () => {
  await getUser("123"); // Loads from source and caches the result.
  await getUser("123"); // Reuses the value for up to 60 seconds.
});

await getUser("123"); // Outside enable(): loads from source again.
```

Results containing `Date`, `bigint`, or other non-JSON-compatible values need an
explicit [typed serializer](https://lan17.github.io/DialCache/redis.html#typed-serializer-requirement),
even when caching only in memory. Cached objects are shared references; copy
before modifying.


[`getOrLoad()`](https://lan17.github.io/DialCache/api.html#getorload) provides the
same cache path for an inline loader and a direct key.

<a id="enabled-scope"></a>
<a id="cache-layers"></a>

## How reads work

Wrap each request's reads in one `enable()` call. Use `disable()` for nested
mutation work; it restores pass-through behavior without evicting anything.
Within an enabled call, the first active layer with a hit returns the value:

```text
request-local → process-local → Redis / Valkey → loader
```

| Layer | Shared across | Lifetime |
| --- | --- | --- |
| Request-local | Calls in one outer `enable()` scope | Until that scope settles |
| Process-local | Requests using one `DialCache` instance | Insertion TTL, bounded by LRU capacity |
| Remote | Instances sharing the Redis keyspace | Physical TTL and logical age checks; optional watermarks |

Local hits bypass Redis, including its invalidation checks. A Redis hit can warm
an active local layer. Concurrent calls share work when a cache layer is active;
set `coalesce: false` when callers need independent execution.
[How DialCache works](https://lan17.github.io/DialCache/concepts.html) covers the
read path, publication rules, and freshness boundaries.

<a id="changing-policy-at-runtime"></a>

## Runtime control

An operation's `defaultConfig` is its baseline. A `cacheConfigProvider` overrides
individual policy fields for each enabled call. Ramps select stable cohorts of
keys: raising a ramp adds keys, while lowering it removes keys without
reshuffling the rest. A 10% key cohort need not account for 10% of traffic.

Policy changes apply to new invocations. They do not evict values or cancel work
already admitted. Shadow validation has an independent ramp and compares sampled
Redis values with the source in the background. It can also fill misses while
remote serving is ramped down; callers do not wait for shadow checks or fills.

See [Configuration and rollout](https://lan17.github.io/DialCache/configuration.html)
for precedence and runtime examples, and
[Shadow validation](https://lan17.github.io/DialCache/shadow-validation.html)
for sampling and comparison behavior.

<a id="reference"></a>

## Documentation

| Topic | Guide |
| --- | --- |
| First reader and enabled scope | [Getting started](https://lan17.github.io/DialCache/getting-started.html) |
| Result identity and invalidation groups | [Keys and identity](https://lan17.github.io/DialCache/keys.html) |
| Defaults, overrides, and policy changes | [Configuration and rollout](https://lan17.github.io/DialCache/configuration.html) |
| Watermarks and mutation handling | [Targeted invalidation](https://lan17.github.io/DialCache/invalidation.html) |
| Recovery from selected source failures | [Stale-on-error](https://lan17.github.io/DialCache/stale-on-error.html) |
| Shared execution and deadlines | [Coalescing and liveness](https://lan17.github.io/DialCache/coalescing.html) |
| Methods, options, and exports | [API reference](https://lan17.github.io/DialCache/api.html) |
| Go implementation and shared behavior contracts | [Go guide](go/README.md) · [Quint specification](formal/README.md) · [Worked walkthrough](formal/WALKTHROUGH.md) |

The [documentation index](https://lan17.github.io/DialCache/) also links to client
setup, observability, upgrades, and the maintainer guide. Everything is
[readable as Markdown on GitHub](https://github.com/lan17/DialCache/tree/main/docs).

MIT licensed. See [LICENSE](https://github.com/lan17/DialCache/blob/main/LICENSE).
