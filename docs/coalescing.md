# Coalescing and liveness

[Documentation](index.md) · [API reference](api.md)

By default, DialCache shares same-key in-flight work within a request or a
`DialCache` instance, according to the active layers. A per-use-case policy can
disable that sharing. Each active remote read has a finite deadline. A separate
default deadline begins when an initially enabled invocation starts its fallback
loader.

These mechanisms reduce duplicate source work. Their deadlines help flights
settle, but eventual cleanup still requires finite application-owned budgets
for every injected operation. They do not replace cross-process coordination,
source-native cancellation, admission control, or backpressure.

Detached [shadow work](shadow-validation.md) has a separate instance-level
registry and capacity limit. It is not another coalescing scope.

## Request coalescing

DialCache has two sharing scopes. They can both participate in one call:

| Active layers | Where same-key work is shared |
| --- | --- |
| Request-local only | Within one outermost `enable()` scope |
| Process-local or remote only | Within and across requests using one `DialCache` instance |
| Request-local plus a shared layer | Within each request first; each request-local miss can then join the instance's shared work |

For example, two concurrent requests with both request-local and process-local
caching each perform their own request-local lookup. If both miss on the same
key, their lower-layer work can still coalesce into one process-local lookup
and one source call. Each request then memoizes the result in its own scope.

### Request-local scope

When request-local caching is active and coalescing is enabled, callers with the
same key in one outermost `enable()` scope share in-flight work before the
request-local lookup.

The resolved value is memoized for later sequential calls in that scope. A
different outer request has a different request-local flight registry.

### Process scope

When process-local or remote caching is active and coalescing is enabled,
same-key callers share work within one `DialCache` instance before the first
active process-local or remote layer.

This is reported as `scope="process"`, but it is instance-scoped:

- separate requests using the same `DialCache` instance can share;
- separate `DialCache` instances in one process do not share; and
- separate processes or hosts do not share.

```ts
await dialcache.enable(async () => {
  // Same cold key and active process-local or remote layer:
  // one fallback execution, one shared result.
  const [first, second] = await Promise.all([
    getUser("456"),
    getUser("456"),
  ]);
});
```

With a remote layer configured, an instance-scoped leader that misses
process-local cache performs one bounded Redis read. Followers share that read
and its remaining deadline. On a remote miss, the leader runs the fallback and
cache write; followers await that result.

For a process-local-only miss, followers share the leader's fallback and local
write. This mitigates a thundering herd on one hot key within the instance.

### What followers inherit

Each enabled invocation resolves its own runtime config before it can join a
flight. Once it joins, it awaits the leader's result: it does not restart the
Redis read, run its own loader, or apply a separate source deadline. The leader
controls the shared cache path, serialization, writes, and stale-recovery
decision. Followers can therefore receive the leader's failure or recovered
stale value as well as a fresh result.

A runtime change does not cancel or replace a flight already in progress. A
later invocation that is still eligible to coalesce can join that flight even
if its TTL or timeout differs. Turning all layers off bypasses it; setting
`coalesce: false` starts an independent cache path. Neither action cancels the
leader or removes values it may publish.

This also matters for `getOrLoad()` calls with different closures or operation
options under one key. Keep their value meaning and serialization consistent,
and make execution independent when inheriting another caller's deadline,
failure, or cancellation behavior would be incorrect.

