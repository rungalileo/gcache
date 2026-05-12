# @rungalileo/gcache

TypeScript port of GCache. Milestone 4 ships explicit enabled contexts, stable key construction, local/Redis TTL caching, runtime config providers, gradual rollout ramp controls, and Prometheus-ready observability with fail-open behavior.

## Install

```bash
pnpm add @rungalileo/gcache
```

## Quick start

```ts
import { GCache, GCacheKeyConfig } from "@rungalileo/gcache";

const gcache = new GCache();

const getUser = gcache.cached({
  keyType: "user_id",
  useCase: "GetUser",
  id: ([userId]: [string]) => userId,
  defaultConfig: GCacheKeyConfig.enabled(60),
})(async (userId: string) => {
  return db.fetchUser(userId);
});

// Caching is disabled by default.
await getUser("123");

// Enable caching for one async scope.
const user = await gcache.enable(async () => {
  return await getUser("123");
});
```

## Redis-backed TTL cache

Pass a small Redis command-surface client, or a lazy factory, to enable the read-through chain:

```ts
import { GCache, GCacheKeyConfig } from "@rungalileo/gcache";

const gcache = new GCache({
  redis: {
    client: redisClient, // implements get, del, flushAll/flushall, and setEx/setex/set({ EX })
    keyPrefix: "gcache:",
  },
});
```

When caching is enabled, reads flow through:

```text
local cache -> Redis cache -> fallback function
```

- Local hits return immediately.
- Local misses try Redis and populate local on a Redis hit.
- Redis misses call the fallback and write both Redis and local.
- Redis read/write/delete/flush failures are logged, counted in metrics, and fail open; fallback results still return when fallback succeeds.
- Missing per-layer config disables that layer, records a disabled reason, and falls through to the next layer/fallback.

You can also provide `createClient` for lazy client construction:

```ts
const gcache = new GCache({
  redis: {
    createClient: async () => createRedisClient({ url: process.env.REDIS_URL }),
  },
});
```

Redis payloads use a TypeScript-specific JSON envelope, not the Python pickle format:

```ts
type RedisValueEnvelope = {
  version: 1;
  createdAtMs: number;
  expiresAtMs: number;
  encoding: "utf8" | "base64";
  payload: string;
};
```

`payload` is produced by the cached function's serializer, or by `JsonSerializer` by default. Custom serializers can return either `string` or `Buffer`; Buffer payloads are base64 encoded in the envelope.

## Runtime config and ramp controls

Every cached function can provide a decorator-local `defaultConfig`; a `cacheConfigProvider` can override it at runtime. If the provider returns `null`, GCache falls back to the cached function's `defaultConfig`. If neither exists, or a layer's TTL/ramp is missing or disabled, only that layer is skipped.

```ts
import { CacheLayer, GCache, GCacheKeyConfig } from "@rungalileo/gcache";

const gcache = new GCache({
  cacheConfigProvider: async (key) => {
    if (key.useCase === "GetUser") {
      return new GCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 30, [CacheLayer.REMOTE]: 300 },
        ramp: { [CacheLayer.LOCAL]: 100, [CacheLayer.REMOTE]: 25 },
      });
    }
    return null; // use the cached function's defaultConfig
  },
  rampSampler: ({ key, layer }) => deterministicPercentFor(`${key.urn}:${layer}`),
});
```

`ramp` values are percentages from 0 to 100. `0` disables the layer, `100` enables it, and intermediate values use `rampSampler`; the default sampler is random. Provider errors fail open and execute the fallback function.

## Enabled context

The TypeScript port uses Node `AsyncLocalStorage` to mirror Python's `with gcache.enable():` safety model.

```ts
await gcache.enable(async () => {
  await getUser("123"); // cached

  await gcache.disable(async () => {
    await updateUser("123", patch); // uncached reads here
  });

  await getUser("123"); // cached again
});
```

