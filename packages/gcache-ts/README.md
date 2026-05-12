# @rungalileo/gcache

TypeScript port of GCache. Milestone 3 ships explicit enabled contexts, stable key construction, local/Redis TTL caching, runtime config providers, and gradual rollout ramp controls with fail-open behavior.

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
- Redis read/write/delete/flush failures are logged and fail open; fallback results still return when fallback succeeds.
- Missing per-layer config disables that layer and falls through to the next layer/fallback.

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

## Milestone 3 scope

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

Not included yet:

- Targeted invalidation and watermarks
- Prometheus metrics
- Framework middleware helpers
