# Shadow validation

[Documentation](index.md) · [Observability](observability.md#shadow-outcomes)

Shadow validation checks cache coherence by comparing sampled Redis values
with the source, without serving a shadow result to the caller.

It can also fill Redis misses while remote serving is ramped down, giving you
a way to warm a cache before enabling it.

Shadow work is opt-in, sampled by key, and detached. Configure its own ramp and
a metrics adapter with `shadowValidation` support. The caller does not await
shadow reads, comparison, confirmation, or fills.

## What a check establishes

A sampled cached value is compared with a source result. Equality reports
`match`. On disagreement, DialCache reads Redis again: if the payload changed
or disappeared, the observation is `superseded`; if the original payload remains,
it reports `mismatch`. A mismatch is diagnostic and does not trigger repair.

This is a sampled coherence signal, with [race boundaries](#consistency-modes-and-race-boundaries),
not proof that every cached value is current. Missing values can be filled as a
secondary capability.

<a id="at-a-glance"></a>

## Caller paths

| Caller path | Additional shadow work | Caller receives |
| --- | --- | --- |
| Served Redis hit | Compare that frame with a detached source read | The ordinary Redis hit |
| Remote serving ramped down | Read Redis and compare with, or fill from, the caller's accepted source result | The source result |
| Earlier local hit, disabled scope, or missing/invalid remote policy | None | The normal caller result |
| Normally enabled remote miss | No duplicate shadow fill | The ordinary fallback/refill result |

Tracked and untracked keys are eligible. Tracked reads enforce watermarks;
untracked reads and fills retain TTL-based last-writer-wins behavior.

## Configure a shadow cohort

Assuming `redisClient` is a semantic adapter, `metrics` supports shadow outcomes,
and `db` is your application data source:

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache({
  namespace: "users-api",
  redis: { client: redisClient },
  metrics,
  shadowMaxInFlight: 4,
});

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUser",
    cacheKey: (userId) => userId,
    trackForInvalidation: true,
    defaultConfig: new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.REMOTE]: 300 },
      ramp: { [CacheLayer.REMOTE]: 0 },
      shadow: { ramp: 5 },
    }),
  },
);
```

Inside an enabled scope, callers use the source. Eligible keys in the independent
5% shadow cohort exercise Redis in the background. A semantic miss authorizes a
fill. Both bundled telemetry adapters supply the required outcome hook.

Keep earlier layers off when the rollout needs to exercise Redis: a request-local
or process-local hit ends traversal before shadow admission.

## Eligibility

A job needs all of the following:

- A live enabled scope and normal traversal reaching the Redis layer.
- A configured Redis client and a valid remote TTL/policy.
- A served Redis hit, or remote serving disabled specifically by `ramped_down`.
- A positive shadow ramp whose stable exact-key cohort selects this key.
- A configured `shadowValidation` metrics hook and available capacity.

Missing policy, invalid policy, provider failure, or an omitted metrics hook
cannot start a shadow-only path. `logMismatches` does not enable one either.

Serving and shadow cohorts are independent. Equal partial percentages do not
select the same keys. A partial shadow ramp therefore does not guarantee every
key admitted by a later serving ramp was validated or warmed. Even at 100%,
capacity, lifetime, and earlier-hit gates still apply.

## Serving-hit and ramped-down paths

On a served hit, DialCache retains the serialized frame that supplied the caller as
`C0`, returns the normal decoded result, then starts detached source work.
That loader runs with caching disabled for this `DialCache` instance, so nested
readers through the instance bypass caching. The comparator later receives an
independently deserialized cached value.

On a ramped-down path, the caller starts and awaits its normal source loader
exactly once. Detached work reads `C0` and shares that caller-accepted source
result, `S`; it does not launch another loader. A source rejection or timeout
never becomes an accepted fill value. This foreground loader retains the caller's
context; it is not rerun inside the served-hit branch's disabled scope.

## The `C0` / `S` / `C1` algorithm

`C0` is the initial cached observation, `S` the source result, and `C1` an optional
confirmation read after a disagreement:

```text
C0 miss ───────────────→ accepted S → eligible fill
C0 present → compare S
                 ├─ equal ────────→ match
                 └─ different → C1
                                  ├─ absent / changed → superseded
                                  └─ same payload ───→ mismatch
