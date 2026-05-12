# @rungalileo/gcache

TypeScript port of GCache. Milestone 1 intentionally ships a usable local-only library first: explicit enabled contexts, stable key construction, local TTL caching, and fail-open behavior.

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

## Milestone 1 scope

Included:

- Local TTL cache
- Explicit enabled context
- Explicit key builders
- Duplicate and reserved use-case validation
- `delete` and `flushAll`
- Fail-open behavior for key/config/cache errors

Not included yet:

- Redis
- Runtime ramp controls
- Prometheus metrics
- Targeted invalidation
- Framework middleware helpers
