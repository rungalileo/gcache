# Targeted invalidation

[Documentation](index.md) · [Redis and Valkey](redis.md)

Use targeted invalidation when a source mutation should invalidate every tracked
Redis result for an entity. A single entity watermark covers all its tracked
use cases and argument variants in the same namespace, without scanning keys.

Invalidation is remote-only. In-memory hits and callers joining an existing
flight can reuse a value without a new Redis read. For an independent watermark
observation on each invocation, disable request-local and process-local caching,
set `coalesce: false`, and leave stale recovery off. See
[Independent fence checks](#independent-fence-checks) for the exact boundary.

## Configure a tracked use case

Assuming `redisClient` is connected and `db` is your application data source:

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";
import { createNodeRedisDialCacheClient } from "dialcache/node-redis";

const dialcache = new DialCache({
  namespace: "users-api",
  redis: { client: createNodeRedisDialCacheClient(redisClient) },
});

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetMutableUser",
    cacheKey: (userId) => userId,
    trackForInvalidation: true,
    defaultConfig: new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.REMOTE]: 300 },
      // No local layers here, so each invocation performs its own tracked read.
      coalesce: false,
    }),
  },
);

// Example only: derive this from your own timing and clock-skew bounds.
const USER_INVALIDATION_BUFFER_MS = 5_000;

await db.updateUser("123", patch);
await dialcache.invalidateRemote("user_id", "123", USER_INVALIDATION_BUFFER_MS);
const updated = await dialcache.enable(() => getUser("123"));
```

Call invalidation **after the source mutation commits**. It works outside an
`enable()` scope. It requires a configured Redis client and rejects if that
client is absent or the mutation fails. Handle that rejection as a failed
maintenance operation, even though ordinary cache I/O fails open.

## Read and write behavior

A watermark is an epoch-millisecond threshold. A tracked frame is readable only
when its writer timestamp is strictly greater than that threshold and the frame
also passes normal age and payload checks.

```text
source mutation commits
    ↓
invalidateRemote → watermark = max(previous, invalidator time + buffer)
    ↓
next tracked read → atomic primary MGET(value, watermark)
    ├─ frame timestamp > watermark → normal age check and cache hit
    └─ frame timestamp ≤ watermark → miss → source loader
```

The bundled adapters route tracked reads to primaries so replica lag cannot hide
an invalidation. A missing watermark is the natural zero baseline.

All value writes use one native `SET` of a complete frame stamped from the
application clock. They do not read, create, or extend watermarks. A write can
succeed physically while its frame remains unreadable under a watermark;
read-time fencing supplies that distinction.

### Conditional refills

An adapter-level tracked miss may carry `observedWatermarkMs` from the same
atomic read. After a successful fallback, DialCache uses that observation to avoid
writing a replacement already known to be fenced:

1. Sample the application clock before serialization. If the sample is at or
   below the observed watermark, skip payload preparation and the write.
2. Otherwise serialize and compress, then sample again immediately before
   dispatch. If that final timestamp is at or below the watermark, skip `SET`.
3. Otherwise send the complete frame using that exact final timestamp.

The final sample keeps serialization time out of the stored frame's logical
TTL. The first check avoids expensive serialization and compression when a fill
cannot yet clear the fence. Both checks reuse the original observation; neither
adds a Redis command.

The miss **reason** is independent from the observed fence. An absent value can
carry a valid watermark and suppress a refill. A `watermark_fenced` miss can
later refill if the timestamp advances beyond that watermark. A miss without
an observed fence follows the normal write path.

A fenced refill is skipped immediately; the call does not wait for the watermark
to pass. An admitted refill still awaits serialization and the Redis write
before returning the fallback value, so those operations need
[application-owned budgets](coalescing.md#application-owned-budgets).
The checks do not establish a transaction with a later invalidation: the
watermark can advance after the read and fence an admitted write.

### In-memory publication

If an invocation reaches the tracked Redis read/write path, its fallback is not
published directly to process-local memory. A later validated Redis hit may
warm that layer. Local-only, remote-policy-disabled, and ramped-down paths retain
their local publication behavior.

Request-local memoization remains unconditional for successful results from the
lower chain. Existing process-local and request-local entries are not evicted.
A remote ramped-out invocation without shadow work does not consult Redis.

### Shadow reads and fills

Tracked shadow reads use the same primary snapshot and fence. Semantic shadow
misses apply the same two timestamp checks before filling. A skipped fill reports
`fill_fenced`; an accepted write reports `filled`, even though a later watermark
may fence it. Shadow fills remain ordinary overwrites, not compare-and-set.

See [Shadow validation](shadow-validation.md) for admission, comparison, and
race boundaries. [Stale-on-error](stale-on-error.md) has a distinct snapshot
contract: invalidation after the initial read cannot revoke retained bytes.

## Identity and Redis Cluster placement

The invalidation unit is `(namespace, keyType, String(id))`. It covers all tracked
`useCase` and `args` variants of that entity. Untracked entries ignore the
watermark.

```text
watermark: {users-api:user_id:123}#watermark
value:     {users-api:user_id:123}?locale=en#GetMutableUser:dialcache-frame-v1
```

The shared hash tag puts both keys in one Redis Cluster slot. Components are
percent-encoded so delimiters cannot collide with the format. Braces are
reserved and rejected. Values use the binary frame suffix; watermarks are
stored as decimal timestamps.

A complete supported positive-timestamp frame rejected at or below a valid
watermark is `watermark_fenced`. A missing value is `value_absent`, even when
metadata is malformed. Malformed present watermark metadata paired with a
present frame is `unclassified`. These classifications are described in
[Observability](observability.md#miss-reasons).

Redis `MGET` treats wrong-type members as absent. A wrong-type watermark therefore
acts like the zero baseline until explicit invalidation repairs it. Preserve
ownership of the keyspace; external writes can undermine the fence.

## Application clock contract

Writer timestamps, invalidation proposals, and logical ages use application
`Date.now()` clocks. DialCache does not query Redis `TIME`, calibrate an offset,
or compensate for skew. External clock synchronization and monitoring are part
of the deployment contract.

Relative skew moves logical expiry earlier or later. Frames dated after the
reading process's clock fail closed before serving. The optional future-offset
metric reports observed positive offsets, but cannot establish fleet-wide clock
health: co-skewed readers and writers, an ahead invalidator, and frames hidden
by a watermark can escape detection.

Elapsed operation durations and deadlines use the monotonic clock separately.

## Choosing `futureBufferMs`

The buffer covers stale work that can still become visible after invalidation.
The dangerous skew direction is a fast writer relative to a slow invalidator.

```text
futureBufferMs ≥ Dmax + maximum writer-clock lead + operational margin
```

`Dmax` runs from invalidation sampling until a stale pre-mutation `SET` can become
visible in Redis. Include source visibility/replication lag, remaining fallback
work, serialization, compression, client queueing and reconnect delay, network
transit, and Redis execution. An unbounded offline queue or retry path makes a
finite bound impossible.

The buffer is a nonnegative safe integer up to `31_536_000_000` milliseconds
(365 days). Its API default is zero for compatibility. Zero fences frames
stamped no later than invalidation, but provides no protection once delayed
stale work receives a later timestamp. Choose a named, application-owned value
from measured or conservative timing bounds; the example's five seconds is not
a universal recommendation.

A larger buffer raises fallback load. Native `MGET` still transfers existing
fenced payloads even when replacement serialization and `SET` are skipped.
The buffer does not force the loader to read an authoritative source, cancel
in-flight operations, or stop an already-dispatched write.

## Watermark lifetime

DialCache caps tracked Redis value retention at **one hour**. Each dispatched write
configured above that cap records `tracked_ttl_clamped`; its logical policy is
not rewritten. Invalidation alone creates and updates watermarks.

A finite watermark is retained for at least:

```text
max(existing remaining TTL,
    2 hours,
    watermark − invalidatedAtMs + 1 hour + 1 minute)
