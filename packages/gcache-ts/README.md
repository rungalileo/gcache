# @rungalileo/gcache

TypeScript port of GCache. Milestone 2 ships explicit enabled contexts, stable key construction, local TTL caching, and optional Redis-backed distributed TTL caching with fail-open behavior.

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

## Milestone 2 scope

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

Not included yet:

- Targeted invalidation and watermarks
- Runtime ramp controls
- Prometheus metrics
- Framework middleware helpers