- Default is disabled.
- Enabled state is async-scope-local, not process-global.
- Nested `enable` / `disable` scopes restore the previous behavior when the callback completes.

## Explicit key builders

TypeScript does not have safe Python-style function argument introspection after transpilation/bundling. Use explicit key builders instead:

```ts
const searchPosts = gcache.cached({
  keyType: "user_id",
  useCase: "SearchPosts",
  id: ([userId]: [string, number, string]) => userId,
  args: ([, page, filter]) => ({ page, filter }),
  defaultConfig: GCacheKeyConfig.enabled(60),
})(async (userId: string, page: number, filter: string) => {
  return db.searchPosts(userId, page, filter);
});
```

## Metrics

GCache registers Prometheus metrics by default via `prom-client`. Metric names intentionally follow the Python package where practical:

| Metric | Type | Labels | Description |
| --- | --- | --- | --- |
| `gcache_request_counter` | Counter | `use_case`, `key_type`, `layer` | Cache-layer requests that reached an enabled layer |
| `gcache_miss_counter` | Counter | `use_case`, `key_type`, `layer` | Cache misses |
| `gcache_disabled_counter` | Counter | `use_case`, `key_type`, `layer`, `reason` | Cache skips (`context`, `missing_config`, `invalid_ttl`, `ramped_down`, `config_error`) |
| `gcache_error_counter` | Counter | `use_case`, `key_type`, `layer`, `error`, `in_fallback` | Cache/fallback errors, with `in_fallback` separating cache plumbing failures from application fallback failures |
| `gcache_invalidation_counter` | Counter | `key_type`, `layer` | Delete/invalidation calls for the layers touched today |
| `gcache_get_timer` | Histogram | `use_case`, `key_type`, `layer` | Cache get latency in seconds |
| `gcache_fallback_timer` | Histogram | `use_case`, `key_type`, `layer` | Time spent in the underlying function |
| `gcache_serialization_timer` | Histogram | `use_case`, `key_type`, `layer`, `operation` | Redis serializer dump/load latency |
| `gcache_size_histogram` | Histogram | `use_case`, `key_type`, `layer` | Serialized Redis payload size in bytes |

Use a custom registry or prefix when embedding GCache in an app with its own metrics endpoint:

```ts
import { Registry } from "prom-client";
import { GCache } from "@rungalileo/gcache";

const registry = new Registry();
const gcache = new GCache({
  metricsRegistry: registry,
  metricsPrefix: "myapp_", // myapp_gcache_request_counter, etc.
});

app.get("/metrics", async (_req, res) => {
  res.type(registry.contentType).send(await registry.metrics());
});
```

For non-Prometheus telemetry, inject a `GCacheMetricsAdapter` through `new GCache({ metrics })`. Pass `metrics: false` to disable metrics entirely. GCache reuses existing collectors in a registry so repeated instances with the same prefix do not throw duplicate-registration errors.

## Milestone 4 scope

Included:

- Local TTL cache
- Redis TTL cache
- Local → Redis → fallback read-through chain
- Lazy Redis client factory support
- Timestamped, versioned Redis envelope
- JSON and custom serializer support for Redis values
- Duplicate and reserved use-case validation
- `delete` and `flushAll` across configured layers
- Fail-open behavior for key/config/cache errors
- Runtime config provider with fallback to cached-function `defaultConfig`
- Per-layer TTL and ramp controls
- Injectable ramp sampler for deterministic rollout tests
- Missing config disables only the relevant layer and falls through
- Prometheus metrics with duplicate-registration safety
- Custom metrics adapter/registry/prefix hooks
- Cache-vs-fallback error classification through the `in_fallback` label
- Serialization latency and cached payload size metrics for Redis values
- Logger injection for cache operational failures

Not included yet:

- Targeted invalidation and watermarks beyond the current `delete`/placeholder invalidation counter
- Framework middleware helpers/integrations
