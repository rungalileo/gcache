# API reference

[Documentation](index.md)

Start with the `DialCache` instance, define a cache operation, then choose its
policy. The feature guides explain the behavior behind these tables; the
package's declarations provide the full generic signatures.

## Imports

| Entry point | Public surface | Guide |
| --- | --- | --- |
| `dialcache` | `DialCache`, configuration, keys, serializers, core errors, semantic Redis types, and metric types | This page |
| `dialcache/node-redis` | `createNodeRedisDialCacheClient` | [Redis](redis.md#node-redis) |
| `dialcache/valkey-glide` | `createValkeyGlideDialCacheClient`, `ValkeyGlideRuntime`, `ValkeyGlideScriptingClient` | [Valkey GLIDE](redis.md#valkey-glide) |
| `dialcache/prometheus` | `createPrometheusDialCacheMetrics`, `PrometheusDialCacheMetrics`, `PrometheusMetricsOptions` | [Prometheus](observability.md#prometheus) |
| `dialcache/datadog` | `createDatadogDialCacheMetrics`, `DatadogDialCacheMetrics`, `DatadogMetricsOptions`, `DatadogDogStatsDClient`, `DatadogObservationMetricType` | [Datadog](observability.md#datadog) |
| `dialcache/redis-protocol` | Frame codecs, semantic miss types and guard, invalidation Lua, and reply/TTL validators | [Wire protocol](redis.md#advanced-wire-protocol) |

Optional integrations use their own import paths. The application installs and
owns the corresponding client or metrics registry.

## Constructor

`new DialCache(options?)` constructs one instance for each intended local-cache
and coalescing boundary.
With no options, it supports in-memory caching and uses a disabled baseline.
Enable a scope **and** configure at least one layer to store values.

| Option | Default | Contract |
| --- | --- | --- |
| `namespace` | `"urn"` | Cache identity and metric namespace label; no `{` or `}` |
| `localMaxSize` | `10_000` | Nonnegative safe-integer LRU entry cap across all use cases; `0` disables storage |
| `redis` | Absent | `RedisConfig`: connected semantic client and optional read timeout, serializer, and compression policy |
| `cacheConfigProvider` | No overrides | `(key: DialCacheKey) => DialCacheKeyConfig \| null`, synchronously or via a Promise |
| `shouldAttemptStaleRecovery` | Accepts only `FallbackTimeoutError` | Synchronous `(error: unknown) => boolean`; an operation override replaces it |
| `shadowMaxInFlight` | `1` | Positive safe-integer cap on admitted shadow jobs; no queue |
| `metrics` | Absent | `DialCacheMetricsAdapter` |
| `logger` | `console` | `Logger`, the `debug`, `warn`, and `error` methods |

See [Configuration](configuration.md) for validation and lifetime rules.

### `RedisConfig`

Pass this object as the constructor's `redis` option:

| Field | Default | Contract |
| --- | --- | --- |
| `client` | Required | Connected `DialCacheRedisClient`; the application owns connection and shutdown |
| `readTimeoutMs` | `50` | Positive safe integer up to `2_147_483_647` ms; a use case's `remoteReadTimeoutMs` takes precedence |
| `serializer` | `JsonSerializer` | Instance-level Redis serializer; an operation's serializer takes precedence |
| `compression` | `{ thresholdBytes: 4_096, level: 3 }` | `CompressionConfig` or `false`; threshold is a positive safe integer, level is an integer from `1` through `22` |

Providing a client makes the remote layer available; each operation still needs
a remote TTL and an enabled scope. See [client setup](redis.md),
[serialization](redis.md#serialization), and [compression](redis.md#compression).

## Scope methods

| Method | Return | Behavior |
| --- | --- | --- |
| `enable(fn)` | `Promise<T>` | Enables caching while the callback and its awaited work run |
| `disable(fn)` | `Promise<T>` | Runs a nested region uncached; does not evict values |
| `withEnabled(fn)` | `Promise<T>` | Alias for `enable` |
| `withDisabled(fn)` | `Promise<T>` | Alias for `disable` |
| `isEnabled()` | `boolean` | Whether the current asynchronous chain has a live enabled scope |

Callbacks may return synchronously or asynchronously. Scope state is per
instance and asynchronous call chain. Nested scopes restore prior state. The
outermost `enable()` owns request-local state. New invocations become pass-through
after it closes; already admitted work can finish. An invocation still awaiting
its configuration provider bypasses caching after closure but retains its enabled
fallback deadline. See [Scope lifetime](configuration.md#enable-and-disable-scopes).

`DialCacheContext` is the lower-level root export with `enable`, `disable`, and
`isEnabled`. A separately constructed context does not enable another
`DialCache` instance or attach a cache to it.

## `cached`

`cached(fn, options)` returns a `CachedFn<Fn>`: the same parameter types with a
`Promise` of the resolved return value. Register each `useCase` once per instance.
Wrap a bound method or closure when the loader needs a receiver.

```ts
const getUser = dialcache.cached(fetchUser, {
  keyType: "user_id",
  useCase: "GetUser",
  cacheKey: (userId) => userId,
  defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
});
```

## `getOrLoad`

`getOrLoad(load, options)` returns `Promise<Value>`. Its zero-argument loader may
be synchronous or asynchronous. Supply a direct `key` instead of `cacheKey`.
The method does not register a use case, so stable names can be reused at a call
site. All calls sharing an identity must agree on value meaning and serializer.

```ts
const value = await dialcache.getOrLoad(() => fetchUser(userId), {
  keyType: "user_id",
  useCase: "InlineGetUser",
  key: userId,
  defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
});
```

This snippet assumes an enclosing enabled scope; without one the loader runs
uncached.

### Operation options

`CachedOptions<Fn>` and `GetOrLoadOptions<Value>` share these fields:

| Option | Default | Contract |
| --- | --- | --- |
| `keyType` | Required | Entity kind; combines with id and namespace for tracked invalidation |
| `useCase` | Required | Stable operation name, cache-key component, and metric label; `"watermark"` is reserved |
| `cacheKey` / `key` | Required | Selector for `cached`, direct value for `getOrLoad`; returns/accepts `CacheKeySpec` |
| `defaultConfig` | Absent | Baseline `DialCacheKeyConfig`, snapshotted at registration or inline invocation |
| `serializer` | Effective JSON default | Typed `Serializer<Value>` required when the [JSON type guard](redis.md#typed-serializer-requirement) cannot establish compatibility, even for local-only declarations |
| `trackForInvalidation` | `false` | Use watermark-aware Redis reads for this operation |
| `fallbackTimeoutMs` | `60_000` | Positive safe integer up to `2_147_483_647` ms; `null` disables the source deadline |
| `shadowComparator` | Node strict deep equality | Synchronous, bounded `(cached, source) => boolean`; must not mutate its inputs |
| `shouldAttemptStaleRecovery` | Instance policy | Synchronous error classifier; replaces the lower-precedence policy |

`CacheKeySpec` is a string, number, or bigint id, or `{ id, args? }`. Argument
values are string, number, bigint, boolean, `null`, or `undefined`; undefined
arguments are omitted. See [Key design](configuration.md#keys-ids-and-extra-dimensions).

Static defaults, fallback timeout, and stale-recovery classifier are validated
and captured when registering `cached()` or invoking `getOrLoad()`.
The comparator is captured then; its execution and synchronous boolean result
are checked only when shadow comparison runs, with failures reported as
`comparison_error`.
Runtime policy is resolved per enabled invocation. These guarantees do not make
the entire caller-owned options object deeply immutable; keep definitions stable.

## `DialCacheKeyConfig`

`new DialCacheKeyConfig({...})` describes the baseline or a sparse runtime
overlay. Omission inherits; it does not turn an inherited field off.

| Field | Effective default | Values |
| --- | --- | --- |
| `ttlSec.local`, `ttlSec.remote` | No TTL: layer off | Positive safe-integer seconds, at most `31_536_000` (365 days) |
| `ramp.local`, `ramp.remote` | `100` when a TTL exists | Key-selection threshold from `0` through `100`, not a share of traffic; `0` bypasses serving |
| `requestLocal` | `false` | Boolean; no TTL or ramp |
| `coalesce` | `true` | Boolean; affects request-local and process flights |
| `remoteReadTimeoutMs` | Instance setting, then `50` | Positive safe-integer milliseconds, at most `2_147_483_647`; cannot be unbounded |
| `staleOnErrorMaxAgeSec` | Off | Nonnegative safe-integer seconds; `0` disables; positive age must exceed remote TTL and be at most `31_536_000` |
| `shadow.ramp` | Off | Independent finite percentage from `0` through `100` |
| `shadow.logMismatches` | `false` | Boolean; controls diagnostic warning output |

Use `CacheLayer.LOCAL` (`"local"`) and `CacheLayer.REMOTE` (`"remote"`) as map
keys. `LayerConfig` is a partial map; `ShadowConfig` describes the shadow group.
Tracked Redis physical retention has a separate one-hour cap.

| Helper | Result |
| --- | --- |
| `DialCacheKeyConfig.enabled(ttlSec)` | Sets local and remote TTLs to the supplied value and both ramps to `100`; leaves request-local, shadow, and recovery unselected |
| `DialCacheKeyConfig.disabled()` | Disables request-local and recovery, sets both serving ramps and shadow ramp to `0`, and disables mismatch logging |

The enabled helper does not create a Redis connection. The disabled helper is
an invocation policy, not cancellation or eviction. See
[overlay precedence](configuration.md#baseline-and-overlay-precedence).

## `invalidateRemote`

`invalidateRemote(keyType, id, futureBufferMs = 0): Promise<void>` advances the
entity's Redis watermark. Call it after the source mutation commits. The id is
stringified and the buffer is a nonnegative safe integer, at most
`31_536_000_000` milliseconds.

It affects tracked Redis entries across use cases and argument variants in the
same namespace. It does not evict in-memory or untracked Redis values, revoke
acquired snapshots, or clear in-flight work. See
[Independent fence checks](invalidation.md#independent-fence-checks) when each
invocation must observe invalidation separately. Missing
Redis configuration and mutation failures reject; the method works outside an
enabled scope. Choose the buffer from the
[clock and in-flight-work contract](invalidation.md#choosing-futurebufferms).

## `getCoalescingState`

`getCoalescingState(): CoalescingState` returns a point-in-time process-flight
snapshot for this instance:

```ts
const { process } = dialcache.getCoalescingState();
process.activeLeaders;       // Number of distinct in-flight keys.
process.activeFollowers;     // Callers waiting on those leaders.
process.oldestLeaderAgeMs;   // Monotonic age, or null when idle.
```

The nested shape is `ProcessCoalescingState`. Request-local flights are excluded.
There is no method to clear a cache, cancel in-flight loads, cap coalesced
flights, or shut an instance down.
See [Coalescing state](coalescing.md#inspecting-process-scoped-flights).

## Keys and serializers

| Export | Purpose |
| --- | --- |
| `DialCacheKey`, `DialCacheKeyInit` | Construct an identity from string components and ordered string argument pairs; `toString()` returns its precomputed `urn` |
| `normalizeArgs(record)` | Drop undefined arguments, stringify scalar values, and sort names |
| `invalidationPrefix(namespace, keyType, id)` | Build an encoded tracked-entity prefix without braces |
| `redisClusterHashTag(value)` | Reject embedded braces and wrap the value in braces without encoding |
| `Serializer<T>` | `dump(value)` returns `string \| Buffer`; `load(payload)` returns `T`; either may return a Promise |
| `JsonSerializer<T>` | Default JSON codec, including top-level undefined support; both methods return Promises |

`CachedValue<Fn>` exposes a function's resolved result type. `ShadowComparator<T>`
and `StaleRecoveryPredicate` name the corresponding synchronous callbacks.
See [Direct key construction](configuration.md#constructing-keys-directly) for
defaults, encoding, and validation, and [Serialization](redis.md#serialization)
for direct codec behavior, the compile-time guard, and round-trip limitations.

## Errors

| Root export | When it matters |
| --- | --- |
| `DialCacheError` | Base class of the four core errors below |
| `UseCaseIsAlreadyRegisteredError` | Duplicate `cached()` registration on an instance |
| `UseCaseNameIsReservedError` | Either operation API uses `"watermark"` |
| `FallbackTimeoutError` | Enabled source deadline; exposes `useCase` and `timeoutMs` |
| `RedisReadTimeoutError` | Remote wait deadline; exposes `useCase` and `timeoutMs`; serving reads log/count it before fallback, while shadow reads report a job outcome |
| `DialCacheRedisPayloadError` | Invalid raw Redis reply shape |
| `DialCacheRedisPayloadEncodingError` | Unsupported payload encoding in a frame |
| `DialCacheRedisProtocolError` | Invalid semantic mutation reply |

The three Redis error classes extend `Error` directly. Core cache operations
usually absorb cache-path errors; direct adapter calls and explicit maintenance
can surface them. Invalid static options may throw `TypeError` or `RangeError`.
Source errors retain their original rejection value if recovery does not serve.

## Custom integrations

`RedisConfig`, `CompressionConfig`, `DialCacheRedisClient`, `RedisReadRequest`,
`RedisReadContext`, `RedisReadResult`, `RedisReadMiss`, `DecodedRedisFrame`,
`RedisWriteRequest`, `RedisInvalidationRequest`, and `RedisCachePayload` are root
types. Use `isRedisReadMiss` to discriminate reads. The complete semantic and
binary contracts are in [Redis and Valkey](redis.md#custom-client-contract).

`DialCacheMetricsAdapter` and its label/outcome types are root exports.
[Observability](observability.md#custom-adapters) lists required and optional
hooks, bounded labels, and the effects of omitting optional hooks.
