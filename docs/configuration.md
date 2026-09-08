# Configuration

[Documentation](index.md) · [API reference](api.md)

Configure DialCache at three levels: instance resources, operation defaults,
and a runtime overlay. An enabled scope permits caching; the resolved policy
decides which layers participate.

| Level | Configure here | Lifetime |
| --- | --- | --- |
| Instance | Namespace, Redis client, LRU capacity, telemetry, shadow capacity | One `DialCache` instance |
| Operation | Key, serializer, invalidation tracking, deadlines, policy defaults | One registered reader or inline invocation |
| Runtime | Layer TTLs and ramps, request-local, coalescing, shadow, recovery age | One enabled invocation |

Start with the [read-path overview](concepts.md) if these layers are new to you.
The [API reference](api.md) collects the public signatures and defaults;
[Redis and Valkey](redis.md) covers the remote layer in detail.

## Defining cache operations

Use `cached(fn, options)` to register a reusable reader once per instance.
The wrapper preserves its parameters and always returns a `Promise`. Each
registration needs a unique `useCase`; duplicates throw
`UseCaseIsAlreadyRegisteredError`.
Invalid static defaults or source timeouts fail before registration, so fixing
them and retrying can reuse the same name.

Use `getOrLoad(load, options)` for a zero-argument loader that belongs at one call
site. It runs through the same cache path, but accepts a direct `key` instead
of a `cacheKey` selector and does not register the use case. Both APIs reject
the internal name `"watermark"` with `UseCaseNameIsReservedError`.

