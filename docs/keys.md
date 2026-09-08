# Keys and identity

[Documentation](index.md) · Next: [Configuration and rollout](configuration.md)

A DialCache key identifies the result a caller can reuse. It also determines
which concurrent calls can share a loader. For tracked Redis values, part of
that identity groups the results affected by one invalidation:

```text
namespace + keyType + id  → invalidation group
          + useCase + args  → result identity
```

## Anatomy of a key

Consider a tracked user lookup in two locales:

```text
{users-api:user_id:123}?locale=en#GetUser
{users-api:user_id:123}?locale=fr#GetUser
└─────── entity ──────┘└─ args ─┘└ useCase
```

These are different cached results for the same entity. Another operation,
such as `GetPermissions`, has its own entries under that entity too.
`invalidateRemote("user_id", "123", bufferMs)` advances one watermark covering
all of those tracked results within the instance's namespace.

| Component | Role | Example |
| --- | --- | --- |
| `namespace` | Application or environment partition, set on the instance | `users-api` |
| `keyType` | Entity kind | `user_id` |
| `id` | Entity identity within that kind | `123` |
| `useCase` | Stable name for the operation and its result meaning; also a metric label | `GetUser` |
| `args` | Additional dimensions that change the result | `locale=en` |

The braces mark a Redis Cluster hash tag. Tracked result keys and their watermark
share a slot so Redis can read them atomically. Untracked keys omit the braces
and never consult the watermark. Redis value keys append `:dialcache-frame-v1`
to the logical keys shown here; see [storage format](redis.md#advanced-wire-protocol).

## Define a result identity

For `cached()`, `cacheKey` receives the loader's parameters and returns a bare id
or `{ id, args }`. `getOrLoad()` accepts the same shape directly as `key`.
Assuming an application `db`:

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache({ namespace: "users-api" });
const getUser = dialcache.cached(
  (userId: string, locale: string) => db.fetchUser(userId, locale),
  {
    keyType: "user_id",
    useCase: "GetUser",
    cacheKey: (userId, locale) => ({ id: userId, args: { locale } }),
    defaultConfig: new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.LOCAL]: 60 },
    }),
  },
);

await dialcache.enable(() => getUser("123", "en"));
```

Include every input that can change the result. Omitting an authorization scope,
tenant, or locale can make callers reuse the wrong value. Disabling coalescing
does not fix an incomplete key. The example uses process-local storage; add a
Redis client, remote policy, and `trackForInvalidation: true` to use
[targeted invalidation](invalidation.md).

All call sites sharing a key must agree on value meaning and serialization.
Keep use-case names stable and bounded; put entity and request dimensions in
`id` or `args`. `cached()` registers each name once per instance;
`getOrLoad()` does not register names. Both reserve `"watermark"`.

Inputs omitted from the key still reach the loader, but a cache hit can skip
that loader and a coalesced caller can inherit another caller's execution.
For inputs such as a database handle or `AbortSignal`, make sure both value
reuse and [shared execution](coalescing.md#what-followers-inherit) are valid.
Snapshot mutable arguments or captured state before invoking an operation whose
[shadow loader](shadow-validation.md) may run after the caller continues.

## Normalization and encoding

`cached()` and `getOrLoad()` stringify ids, omit undefined argument values, and
sort argument names. Scalar identity is string-based:

| Inputs, with other components equal | Identity |
| --- | --- |
| Id `1`, `"1"`, or `1n` | Same key |
| Argument `null` or `"null"` | Same key |
| Argument `-0` or `0` | Same key |
| An undefined argument or no such argument | Same key |
| Argument records with different property order | Same key |

If a scalar's meaning changes, change an explicit identity dimension such as
`keyType`, `useCase`, or an argument name or value.

Components are encoded with `encodeURIComponent`, so delimiters inside values
do not become structural separators. Namespace braces throw `TypeError`;
tracked `keyType` and `id` reject braces with `Error`. Untracked `keyType` and
`id` may contain braces, which are encoded. Automatic key-construction failures
follow the [fail-open path](concepts.md#fail-open-and-liveness).

Custom integrations can use `DialCacheKey` and `normalizeArgs` directly. The
direct constructor preserves supplied argument-pair order; it does not perform
this normalization. See [direct key construction](api.md#constructing-keys-directly).

## Namespace

`DialCacheConfig.namespace` defaults to `"urn"`. Set an application-specific
value when applications or environments share Redis. It partitions all cache
layers, coalescing, ramp cohorts, and invalidation, and appears in metrics.
Use a stable, bounded name.

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

## The key passed to runtime policy

The provider receives a read-only `DialCacheKey` after normalization. Its
identity fields are described above; the remaining fields are:

| Field | Meaning |
| --- | --- |
| `prefix` | Encoded entity prefix, with braces when tracking is enabled |
| `urn` | Complete logical key; also returned by `toString()` |
| `defaultConfig` | Snapshotted operation baseline, or `null` |
| `serializer` | Operation-specific serializer, or `null` |
| `trackForInvalidation` | Whether the key uses remote watermark tracking |

`id` is already a string and `args` contains sorted string pairs. Select policy
from these fields without mutating the key; see
[runtime overlays](configuration.md#baseline-and-overlay-precedence).