`invalidateRemote()` does not clear existing flights. A caller arriving after
invalidation can join a leader that read Redis before invalidation, even when
only tracked remote caching is enabled. Use `coalesce: false` when each caller
needs its own watermark observation; see
[Independent fence checks](invalidation.md#independent-fence-checks).

### Per-use-case opt-out

`DialCacheKeyConfig.coalesce` is a sparse runtime boolean whose effective
default is `true`. Set it to `false` in a use case's `defaultConfig` or runtime
overlay to disable both request-local and process-scoped single-flight:

```ts
import { CacheLayer, DialCacheKeyConfig } from "dialcache";

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUserWithoutSingleFlight",
    cacheKey: (userId) => userId,
    defaultConfig: new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.LOCAL]: 60 },
      coalesce: false,
    }),
  },
);
```

Concurrent same-key callers then each perform:

- their own active-layer reads with a full independent remote-read budget;
- their own fallback, error, and fallback deadline when a fallback is needed;
- their own cache writes after a miss.

Request-local and process-local publication is last-writer-wins. Each Redis
write is a complete-frame last-writer-wins `SET`; tracked reads apply the
watermark fence afterward. A settled
request-local value can still serve a later sequential call in the same outer
scope; the policy disables in-flight sharing, not memoization or cache hits.

Runtime overlays can explicitly change the field in either direction. Omission
inherits the baseline and ultimately defaults to `true`.
`DialCacheKeyConfig.disabled()` deliberately leaves `coalesce` unset: with every
serving layer off there is no flight to share, and a later runtime ramp-up
coalesces again unless it explicitly opts out.

The public constructor and static `defaultConfig` validation require a boolean
when the field is present. A malformed runtime value fails config resolution for
the whole invocation: DialCache warns, records `config_resolution` and
`config_error`, and executes the fallback uncached without touching Redis.

Use the opt-out when executions with the same value identity must not inherit a
leader's failure, cancellation behavior, `FallbackTimeoutError`, or stale-recovery
result. It does not
make an incomplete cache key safe: if an input changes the returned value, put
it in the key or disable the affected cache layers. Disabling coalescing
reintroduces thundering-herd exposure, independent Redis load, and write races.

An opted-out use case emits no
`coalesced` event, records request, miss, and latency observations once per
caller rather than once per flight, and does not register process state in
`getCoalescingState()`.

## When calls do not coalesce

Coalescing applies only when at least one cache layer is active and the resolved
`coalesce` policy is not `false`:

- calls that start outside `enable()` are true pass-through;
- initially enabled calls with every layer disabled are uncached and
  uncoalesced;
- a use case with `coalesce: false` keeps each caller's cache path independent;
- process-scoped work is never shared across `DialCache` instances.

An initially enabled all-disabled call still receives the fallback deadline
described below.

Layer activity follows resolved TTL/ramp policy. `localMaxSize: 0` disables
storage but does not bypass an otherwise active local layer, so concurrent calls
can still share a process flight. See [Process-local cache](configuration.md#process-local-cache).

The full constructed cache key always defines cached-value identity. Include
locale, auth context, or any other input that can change the returned value,
regardless of the coalescing policy.

When coalescing is enabled, that same key also defines execution identity:
concurrent calls with the same key share the leader's execution. Include
cancellation behavior and other execution-only inputs when they must differ by
key, or use `coalesce: false` when their results remain safe to cache under the
same value identity but their in-flight work must stay independent.

### Shadow work does not enable caller coalescing

Shadow admission does not make an otherwise all-disabled caller path
coalesced.

When the remote layer is the only configured serving layer and its ramp
excludes a key, concurrent calls each run their own source fallback. Same-key
shadow jobs are deduplicated by admitting one and reporting the others as
`dropped`; callers do not join or await that job.

A serving Redis hit reached through a process-scoped leader schedules at most
one shadow job for its coalesced followers. With `coalesce: false`, each caller
can attempt to schedule validation, but exact-key shadow deduplication admits at
most one concurrent job and reports the other attempts as `dropped`.

`shadowMaxInFlight` limits scheduled or running shadow jobs across the
instance, independently of request-local and process-scoped flights. See
[Shadow validation and Redis bootstrap](shadow-validation.md) for the full
admission and lifecycle contract.

## Stale recovery shares the flight

An opted-in [stale-on-error](stale-on-error.md) path stays inside the same flight:
one initial Redis read, one retained candidate, one source attempt, and one
recovery decision. Followers share either the recovered value or original
rejection. With `coalesce: false`, each caller has an independent snapshot and
source deadline.

## Fallback deadlines

Once an initially enabled invocation begins its wrapped fallback, DialCache
applies a 60-second monotonic deadline by default.

Set `fallbackTimeoutMs` on a cached wrapper or `getOrLoad()` invocation to
choose a positive integer deadline in milliseconds, up to 2,147,483,647. Set
it to `null` only when the application intentionally accepts an unbounded
fallback:

```ts
import { DialCacheKeyConfig, FallbackTimeoutError } from "dialcache";

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUserWithDeadline",
    cacheKey: (userId) => userId,
    defaultConfig: DialCacheKeyConfig.enabled(60),
    fallbackTimeoutMs: 2_000,
  },
);

try {
  await dialcache.enable(() => getUser("123"));
} catch (error) {
  if (error instanceof FallbackTimeoutError) {
    logger.warn("source lookup exceeded its DialCache budget", {
      useCase: error.useCase,
      timeoutMs: error.timeoutMs,
    });
  }
  throw error;
}
```

### When the timer runs

The timer starts only when the fallback begins:

- same-key followers share the request-local or process leader's remaining
  budget and source outcome, including any authorized stale recovery;
- callers with `coalesce: false` start independent fallback timers;
- a remote read failure or timeout starts the fallback timer only when the
  source loader begins;
- enabled pass-through invocations where every layer is disabled have
  independent timers;
- cache hits create no fallback timer; and
- calls that began outside an enabled context remain true pass-through and are
  not timed out, even when the operation has `fallbackTimeoutMs`.

### Application-owned budgets

The source deadline is not a total-call timeout. Each operation has its own
settlement boundary:

| Stage | Settlement budget |
| --- | --- |
| Runtime config provider | Application-owned; neither read nor source timer has started |
| Semantic Redis read | Resolved `remoteReadTimeoutMs`; see [Remote-read deadlines](redis.md#remote-read-deadlines-and-async-liveness) |
| Deserialize a cached value | Application-owned; outside the semantic-read timer |
| Source loader | `fallbackTimeoutMs`, starting when the source runs |
| Serialize and write the replacement | Application-owned; the source timer has already finished |
| Explicit `invalidateRemote()` | Application-owned; independent of enabled scopes |

A pending serializer or Redis write can therefore keep a coalesced flight open
after the source succeeds. Give injected operations finite, resource-native
budgets for queueing, retries, and settlement. A separate application timeout
on the overall request can stop waiting, but does not by itself cancel this work.

### Event-loop behavior

Deadline delivery requires the JavaScript event loop to make progress. It
cannot preempt a synchronous fallback prefix or other event-loop blocking.
Rejection can therefore arrive later than the configured duration.

When control returns, DialCache checks the monotonic deadline before accepting
the result. The timer remains referenced until the fallback settles or times
out. An abandoned enabled fallback can keep an otherwise idle short-lived
process alive until the deadline.

Shutdown code should await outstanding caller-path DialCache promises rather
than discard them. This does not drain detached shadow jobs; see
[Redis lifecycle ownership](redis.md#lifecycle-ownership) for dependency
shutdown requirements.

### Timeout does not cancel the source

Timing out rejects the source attempt with `FallbackTimeoutError`. The chain
can then serve an authorized retained Redis candidate; otherwise it rejects
with that exact error. Its flight clears normally when the chain settles.

A later source resolution is ignored. It cannot become an accepted shadow fill
value or proceed to ordinary serialization, Redis writes, or local publication.
Recovery may deserialize retained bytes and memoize its result request-locally;
it never publishes a new shared value.

The underlying loader is not canceled and may continue its own I/O or side
effects. Give the source operation a native timeout or `AbortSignal` whenever
possible.

`fallbackTimeoutMs: null` disables the guard and makes finite fallback
settlement entirely application-owned. Use that escape hatch only after
intentionally accepting the liveness risk.

Timeout failures retain the bounded metrics classification
`error="fallback"` with `in_fallback="true"`. The typed error carries timeout
details without adding high-cardinality labels.

A shared remote-read timeout emits one `cache_read_timeout` error for the
leader, not one per follower. With coalescing disabled, each caller owns its
read and can emit its own timeout error.

### Shadow deadlines are separate

A finite `fallbackTimeoutMs` also supplies the whole-job deadline for detached
shadow work. Setting it to `null` removes the caller fallback deadline, but
shadow work still uses the 60-second default.

For a served Redis hit, the shadow clock starts when detached validation
begins. For a remote-ramped-down call, it starts before the caller's source
operation, so synchronous source work consumes the same budget. Shadow work
never delays or rejects the caller.

The shadow scheduler and deadline timer are unreferenced. A deadline prevents
later serialization or write dispatch, but cannot cancel an already-started
source call, serializer, raw Redis read, or dispatched Redis write.

Underlying shadow-owned work that has already started can retain a capacity
slot until it settles, even after the bounded outcome is reported. A
caller-owned source promise reused by a ramped-down shadow path is the
exception: by itself, it stops retaining that slot at the shadow deadline.

## Inspecting process-scoped flights

`getCoalescingState()` returns a point-in-time copy of caller-path
process-scoped flights owned by one `DialCache` instance:

```ts
const state = dialcache.getCoalescingState();

state.process.activeLeaders;
state.process.activeFollowers;
state.process.oldestLeaderAgeMs; // null when idle
```

A leader is one exact cache key currently tracked by the instance-scoped
coalescer. A follower is each later invocation that joined that pending leader;
the initiating invocation is not counted as a follower.

Followers remain counted until their leader's DialCache promise settles,
including by deadline rejection. The underlying source operation may continue
after that point.

Request-local flights are deliberately excluded because their lifecycle is
bounded by the outer `enable()` scope. Shadow jobs are also excluded; they use
their own capacity registry and outcome metrics.
Use cases with `coalesce: false` never register process flights and therefore do
not appear in this state.
`oldestLeaderAgeMs` uses a monotonic clock and is computed when the snapshot is
requested.

## Admission control remains application-owned

There is no library-wide cap or age-based replacement for caller-path
request-local or process-scoped flights. `shadowMaxInFlight` bounds only
detached shadow jobs.

A registry cap would bound only DialCache metadata. Overflow or eviction could
still create unbounded source work and unsafe duplicate publication.
DialCache's remote-read and fallback deadlines cover only those phases;
provider, serializer, and Redis-write settlement remains application-owned.
Admission control and backpressure remain responsible for bounding
simultaneous distinct-key work.

Monitor:

- active leader count;
- active follower count;
- oldest leader age;
- remote-read timeout errors;
- fallback deadline errors; and
- source concurrency and saturation.

Use those signals to verify that application budgets and admission control hold
under production load.