```

An existing persistent string watermark stays persistent. Reads and value writes
do not extend it. Under the clock and in-flight-work contract, the marker outlives
every value it can fence. The fixed minute is retention slack; it does not
replace a complete `Dmax` bound.

Invalidation repairs malformed string watermarks from a zero baseline while
preserving a longer remaining TTL or persistence. A wrong-type key is instead
treated as absent and replaced with a finite, derived TTL, even if that key was
persistent. Other Redis read errors surface without replacing the prior state.

Changing the tracked-value cap or watermark floor requires another coordinated
protocol transition: new constants cannot extend markers an older invalidator
already wrote. See [Upgrading](upgrading.md#tracked-protocol-cutover).

## Watermark durability

Watermarks are correctness state. If eviction, failover, restore, deletion, or an
external write removes a watermark, a tracked read can serve a previously fenced
value under the zero baseline.

Use `noeviction` or an equivalent preservation guarantee when relying on the
fence. Monitor memory headroom and rejected writes, and select persistence and
failover behavior consistent with the application's requirements. DialCache does
not issue `WAIT` or provide strong consistency across Redis failover.

## Failure behavior and telemetry

Invalid buffer arguments fail before dispatch. Missing Redis configuration and
invalidation I/O failures are logged, recorded with `error="invalidation"`, and
rethrown. The operation metric uses `keyType` and namespace; it does not attach
an entity id to labels.

Adapter retries reuse the original invalidation timestamp, preserve monotonicity,
and cannot shorten a longer/persistent string marker. Wrong-type repair follows
the exception above. A rejected dispatched mutation
can have executed, so an error does not prove absence of a watermark change.
See [Redis retries](redis.md#invalidation-retries-and-ambiguity).

## Independent fence checks

Invalidation changes what a subsequent tracked Redis read can accept. It does
not revoke a snapshot already read or cancel a caller-path flight. This matters
even with both in-memory layers and stale recovery disabled:

1. A tracked Redis read acquires a valid cached value, then waits in an
   asynchronous serializer.
2. A source mutation commits and `invalidateRemote()` completes.
3. A new same-key invocation joins that existing flight and receives the earlier
   value without another Redis read.

To keep later invocations from joining such work, set `coalesce: false` as in
the example above. With tracked remote caching active, request-local and
process-local caching off, and stale recovery off, a call starting after
invalidation performs its own tracked read or falls back to the source on cache
failure. Keep those effective settings in runtime overlays as well as defaults.

Already-started invocations can still finish with their acquired snapshots.
The source must supply authoritative reads, and the clock, buffer, and watermark
durability requirements still apply. This policy does not cancel work or create
a transaction between the source mutation and Redis.

## In-memory layers remain local

If local reuse or recovery is acceptable, choose its scope and lifetime
explicitly: neither remote invalidation nor `disable()` revokes a value already
held in memory. Default coalescing also trades independent observations for
shared work, as described above.
