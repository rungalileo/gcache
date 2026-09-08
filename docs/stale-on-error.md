# Stale-on-error

[Documentation](index.md) · [Redis and Valkey](redis.md)

Stale-on-error lets selected source failures fall back to an older Redis value.
It is off by default. When enabled, DialCache retains a raw snapshot from the
initial Redis read, tries the source, and can return that snapshot if the error
policy allows it and the value is still within its maximum age.

It performs **no second Redis read**. That keeps recovery available if Redis
becomes unavailable during the source call, but also means later invalidation,
deletion, refresh, or expiry cannot revoke the retained snapshot.

## Fresh age and maximum age

| Symbol | Configuration | Meaning |
| --- | --- | --- |
| `F` | `ttlSec.remote` | Exclusive fresh age ceiling for ordinary Redis reads |
| `M` | `staleOnErrorMaxAgeSec` | Exclusive recovery age ceiling, measured from the same frame timestamp |

`M` is total age, not extra time after `F`. Positive configuration must satisfy
`0 < F < M <= 31_536_000` seconds. Both ages must be safe-integer numbers.
Omission leaves recovery off, or inherits it in a sparse runtime overlay.
Explicit `0` disables inherited recovery.

Invalid static defaults throw. Invalid runtime recovery policy records
`config_resolution`, disables only recovery, and preserves valid ordinary Redis
serving. A remote ramp of zero bypasses the caller-serving Redis path, including
recovery.

## Configure the ages

Use a remote TTL for ordinary freshness and a larger maximum age for recovery:

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache({
  redis: { client: dialCacheRedisClient },
});

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUserWithRecovery",
    cacheKey: (userId) => userId,
    fallbackTimeoutMs: 2_000,
    defaultConfig: new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.REMOTE]: 60 },
      staleOnErrorMaxAgeSec: 300,
    }),
  },
);
```

This assumes a configured semantic Redis client and application `db`. Inside
`enable()`, a frame younger than 60 seconds can serve normally. From 60 seconds
until strictly before 300 seconds, it can serve only after an authorized source
rejection. The built-in classifier accepts `FallbackTimeoutError` only.

## Follow one invocation

The initial read uses one invocation snapshot of `F`, `M`, and the read deadline.
DialCache classifies the returned frame before normal deserialization:

| Age when the initial read settles | Behavior |
| --- | --- |
| `0 <= age < F` | Deserialize and serve as an ordinary hit |
| `F <= age < M` | Record an `expired` miss, retain raw bytes, and call the source |
| `age >= M` | Record an `expired` miss and call the source with no candidate |
| Future timestamp, invalid frame, absent value, or watermark fence | Miss with no candidate |

A read error or timeout never enters recovery. A fresh frame that failed ordinary
deserialization is not reconsidered as a stale candidate.

If the source succeeds, normal refill rules apply; the retained candidate is not
deserialized. If the source rejects, DialCache calls the selected classifier. An
accepted rejection authorizes a recovery check, even when no candidate exists.

With a candidate, DialCache checks `0 <= age < M`, deserializes/decompresses lazily,
and checks the age again before returning. Crossing `M` during asynchronous
`load` prevents serving. A missing, expired, or undecodable candidate preserves
the **exact original source rejection**.

## Choose which errors permit recovery

The synchronous `shouldAttemptStaleRecovery(error)` classifier has this
precedence:

```text
operation option → instance option → error instanceof FallbackTimeoutError
```

An override replaces the lower policy. Include the timeout case yourself if an
application classifier should preserve it:

```ts
import { FallbackTimeoutError } from "dialcache";

const cache = new DialCache({
  redis: { client: dialCacheRedisClient },
  shouldAttemptStaleRecovery: (error) =>
    error instanceof FallbackTimeoutError || isRetriableDatabaseError(error),
});
```

`isRetriableDatabaseError` is your application's narrow classification of
transient infrastructure failures. Deny authoritative outcomes such as
permission or entitlement failures, revocation, deletion/not-found, validation,
and programmer errors. Use an operation override for data requiring a stricter
policy; `() => false` denies recovery for that operation.

The built-in policy also accepts a `FallbackTimeoutError` propagated from a
nested/source operation. It is not limited to the current wrapper's own timer.

A supplied policy must be a function. Runtime throws, thenables, and non-boolean
returns deny recovery, log the classifier failure, and preserve the original
source rejection. Rejecting thenables are consumed. Calls outside `enable()`
never invoke the classifier. `cached()` captures it at registration;
`getOrLoad()` captures it per invocation.

## Snapshot and invalidation boundaries

For a tracked key, the initial primary `MGET` applies the watermark that existed
with the value at read time. An invalidation completed before that read fences
the candidate. An invalidation completed afterward does **not** revoke bytes
already retained in the process.

The same snapshot behavior applies to concurrent refresh, deletion, expiry, and
eviction for tracked and untracked keys. A retained frame can still recover
until its return-time age reaches `M`, even after the Redis key disappears.
Opting tracked data into recovery therefore relaxes its usual freshness behavior
on authorized source-error paths. Leave recovery off when that is unsuitable.

A recovered value is not written to Redis, published process-locally, or used
to schedule shadow validation. If request-local caching is active, it is
memoized only in the current outer enabled scope.

## Retention, clocks, and memory

Writers request physical TTL `M` rather than `F`. Ordinary readers still enforce
logical `F`. Tracked values retain their separate one-hour physical cap: a
configured `M` above one hour remains the logical ceiling, but Redis may expire
the frame before a read can acquire it. Untracked retention is not capped at one
hour. Raising `M` does not resurrect or extend an existing Redis key.

Ages measure time since frame creation on the writer's application clock, not
the underlying data's own last-update time. Clock skew affects the comparisons;
see the [application clock contract](invalidation.md#application-clock-contract).

Earlier local layers retain their own lifetimes. A nearly expired Redis hit can
warm process-local storage with a full local TTL. For each invocation to make a
new remote frame-age check, disable both earlier layers and set `coalesce: false`.
Otherwise, a follower can reuse the leader's earlier age check and snapshot.

Coalesced callers share one initial read, raw candidate, source attempt, and
recovery decision. With `coalesce: false`, each caller retains its own bytes and
runs independently. Across distinct in-flight keys, delayed source calls can
retain substantial raw payload memory until they settle. Use application
admission controls and finite source budgets.

## Observability

Each classifier-authorized check emits one optional `staleRecovery` outcome:
`served`, `miss`, or `deserialization_error`. Only `served` additionally reports
value age, measured at actual return time. Classifier denial emits no recovery
outcome.

Recovery adds no ordinary Redis request, miss, or read-duration sequence; the
initial command is the single caller-serving read. Lazy deserialization and
compression observations still report their work. Source fallback duration and
error metrics still record the rejection even when recovery serves.

The optional metrics hooks do not gate recovery. See
[Observability](observability.md#stale-recovery-outcomes) for backend names.
Before enabling longer retention in an existing fleet, follow the
[readers-first upgrade](upgrading.md#stale-retention-and-downgrades).
