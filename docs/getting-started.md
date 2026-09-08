# Getting started

[Documentation](index.md) · Next: [How DialCache works](concepts.md)

Start with a process-local cache so you can see the behavior without running
Redis. Then choose a request boundary and connect runtime policy.

## Install

```bash
npm install dialcache
```

The supported Node.js range is `>=22.15.0 <23.0.0 || >=23.8.0`.
The package provides ESM and CommonJS entry points and TypeScript declarations.

## Wrap a reader

Create one long-lived instance for the service and register reusable readers
once. The function you wrap is the source loader: DialCache invokes it whenever
the active cache layers cannot supply a value. Save this as `example.mts`:

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache();
let sourceReads = 0;

async function fetchUser(userId: string) {
  sourceReads += 1;
  return { id: userId, name: "Ada" };
}

const getUser = dialcache.cached(fetchUser, {
  keyType: "user_id",
  useCase: "GetUser",
  cacheKey: (userId) => userId,
  defaultConfig: new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.LOCAL]: 60 },
  }),
});

await dialcache.enable(async () => {
  await getUser("123");
  await getUser("123");
});
console.log(sourceReads); // 1

await getUser("123");
console.log(sourceReads); // 2: caching is off outside enable().
```

Run it directly with Node; no TypeScript runner is needed:

```bash
node --experimental-strip-types example.mts
```

It prints:

```text
1
2
```

The `.mts` extension selects ESM, so top-level `await` works even in a project
that otherwise uses CommonJS. The flag removes TypeScript annotations; use your
project's TypeScript compiler for typechecking. Replace `fetchUser` with the
real read when integrating the example into your service.

If that read returns `Date`, `bigint`, or other non-JSON-compatible values,
provide a [typed serializer](redis.md#typed-serializer-requirement). This is
required even when caching only in local memory; the linked example shows how
to preserve a `Date` through serialization.

The wrapper preserves the input parameters and always returns a `Promise`.
`keyType` identifies the entity kind; `useCase` identifies the operation.
`cacheKey` selects the result's identity. Include every input that can change
the result, such as locale or tenant. [Keys and identity](keys.md) explains
the components and how they group tracked results for invalidation.

The example enables only process-local storage, with a 60-second TTL and an
implicit 100% ramp. Its LRU holds up to 10,000 entries across all use cases on
the instance. Neither request-local nor remote caching is enabled here.

## Choose the enabled scope

Wrap read-request handling in `enable()` so nested readers inherit the policy
through Node's `AsyncLocalStorage`. Use `disable()` for nested uncached work:

```ts
await dialcache.enable(async () => {
  const cached = await getUser("123");
  const fromSource = await dialcache.disable(() => getUser("123"));
  return { cached, fromSource };
});
```

Nested scopes restore the preceding state when they settle. `disable()` bypasses
caching; it does not remove old entries. After a mutation, freshness still
depends on the reader's TTL or [invalidation policy](invalidation.md).

To memoize only within the outer enabled scope, use
`new DialCacheKeyConfig({ requestLocal: true })`. That storage has no TTL or
capacity limit and is released when the scope settles. Keep the scope and its
key count bounded.

## Keep a calculation inline

Use `getOrLoad()` when extracting a reusable reader would obscure the code:

```ts
const userId = "456";
const user = await dialcache.enable(() =>
  dialcache.getOrLoad(() => fetchUser(userId), {
    keyType: "user_id",
    useCase: "InlineGetUser",
    key: userId,
    defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
  }),
);
```

It uses the same cache path as `cached()`. The direct `key` replaces the selector,
and the use case can be repeated at the call site without registration.

## Introduce runtime policy

Keep stable defaults next to the reader. A `cacheConfigProvider` can return
sparse overrides for each enabled invocation. The provider runs before cache
lookup, so keep it inexpensive and bound any asynchronous work it starts.

```ts
const policies = new Map<string, DialCacheKeyConfig>();
const controlledCache = new DialCache({
  cacheConfigProvider: (key) => policies.get(key.useCase) ?? null,
});

const readUser = controlledCache.cached(fetchUser, {
  keyType: "user_id",
  useCase: "ReadUser",
  cacheKey: (userId) => userId,
  defaultConfig: new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.LOCAL]: 60 },
    ramp: { [CacheLayer.LOCAL]: 0 },
  }),
});

policies.set("ReadUser", new DialCacheKeyConfig({
  ramp: { [CacheLayer.LOCAL]: 10 },
}));
await controlledCache.enable(() => readUser("123"));

policies.set("ReadUser", DialCacheKeyConfig.disabled());
```

The map stands in for your configuration system. The 10% ramp selects a stable
cohort of keys and inherits the 60-second TTL. It is not a traffic percentage.
The disabled overlay stops new cache use and shadow admission; it does not
cancel work already in flight.

Changing a TTL also has different effects on existing local and Redis entries.
Read [Changing policy on a running service](configuration.md#changing-policy-on-a-running-service)
before using a runtime change to tighten freshness.

## Add shared caching when needed

Install a supported client, connect it, and pass its DialCache adapter in
`redis.client`. Add a remote TTL to each participating reader. Start its remote
serving ramp at zero while verifying the configuration and observability.

[Redis and Valkey](redis.md) provides setup for node-redis and GLIDE, including
Cluster routing and connection ownership. [Observability](observability.md)
shows the optional Prometheus and Datadog integrations.

For mutable data, read [Targeted invalidation](invalidation.md) before enabling
shared cache serving. For a rollout that compares Redis with the source first,
continue to [Shadow validation](shadow-validation.md).