The [operation options table](api.md#operation-options) covers serializers,
invalidation tracking, comparators, error classifiers, and source deadlines.
Prefer stable, deployment-defined use-case names such as `"BuildProfile"`.
Names are part of cache identity and metric labels; put user, request, and
entity dimensions in the key instead.

For an inline loader, every captured value that can change the result belongs
in the key. All call sites for one identity must agree on value meaning and
serialization. With coalescing enabled, concurrent calls can also share one
caller's loader and its execution policy; see
[What followers inherit](coalescing.md#what-followers-inherit).

Shadow work can run the loader after the caller has continued. Snapshot mutable
arguments or captured state before invoking the operation so that the detached
read still represents the selected key.

## Enable and disable scopes

DialCache performs cache work only inside an enabled asynchronous scope. Most
services create one instance and reuse it for the service process. Each
instance owns one process-local LRU, one process-coalescing registry, and one
shadow deduplication and capacity registry. Create separate instances only
when those resources should be isolated:

| API | Behavior |
| --- | --- |
| `enable(fn)` | Enables caching for `fn` and the asynchronous work it awaits. The outermost call owns any request-local state. |
| `disable(fn)` | Temporarily restores pass-through behavior, commonly around nested mutation work. It does not evict existing values. |
| `isEnabled()` | Reports whether the current asynchronous call chain is inside a live enabled scope. |
| `withEnabled(fn)` | Exact alias for `enable(fn)`. |
| `withDisabled(fn)` | Exact alias for `disable(fn)`. |

All five methods are instance-scoped. `enable()` and `disable()` always return a
`Promise`, including when their callback returns synchronously. Nested scopes
restore the previous state when their callbacks settle, and a nested
`enable()` inside `disable()` can opt a smaller read region back in.

Enabled state follows Node's `AsyncLocalStorage`; it is not a process-global
flag. Once the outermost `enable()` callback settles, new invocations in detached
work that inherited the old context are pass-through. Closure does not cancel
already admitted cache operations: they can finish and publish to shared layers
under their normal policy and deadline rules, but cannot repopulate the closed
request-local state. An invocation still awaiting its configuration provider
when the scope closes skips cache lookup and runs its loader with the fallback
deadline it acquired while enabled.

The root-exported `DialCacheContext` exposes the lower-level
`enable()`, `disable()`, and `isEnabled()` context primitive. It does not attach
itself to a `DialCache` instance or perform cache work. Most applications should
use the methods on `DialCache`.

Keep mutation work outside the enabled boundary or inside `disable()`. Because
disabling does not evict existing values, mutable data still needs an
appropriate TTL or [targeted invalidation](invalidation.md) policy.

## Keys, ids, and extra dimensions

For `cached()`, the required `cacheKey` selector receives the wrapped
function's inferred parameters. `getOrLoad()` accepts the same bare id or
`{ id, args }` shape directly through `key`:

```ts
const searchPosts = dialcache.cached(
  (userId: string, page: number, filter: string) =>
    db.searchPosts(userId, page, filter),
  {
    keyType: "user_id",
    useCase: "SearchPosts",
    cacheKey: (userId, page, filter) => ({
      id: userId,
      args: { page, filter },
    }),
    defaultConfig: DialCacheKeyConfig.enabled(60),
  },
);

await dialcache.enable(() => searchPosts("u1", 2, "active"));
```

The selected or direct key is the value-identity contract. It must include
every input dimension that can affect the returned value. Otherwise, distinct
calls can reuse the same cached value or share the same in-flight fallback
through request coalescing.

### Namespace

`DialCacheConfig.namespace` is the logical cache namespace and the first
component of every key. It defaults to `"urn"`, producing keys such as
`urn:user_id:123#GetUser`.

Set a stable application-specific value when applications or environments may
share one Redis deployment:

```ts
const dialcache = new DialCache({
  namespace: "production-users-api",
  redis: { client: dialCacheRedisClient },
});
```

That produces Redis keys beginning with `production-users-api:...`, or
`{production-users-api:...}` for invalidation-tracked values. `namespace` is
DialCache's single cache-identity and key-partitioning setting. It participates
in request-local, process-local, Redis, coalescing, deterministic ramp,
invalidation, and metrics.

A namespace may not contain `{` or `}` because DialCache reserves those
characters for Redis Cluster hash tags.

### Identity rules

- **`keyType` plus `id` is the invalidation unit for tracked Redis entries.**
  `dialcache.invalidateRemote("user_id", "123", futureBufferMs)` writes one
  watermark for that user. Any tracked Redis entry with the same `keyType` and
  `id` is refreshed across all `args` variants when Redis is read. Untracked
  entries do not consult the watermark. Invalidation does not evict existing
  request-local or process-local entries.
- **`args` are part of the cache key.** Different arguments produce different
  entries, but targeted invalidation is by id rather than by argument.
- **Components are encoded with `encodeURIComponent`.** Delimiters inside an
  id, argument, or use case do not become structural separators. Namespace braces
  always throw `TypeError`; tracked `keyType` and `id` also reject `{` and `}`
  with `Error`. Untracked `keyType` and `id` may contain braces, which are encoded.
  Automatic key-construction failures follow the normal
  [fail-open path](concepts.md#fail-open-and-liveness).
- **Scalar equality is string-based.** For matching surrounding dimensions:
  - numeric `1`, string `"1"`, and bigint `1n` identify the same key; and
  - argument values `null` and `"null"` match, `-0` matches `0`, and an
    `undefined` argument is omitted.

  If a deployment changes the logical meaning represented by a scalar, change
  an explicit identity dimension such as `keyType`, `useCase`, or an argument
  name or value.
- **Non-key inputs still reach the loader.** A database handle can be a normal
  function parameter ignored by `cacheKey` or a value captured by a
  `getOrLoad()` loader. Concurrent same-key misses share the leader's execution
  unless the resolved policy explicitly sets `coalesce: false`. Do not omit
  values such as `AbortSignal`, auth context, locale, or other request-scoped
  inputs unless both sharing in-flight work and reusing a settled cache value
  are correct.
- **Methods need a receiver.** Pass `obj.method.bind(obj)` or
  `(...args) => obj.method(...args)`; a bare `obj.method` reference loses
  `this`.

### Constructing keys directly

`cached()` and `getOrLoad()` stringify ids and normalize argument records for
you. Custom integrations can construct the same public shape with
`new DialCacheKey(init)`:

| `DialCacheKeyInit` field | Default or requirement |
| --- | --- |
| `keyType`, `id`, `useCase` | Required strings |
| `namespace` | `"urn"` |
| `args` | Empty array; otherwise ordered, read-only `[string, string]` pairs |
| `defaultConfig`, `serializer` | `null` |
| `trackForInvalidation` | `false` |

The direct constructor uses argument pairs in the supplied order. It does not
normalize or sort them. Use `normalizeArgs(record)` to omit undefined values,
convert the remaining scalar values with `String`, and sort names by JavaScript
string comparison:

```ts
import { DialCacheKey, normalizeArgs } from "dialcache";

const key = new DialCacheKey({
  namespace: "app:prod",
  keyType: "user_id",
  id: "a/b",
  useCase: "Read#User",
  args: normalizeArgs({ z: 2, a: 1, omitted: undefined }),
  trackForInvalidation: true,
});

key.prefix;     // "{app%3Aprod:user_id:a%2Fb}"
key.toString(); // "{app%3Aprod:user_id:a%2Fb}?a=1&z=2#Read%23User"
```

`prefix` and `urn` are computed once; `toString()` returns `urn`. The constructor
retains supplied argument, config, and serializer references. Read-only types
do not deep-freeze these inputs; treat the key and its inputs as immutable.

`invalidationPrefix(namespace, keyType, id)` validates the same tracked identity
components and returns the encoded prefix **without** braces.
`redisClusterHashTag(value)` rejects embedded braces and adds a literal pair of
braces; it does not encode the value. Neither helper adds arguments or a use case.

### Changing a namespace

Changing `namespace` intentionally creates a cold-cache boundary across every
layer. Old and new keyspaces do not share Redis values or invalidation
watermarks.

During an overlapping deployment, an invalidation handled by one version is
invisible to the other. The other version can continue serving a stale tracked
value until its value TTL expires. If remote invalidation correctness matters,
a normal rolling namespace change is unsafe.

Use a coordinated no-overlap cutover, or an operational bridge that prevents
both versions from serving remote cache across mutations. For example,
temporarily disable and clear remote caching during the transition. After the
cutover, provision for fallback and refill load, and allow old Redis keys to
expire by TTL.

## Runtime config and ramp controls

The constructor supplies shared resources and instance defaults. See
[`DialCacheConfig`](api.md#constructor) for its options.
`DialCacheKeyConfig` supplies the baseline and per-invocation overlay: layer
TTLs and ramps, request-local caching, coalescing, remote-read timeout,
stale-recovery age, and shadow policy.

### Baseline and overlay precedence

Each operation can supply a `defaultConfig`. The `cacheConfigProvider` result
is a sparse overlay: each supplied leaf replaces the baseline independently.

```text
runtime field → defaultConfig field → DialCache disabled baseline
```

The disabled baseline has no local or remote TTL, request-local caching is off,
and shadow work is off. Coalescing defaults to `true`, but no flight exists
while all cache layers are inactive. A local or remote layer needs a TTL; once
it has one, omitting its ramp selects 100% of keys.

A provider result of `null` (or defensive `undefined`), an empty config, and
omitted fields all inherit the baseline. Local and remote entries in `ttlSec`
and `ramp` merge separately. So do `shadow.ramp` and `shadow.logMismatches`:
`shadow: { ramp: 0 }` stops new shadow admission while preserving an inherited
logging preference.

Use explicit values to turn inherited features off:

| Overlay | Effect on the new invocation |
| --- | --- |
| `requestLocal: false` | Bypass request-local lookup and storage |
| `ramp: { [CacheLayer.LOCAL]: 0 }` | Bypass process-local serving |
| `ramp: { [CacheLayer.REMOTE]: 0 }` | Bypass remote serving; shadow admission stays independent |
| `shadow: { ramp: 0 }` | Stop new shadow work |
| `staleOnErrorMaxAgeSec: 0` | Disable stale recovery |
| `coalesce: false` | Give the caller an independent cache path and source deadline |
| `DialCacheKeyConfig.disabled()` | Disable request-local, stale recovery, and mismatch logging; set both serving ramps and the shadow ramp to `0` |

The disabled helper leaves TTLs and `coalesce` unset. Inherited TTLs remain
available but inactive under its zero ramps. A later ramp-up coalesces unless
another leaf explicitly opts out. This helper does not cancel admitted work or
disable explicit maintenance such as `invalidateRemote()`.

The remote-read deadline has additional fallbacks:

```text
runtime remoteReadTimeoutMs
  → defaultConfig.remoteReadTimeoutMs
  → redis.readTimeoutMs
  → 50 ms
```

It bounds the semantic Redis read and cannot be disabled. It does not include
config resolution, deserialization, the source call, or Redis writes; see
[Deadlines and application-owned budgets](coalescing.md).

### Validation and snapshots

Invalid instance options throw during construction. Invalid `defaultConfig`
leaves throw when `cached()` registers a definition or `getOrLoad()` is invoked.
The [API reference](api.md#dialcachekeyconfig) lists field types and bounds.

`new DialCacheKeyConfig(...)` first validates object/map/group shapes,
`requestLocal`, `coalesce`, and `remoteReadTimeoutMs`, and copies the supplied
maps and shadow group. TTL, ramp, recovery-age, and shadow leaves are validated
later, at static-default capture or runtime resolution. Constructing a config
object alone therefore does not establish that all its leaves are valid.

Each registration or inline invocation captures an immutable baseline snapshot,
including nested maps and shadow policy. Mutating the original config later
does not update that baseline. Use the provider for runtime changes.

Invalid runtime policy fails open at the affected boundary:

| Invalid input | Behavior |
| --- | --- |
| TTL or serving ramp leaf | Disable that layer with `invalid_ttl` or `invalid_ramp`; record `config_resolution`. Valid layers can continue. Values do not fall back to valid defaults and ramps are not clamped. |
| Config object, layer-map or shadow shape; `requestLocal`, `coalesce`, or `remoteReadTimeoutMs` | Fail resolution for the whole invocation; record `config_resolution` and `config_error`, then run the loader uncached. |
| `staleOnErrorMaxAgeSec` | Disable recovery and record `config_resolution`; a valid ordinary remote layer remains available. A positive age without a remote TTL is also an error. |
| `shadow.ramp` | Record remote `config_resolution` and skip shadow work when an eligible Redis path evaluates it; preserve valid serving layers. |
| `shadow.logMismatches` | Disable mismatch logging while preserving shadow work; record remote `config_resolution` only after the metrics hook, cohort, and capacity gates admit the job. |

Validation of layer and shadow leaves depends on traversal: an earlier hit can
avoid evaluating lower-layer policy. Unknown runtime fields are generally
ignored, so validate external policy against your application's schema to catch
misspellings such as `ramp.remtoe`.

The removed `shadowRamp` field is an exception. Static config rejects it with
`DialCacheKeyConfig.shadowRamp was replaced by "shadow.ramp"`; a provider result
containing it fails resolution for the whole invocation.

### Provider behavior

`cacheConfigProvider` is called for every enabled cache invocation before any
cache lookup. Keep it cheap, cache remote or config-store reads inside the
provider, and give asynchronous work a finite application-owned deadline.

DialCache fetches and resolves one config snapshot per enabled invocation.
Provider errors do not activate defaults: they fail open, record
`config_error`, and execute the fallback uncached.

This example assumes an application-provided `db` and a connected
`dialCacheRedisClient`; see [Redis setup](redis.md).

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache({
  redis: {
    client: dialCacheRedisClient,
    readTimeoutMs: 75,
  },
  cacheConfigProvider: async (key) => {
    if (key.useCase === "GetUser") {
      return new DialCacheKeyConfig({
        // Sparse override: inherit both TTLs and the local ramp.
        ramp: { [CacheLayer.REMOTE]: 25 },
        // Per-use-case override of the instance's 75 ms read deadline.
        remoteReadTimeoutMs: 35,
      });
    }
    return null;
  },
});

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUser",
    cacheKey: (userId) => userId,
    defaultConfig: new DialCacheKeyConfig({
      // Omitted ramps default to 100% because these layers have TTLs.
      ttlSec: {
        [CacheLayer.LOCAL]: 30,
        [CacheLayer.REMOTE]: 300,
      },
    }),
  },
);
```

### Stable key cohorts

Ramp values are thresholds from 0 to 100. `0` disables the layer, `100` enables
it for every key, and an intermediate value selects keys whose DialCache-owned
deterministic bucket for the full cache key and layer is below that threshold.

For a fixed cache identity and layer, increasing a ramp only adds keys and
decreasing it only removes keys; it does not reshuffle existing membership.
Local and remote cohorts are layer-specific.

Ramps select key cohorts, not requests or load, so a ramp of `10` does not
guarantee 10% of calls, especially for a small or skewed key population.
DialCache keeps the assignment stable across releases.

Applications that need an externally coordinated cohort can use
`cacheConfigProvider` to return a sparse per-key ramp override of `0` or `100`.

`shadow.ramp` selects its own stable exact-key cohort, independent of both
serving ramps. Shadowing additionally needs a valid remote TTL and a metrics
adapter with the outcome hook. `shadow.logMismatches` controls diagnostic
warnings separately and defaults to `false`.
[Shadow validation](shadow-validation.md) explains eligibility, comparison,
clean-miss fills, capacity, and the data-handling contract.

### Changing policy on a running service

New invocations resolve the current policy. A change does not evict existing
values or rewrite their stored expiration times:

| Change | Existing entries and work |
| --- | --- |
| Lower or raise the local TTL | Existing local entries keep the TTL assigned when inserted. The new TTL applies to subsequent writes. Reads do not refresh that TTL. |
| Lower or raise the remote TTL | A new Redis read classifies the frame's age using the current remote TTL. The key's physical expiration stays as written; a longer policy does not extend it or restore an expired key. |
| Change the stale-recovery maximum age | A new Redis read uses the new age policy. Existing keys keep their physical retention; shorter recovery policy restricts reuse without deleting the key. |
| Set a serving ramp to `0` | Bypass that layer without evicting its entries. A later ramp-up can reuse values that remain valid. |
| Set `requestLocal: false` | Bypass the current request's memoized values without deleting them. Re-enabling it in that scope can reuse them. |
| Change TTLs, deadlines, or recovery while a flight is active | An eligible follower can still join the existing flight and inherit its leader's execution; admitted work is not reconfigured. |
| Return `DialCacheKeyConfig.disabled()` | Stop new cache use and shadow admission. Existing flights and detached jobs can finish and publish. |

For example, reducing a local TTL from 60 seconds to 5 seconds does not make a
20-second-old local entry miss: it keeps its original 60-second lifetime. A
Redis frame of the same age is no longer fresh under a new 5-second remote TTL,
although a configured recovery policy may still admit it after a source failure.

When an immediate freshness boundary matters, account for every active layer.
A local hit bypasses the new remote age policy and the invalidation watermark.
See [Freshness boundaries](concepts.md#freshness-boundaries) and
[What followers inherit](coalescing.md#what-followers-inherit).

### Coalescing policy

Coalescing defaults to `true` for both request-local and process-scoped work.
Set `coalesce: false` when callers sharing a value identity need independent
execution, deadlines, failures, or cancellation behavior. Cache hits and settled
request-local memoization still apply. The opt-out increases dependency load
and permits concurrent writes; see
[Coalescing and liveness](coalescing.md#per-use-case-opt-out) for the full contract.

### Provider key input

`cacheConfigProvider` receives the fully constructed, read-only `DialCacheKey`
for the invocation:

| Field | Meaning |
| --- | --- |
| `namespace` | Logical application or environment namespace. |
| `keyType` and `id` | Primary identity. The selected id has already been converted to a string. |
| `args` | Secondary dimensions as normalized, name-sorted string pairs; entries whose value was `undefined` are omitted. |
| `useCase` | Stable operation name used in cache identity and metrics. |
| `prefix` | Encoded identity prefix, including a Redis Cluster hash tag when invalidation tracking is enabled. |
| `urn` | Complete encoded cache identity, including arguments and `useCase`. |
| `defaultConfig` | The operation's snapshotted baseline policy, or `null`. |
| `serializer` | The operation-specific serializer, or `null`. |
| `trackForInvalidation` | Whether the operation uses remote watermark tracking. |

Use the identity fields to select policy; do not derive policy names or metric
dimensions from unbounded user input. The provider result remains a sparse
overlay and must not mutate the key.

See [Constructing keys directly](#constructing-keys-directly) for the public
helpers and the difference between normalized provider keys and manually
supplied argument pairs.

## Redis payload compression

Compression is instance-wide write policy under `redis.compression`, rather
than a runtime use-case setting. The default uses zstd level 3 for serialized
payloads of at least 4,096 bytes, and selects compression only when it saves
space. `false` disables compression for new writes; reads still decode existing
compressed frames.

See [Compression](redis.md#compression) for options, validation, synchronous
CPU cost, binary escaping, size limits, and mixed-version compatibility. The
[API table](api.md#redisconfig) provides the defaults in one place.

## Request-local cache

Set `requestLocal: true` to memoize resolved values for the lifetime of the
outermost `enable()` scope:

```ts
const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUser",
    cacheKey: (userId) => userId,
    defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
  },
);
```

`requestLocal` is a runtime boolean rather than a TTL/ramp-controlled
`CacheLayer`. The provider can turn it on or off for each invocation.
`DialCacheKeyConfig.enabled(ttlSec)` enables only process-local and remote
caching, so request-local caching must be selected explicitly.

The resolved config applies to the whole invocation. When `requestLocal` is
false, the invocation skips request-local lookup and storage without deleting a
value already memoized in the scope. A later invocation that enables it can
reuse that value.

The outermost `enable()` call owns the request-local lifetime; nested `enable()`
calls reuse the same scope. State is allocated lazily, so scopes that use only
process-local or remote caching do not allocate it.

Wrap the complete Node HTTP handler so the scope matches the request. Here,
`readUserId` and `handleRequestError` are application-provided functions:

```ts
import { createServer } from "node:http";

const server = createServer((req, res) => {
  void dialcache
    .enable(async () => {
      const user = await getUser(readUserId(req));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(user));
    })
    .catch((error: unknown) => handleRequestError(error, res));
});
```

Request-local storage has no capacity limit, eviction, or overflow mode. Values
are retained until the outermost callback settles. Use it for short-lived
scopes with bounded key cardinality. Split long-running streams or large batch
jobs into smaller scopes.

## Process-local cache

The process-local layer, `CacheLayer.LOCAL`, uses one LRU per `DialCache`
instance. It keeps at most 10,000 entries by default across all use cases while
retaining each entry's insertion TTL. Reading an entry updates its LRU
position but does not extend its TTL.

Set `localMaxSize` to a nonnegative safe integer to change the global entry cap.
`0` disables process-local storage. With a valid local TTL and selected ramp,
that path still records misses and can coalesce concurrent calls within the
instance; sequential calls still miss this layer. Set the local ramp to `0` to
bypass the layer, or use `coalesce: false` to prevent in-flight sharing:

```ts
const dialcache = new DialCache({ localMaxSize: 25_000 });
```

The limit counts entries rather than estimating JavaScript object memory.
Recently read entries stay resident ahead of less recently used entries when
the limit is reached.

## Cached-value ownership

Treat values returned by cached functions or `getOrLoad()` as immutable.
DialCache does not clone or freeze values stored in request-local or
process-local memory.
Mutating a cached object can be observed by:

- later callers in the same request;
- callers in other requests that hit the process-local cache; and
- callers that coalesced onto the same in-flight result.

This contract includes nested objects and arrays, `Map`, `Set`, `Buffer`, typed
arrays, and class instances. Redis deserialization can produce a different
reference from an in-memory hit, so reference identity is layer-dependent and
is not part of the API contract.

Copy a value explicitly before changing it:

```ts
const sharedUser = await getUser("123");
const editableUser = structuredClone(sharedUser);
editableUser.displayName = "New name";
```

Use a narrower copy when its semantics are sufficient. The ownership boundary
remains the caller's responsibility.
