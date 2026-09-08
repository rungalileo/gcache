# Configuration and rollout

<a id="configuration"></a>

[Documentation](index.md) · [API reference](api.md#dialcachekeyconfig)

An `enable()` scope permits caching. The effective policy selects which layers
participate and how long they can reuse values. Configure resources once,
define a baseline per operation, and use a provider for runtime changes.

## What belongs where

| Level | Responsibility | Examples |
| --- | --- | --- |
| Instance: `new DialCache(...)` | Shared resources and instance defaults | Namespace, Redis client and compression, local capacity, metrics, shadow capacity |
| Operation: `cached()` or `getOrLoad()` options | Result identity and execution contract | Key, serializer, invalidation tracking, source deadline, `defaultConfig` |
| Runtime: `cacheConfigProvider(key)` | Policy for one enabled invocation | Layer TTLs and ramps, request-local, coalescing, remote-read deadline, recovery age, shadow policy |

Keep operation definitions stable. Their policy defaults are snapshotted when
registered or invoked; mutating the original config does not change that
baseline. Use the provider to change policy. See [keys and identity](keys.md)
for key design and [the read model](concepts.md) for scopes and layer lifetimes.

<a id="runtime-config-and-ramp-controls"></a>

## Baseline and overlay precedence

`defaultConfig` is the operation's baseline. A provider result overrides only
the fields it supplies, including individual entries in nested maps:

```text
runtime field → defaultConfig field → library default
```

For example, a rollout can change the local ramp without repeating the TTL:

| Field | Operation default | Runtime override | Effective policy |
| --- | --- | --- | --- |
| `ttlSec.local` | `60` | omitted | `60` seconds |
| `ramp.local` | `100` | `10` | 10% key cohort |

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

// Your configuration system updates this map.
const policies = new Map<string, DialCacheKeyConfig>();
const dialcache = new DialCache({
  cacheConfigProvider: (key) => policies.get(key.useCase) ?? null,
});

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUser",
    cacheKey: (userId) => userId,
    defaultConfig: new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.LOCAL]: 60 },
    }),
  },
);

policies.set("GetUser", new DialCacheKeyConfig({
  ramp: { [CacheLayer.LOCAL]: 10 },
}));
await dialcache.enable(() => getUser("123"));
```

This example assumes an application `db`. The omitted baseline ramp is `100`
because a TTL exists. Without a TTL, a local or remote layer is off.
Request-local caching and shadow work are off by default. Coalescing defaults
to `true`, but does not start a flight when all cache layers are inactive.

A provider result of `null` (or defensive `undefined`), an empty config, and
omitted fields all inherit. Local and remote map entries merge separately,
as do `shadow.ramp` and `shadow.logMismatches`.

## Turning features off

Use explicit values to disable inherited policy:

| Overlay | Effect on new invocations |
| --- | --- |
| `requestLocal: false` | Bypass request-local lookup and storage |
| `ramp: { [CacheLayer.LOCAL]: 0 }` | Bypass process-local serving |
| `ramp: { [CacheLayer.REMOTE]: 0 }` | Bypass remote serving; shadow admission remains independent |
| `shadow: { ramp: 0 }` | Stop new shadow work; inherit the logging preference |
| `staleOnErrorMaxAgeSec: 0` | Disable stale recovery |
| `coalesce: false` | Use independent cache paths and source deadlines; settled cache hits still apply |
| `DialCacheKeyConfig.disabled()` | Disable request-local, recovery, and mismatch logging; set both serving ramps and the shadow ramp to `0` |

The disabled helper leaves TTLs and `coalesce` unset. Inherited TTLs remain
inactive under the zero ramps. Replacing that overlay with a later ramp-up
coalesces unless another field opts out. Disabling does not cancel admitted
work, evict values, or disable maintenance such as `invalidateRemote()`.

## Stable key cohorts

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

## Changing policy on a running service

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

## Provider behavior

The provider receives the normalized [key](keys.md#the-key-passed-to-runtime-policy)
for every enabled invocation, before cache lookup or joining a flight. Each
invocation gets one policy snapshot. Keep the provider cheap; cache external
configuration reads inside it and give asynchronous work a finite deadline.

Provider errors run the loader uncached and record `config_error`; they do not
activate defaults. Invalid runtime fields fail open at the affected boundary:
for example, an invalid local TTL disables that layer while valid layers can
continue. [Validation and snapshots](api.md#validation-and-snapshots) specifies
the exact behavior for each field.

## Deadlines

The remote-read deadline has an instance fallback:

```text
runtime remoteReadTimeoutMs
  → defaultConfig.remoteReadTimeoutMs
  → redis.readTimeoutMs
  → 50 ms
```

It bounds the semantic Redis read and cannot be disabled. The source deadline,
`fallbackTimeoutMs`, is an operation option. Neither is a total-call budget;
config resolution, serializers, and writes need their own settlement bounds.
See [application-owned budgets](coalescing.md#application-owned-budgets).

## Related reference

<!-- Preserve published anchors for sections moved to their canonical pages. -->
<a id="defining-cache-operations"></a>
<a id="validation-and-snapshots"></a>

[Operation definitions](api.md#cached) and [validation](api.md#validation-and-snapshots)
are in the API reference.

<a id="keys-ids-and-extra-dimensions"></a>
<a id="namespace"></a>
<a id="identity-rules"></a>
<a id="changing-a-namespace"></a>
<a id="provider-key-input"></a>

[Keys and identity](keys.md) covers components, namespaces, normalization, and
provider input.

<a id="constructing-keys-directly"></a>

[Direct key construction](api.md#constructing-keys-directly) is in the API reference.

<a id="enable-and-disable-scopes"></a>
<a id="request-local-cache"></a>
<a id="process-local-cache"></a>
<a id="cached-value-ownership"></a>

[Scopes](concepts.md#enable-and-disable-scopes), [storage lifetimes](concepts.md#three-lifetimes),
and [value ownership](concepts.md#value-ownership) are in the read model.

<a id="redis-payload-compression"></a>
<a id="coalescing-policy"></a>

[Compression](redis.md#compression) and [coalescing policy](coalescing.md#per-use-case-opt-out)
are covered by their feature references.