```

### Clean-miss fill

A semantic `C0` miss can be filled from `S`. For a tracked miss carrying a valid
`observedWatermarkMs`, DialCache checks the application timestamp before serialization
and again immediately before dispatch. A timestamp at or below that observation
skips the fill and emits `fill_fenced`. Preflight suppression also avoids
serialization, compression, and frame allocation.

An admitted fill uses the final timestamp exactly and sends one complete-frame
`SET`. Without an observed fence, the adapter samples its normal dispatch-time
timestamp. The physical TTL follows ordinary write policy, including `M` when
stale recovery is active and the separate one-hour tracked cap.

A semantic miss includes absent, unsupported, logically expired, future-dated,
and watermark-fenced frames. It does not include a present payload that fails
`load`: that is `deserialization_error`, with no repair. Miss reason and observed
fence are independent. A bundled `expired` result is classified after decoding
and does not carry a watermark fence; it follows normal refill behavior.

`filled` means the client accepted the write before the deadline. `fill_error`
means payload preparation or writing failed. Neither proves what remains in
Redis afterward. `fill_fenced` means this job skipped dispatch against its
observed fence; another operation may still change Redis.

### Comparison and confirmation

For present `C0`, DialCache deserializes an independent cached snapshot after the
source result is available. Equal values report `match`. A disagreement triggers
one direct Redis `C1` read in the same tracked or untracked mode.

If `C1` is a miss or its payload differs byte-for-byte, the result is
`superseded`. If the original payload remains, the result is `mismatch`.
Confirmation failure or read timeout produces `confirmation_error`.

Confirmation bypasses logical age solely for supersession comparison. A
future-dated `C1` records its offset but can be retained for comparing bytes; it
cannot serve the caller. DialCache does not deserialize `C1`, compare it with `S`, or
chase another version. Strings compare exactly, Buffers by bytes, and mixed
string/Buffer payloads by UTF-8 bytes.

Any non-null `C0` is observation-only. Shadow validation never repairs a mismatch
or overwrites an undecodable present value.

## Comparison semantics

The default comparator is Node's `util.isDeepStrictEqual`. Object property
insertion order does not matter; values, array order, prototypes, constructors,
and collection contents remain part of strict equality.

For domain-specific equality, provide a typed operation option:

```ts
const getVersionedUser = dialcache.cached(fetchVersionedUser, {
  keyType: "user_id",
  useCase: "GetVersionedUser",
  cacheKey: (userId) => userId,
  shadowComparator: (cached, source) =>
    cached.id === source.id && cached.version === source.version,
  defaultConfig: new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.REMOTE]: 300 },
    shadow: { ramp: 5 },
  }),
});
```

The comparator must synchronously return a boolean and be deterministic,
side-effect-free, non-mutating, and bounded. Throws and non-boolean results
produce `comparison_error`. Accidental thenables are consumed while retaining
the shadow slot until settlement, subject to the job deadline.

Comparison uses the decoded cache value and raw source value intentionally: it
can reveal lossy serialization. Ignore differences only when they are acceptable
application semantics.

## Data ownership and custom integrations

A sampled served hit runs the serializer's `load` again in detached work. It
must be repeatable, non-mutating, and return independently usable values.
Returned Redis payload bytes must remain stable after the adapter read settles.

DialCache retains the original `cached()` argument references or `getOrLoad()`
closure. It cannot generically clone source-selection state. Keep arguments,
captured state, and accepted source values immutable, or snapshot before the
invocation, so detached work still refers to the key that was selected.

The caller's decoded hit object is not reused for comparison. No shadow copy,
hash, or deep comparison is added to the served-hit request path.

## Capacity, deadlines, and detachment

`shadowMaxInFlight` defaults to `1` per instance and must be a positive safe
integer. Same-key duplicates and jobs beyond capacity report `dropped`; there
is no queue or fleet-wide cap. Confirmation and fill stay in the original slot.

Each job has one monotonic budget across `C0`, the source, serialization,
comparison, `C1`, and fill. A finite `fallbackTimeoutMs` is reused as that budget.
When fallback is unbounded (`null`), shadow still uses 60 seconds. Each Redis
read separately has the effective remote-read deadline.

Served-hit timing starts with the detached callback. Ramped-down timing starts
immediately before the caller's source invocation, including its synchronous
prefix. On abandonment, DialCache releases retained `C0` and stops later phases.
Already-started shadow-owned work keeps capacity until it settles, even after
its DialCache deadline. A shared caller-owned loader can continue without
holding the shadow slot after timeout.

Scheduling and shadow deadline timers are unreferenced. They do not keep an
otherwise idle process alive. Detachment uses the Node event loop, not a worker;
synchronous loader, serializer, comparator, or logger work still consumes it.
Underlying I/O is not generally cancellable. Give dependencies finite native
budgets, including commands that may settle after a DialCache timeout.

## Consistency modes and race boundaries

The initial read and later fill are not atomic. An allowed fill can overwrite a
concurrent writer; it is not write-if-still-missing. For tracked keys, the next
primary read applies the current watermark, including one advanced after `C0`.
Size the [future buffer](invalidation.md#choosing-futurebufferms) for the complete
source, serialization, dispatch, and clock-skew window.

An untracked fill has no watermark fence. A detached older source value can be
written after a mutation and remain until expiry. Untracked reads also have no
shadow-specific primary guarantee.

A confirmed mismatch means the original payload survived a second Redis read
after disagreement with the source. It is useful evidence, not an atomic
cross-system snapshot or a promise that the mismatch still exists.

### Command amplification

| Selected path | Extra work |
| --- | --- |
| Served Redis hit | One source read; one `C1` only after disagreement |
| Ramped-down Redis hit | One `C0`, reuse caller source, one `C1` only after disagreement |
| Ramped-down Redis miss | One `C0`, reuse caller source, at most one fill `SET` |

A fenced fill adds no write; preflight fencing also avoids payload preparation.
No path adds a separate fence read. Coalescing suppresses duplicate caller paths;
shadow deduplication drops jobs but does not coalesce source calls when all
serving layers are disabled.

## Confirmed mismatch logging

`shadow.logMismatches: true` adds one warning only after confirmed `mismatch`.
It is default-off and independent of sampling. The logger receives the message
`"DialCache shadow validation mismatch"` and an object with `cacheNamespace`,
`useCase`, `keyType`, `outcome: "mismatch"`, and three bounded detail fields:

| Field | Content | UTF-8 cap |
| --- | --- | --- |
| `cacheKey` | Logical URN, not the physical Redis key | 2 KiB |
| `cachedValueJson` | Native JSON of the decoded cached snapshot | 8 KiB |
| `sourceValueJson` | Native JSON of the raw source value | 8 KiB |

Clipped fields end with `...[truncated]` inside the cap. JSON failure or undefined
output makes that side `null`; the other side is still attempted. Logging does
not compute a diff or reuse the Redis serializer. If detail construction fails,
DialCache still attempts the warning with the four metadata fields; all three detail
fields can be absent.

Truncation is not redaction. Keys and values can include sensitive application
data. Native JSON may execute getters or `toJSON`, and the byte caps apply only
after stringification; they do not bound traversal time or intermediate
allocation. Enable diagnostics only for suitable data and your application's
logging policy. Logger failures are isolated from cache behavior.

## Metrics and shutdown

[Shadow outcomes](observability.md#shadow-outcomes) distinguish matches,
confirmed mismatches, superseded observations, fills, fences, errors, timeouts,
and drops. Only `match` and `mismatch` report observed value age at verdict time.

Detached Redis and serializer work uses `layer="remote_shadow"`. The original
served read keeps `remote`; a ramped-down caller keeps its ordinary disabled
observation. Shadow reads time Redis settlement, while ordinary remote get
latency includes fresh deserialization. Optional age metrics do not gate jobs;
only the `shadowValidation` hook does.

Turn down both serving and shadow ramps to stop new Redis work, or return
`DialCacheKeyConfig.disabled()`. Already-admitted work is not cancelled. There
is no public shadow drain handle; follow [client lifecycle](redis.md#lifecycle-ownership)
when shutting down and treat outcomes during teardown as best-effort.
