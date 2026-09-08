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
# Choose a Redis client when using the remote layer:
npm install redis@~4.7.1
# or
npm install @valkey/valkey-glide@^2.0.0
# Add a metrics client only when using its adapter:
npm install prom-client@^15.1.3
# or
npm install hot-shots@^17.0.0
```

DialCache requires Node.js with zstd support in `node:zlib`: 22.15.0 or newer
within the 22.x line, or 23.8.0 and newer (23.0–23.7 lack zstd and are
excluded). Production deployments should use a
[currently supported LTS release](https://nodejs.org/en/about/previous-releases).

## Usage

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache();

// The loader: the database or service read.
async function fetchUser(userId: string) {
  console.log("Loading from source:", userId);
  return { id: userId, name: "Ada" };
}

// The cached function. A drop-in replacement for fetchUser.
const getUser = dialcache.cached(fetchUser, {
  keyType: "user_id", // Entity kind; with the id, the unit of invalidation.
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

  // Inline form: a direct key instead of cacheKey, and no registration.
  // Call sites that share a key share cached entries.
  const inline = {
    keyType: "user_id",
    useCase: "GetUserInline",
    key: "456",
    defaultConfig: new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: 60 } }),
  };
  await dialcache.getOrLoad(() => fetchUser("456"), inline); // Loads from source.
  await dialcache.getOrLoad(() => fetchUser("456"), inline); // Reuses the value.
});

await getUser("123"); // Outside enable(): loads from source again.
```

Results containing `Date`, `bigint`, or other non-JSON-compatible values need an
explicit [typed serializer](https://lan17.github.io/DialCache/redis.html#typed-serializer-requirement),
even when caching only in memory. Cached objects are shared references; copy
before modifying.

## Enabled scope

Caching is **off by default**. Outside an `enable()` scope, `cached()` and
`getOrLoad()` just run the loader. **Enable once at the request boundary**, such
as a middleware around read handlers, so call sites need no changes, and wrap
mutation handlers in `disable()` so a write path cannot cache a read it is about
to make stale:

```ts
await dialcache.enable(async () => {
  await getUser("123"); // Cached.

  await dialcache.disable(async () => {
    await updateUser("123", patch); // Reads in here go to the source.
  });

  await getUser("123"); // Cached again; disable() evicts nothing.
});
```

## Cache layers

Inside `enable()`, a call checks each active layer in order and stops at the
first hit. A miss at every layer runs the loader:

```text
request-local → process-local → Redis / Valkey → loader
```

| Layer | Shares values across | Lifetime | Typical use |
| --- | --- | --- | --- |
| Request-local | Calls in one outer `enable()` scope | Until that scope settles | Avoid repeated reads within a request |
| Process-local | Requests using one `DialCache` instance | TTL, bounded by LRU capacity | Avoid repeated reads between requests |
| Remote | Application instances using the same Redis keyspace | TTL, with optional invalidation tracking | Reuse reads across processes |

Layers combine: a Redis hit can warm an active process-local cache, and an
active request-local layer memoizes what the layers below return. The
[read-path guide](https://lan17.github.io/DialCache/concepts.html) lists what is
stored after each kind of hit or miss.

When a cache layer is active, concurrent calls for the same key share work by
default. Request-local caching shares work within the outer `enable()` scope;
process-local and remote caching share it within one `DialCache` instance.
Set `coalesce: false` to opt out. The
[coalescing guide](https://lan17.github.io/DialCache/coalescing.html) covers the
results, errors, and deadlines a waiting caller inherits.

## Changing policy at runtime

Each use case's `defaultConfig` is its baseline; a `cacheConfigProvider` on the
instance overrides individual fields on every enabled call. This example starts
with local caching ramped to zero, then opens it to a 10% cohort of keys:

```ts
// The application's configuration system feeds this map.
const policies = new Map<string, DialCacheKeyConfig>();
const cache = new DialCache({
  cacheConfigProvider: (key) => policies.get(key.useCase) ?? null,
});

const readUser = cache.cached(fetchUser, {
  keyType: "user_id",
  useCase: "ReadUser",
  cacheKey: (userId) => userId,
  defaultConfig: new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.LOCAL]: 60 },
    ramp: { [CacheLayer.LOCAL]: 0 },
  }),
});

// Use a 10% ramp and keep the baseline TTL.
policies.set("ReadUser", new DialCacheKeyConfig({
  ramp: { [CacheLayer.LOCAL]: 10 },
}));

await cache.enable(() => readUser("123"));

// Stop cache use and new shadow work for this use case.
policies.set("ReadUser", DialCacheKeyConfig.disabled());
```

A ramp selects a stable set of keys, not a share of traffic: raising it adds
keys to the cohort, and lowering it removes keys without reshuffling the rest.
Policy changes apply to new calls only. They do not evict cached values, and
[a shorter TTL affects local and Redis entries differently](https://lan17.github.io/DialCache/configuration.html#changing-policy-on-a-running-service).

Shadow validation uses sampling to check cache coherence: it compares Redis
values with the source in the background. It can also fill misses while remote
serving is ramped down. Callers do not wait for these checks or fills. Serving
and shadow ramps are independent; `disabled()` stops both for new calls without
cancelling work already admitted.

[Runtime configuration](https://lan17.github.io/DialCache/configuration.html)
· [Shadow validation](https://lan17.github.io/DialCache/shadow-validation.html)

## Reference

The [reference](https://lan17.github.io/DialCache/) covers setup, behavior, APIs,
and operational details. It can also be
[read as Markdown on GitHub](https://github.com/lan17/DialCache/tree/main/docs).

| Task | Guide |
| --- | --- |
| Add caching to a service | [Getting started](https://lan17.github.io/DialCache/getting-started.html) |
| Understand what runs on a hit, miss, or error | [How DialCache works](https://lan17.github.io/DialCache/concepts.html) |
| Look up methods, options, and exports | [API reference](https://lan17.github.io/DialCache/api.html) |
| Set keys, layers, TTLs, and rollout policy | [Configuration](https://lan17.github.io/DialCache/configuration.html) |
| Connect Redis or Valkey; customize serialization | [Redis and Valkey](https://lan17.github.io/DialCache/redis.html) |
| Invalidate cached results when an entity changes | [Targeted invalidation](https://lan17.github.io/DialCache/invalidation.html) |
| Serve a retained value when the source fails | [Stale-on-error](https://lan17.github.io/DialCache/stale-on-error.html) |
| Validate cache coherence through sampling | [Shadow validation](https://lan17.github.io/DialCache/shadow-validation.html) |
| Understand shared work and deadlines | [Coalescing and liveness](https://lan17.github.io/DialCache/coalescing.html) |
| Build dashboards and diagnose misses | [Observability](https://lan17.github.io/DialCache/observability.html) |
| Upgrade, validate, or contribute | [Upgrading](https://lan17.github.io/DialCache/upgrading.html) · [Maintainer guide](https://lan17.github.io/DialCache/maintainers.html) |

MIT licensed. See [LICENSE](https://github.com/lan17/DialCache/blob/main/LICENSE).
