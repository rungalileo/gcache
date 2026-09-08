# Redis and Valkey

[Documentation](index.md) · [API reference](api.md)

The remote layer shares cached reads across application instances. DialCache
owns cache behavior; your application owns the connected Redis client, its
resource budgets, and shutdown. You can use either bundled adapter or implement
`DialCacheRedisClient` for another client.

Start with a client below, then choose [serialization](#serialization) and
[compression](#compression). The [command reference](#bundled-redis-operations)
and [wire protocol](#advanced-wire-protocol) cover adapter and operational details.

## Install a client

```bash
# node-redis
npm install redis@~4.7.1

# or Valkey GLIDE
npm install @valkey/valkey-glide@^2.0.0
```

Configuring a client makes the remote layer available. Each operation still
needs an effective remote TTL, an admitted serving ramp, and an enabled scope.
See [Configuration](configuration.md#baseline-and-overlay-precedence).

## node-redis

Create and connect the client before wrapping it:

```ts
import { createClient } from "redis";
import { DialCache } from "dialcache";
import { createNodeRedisDialCacheClient } from "dialcache/node-redis";

const redisClient = createClient({
  url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  disableOfflineQueue: true,
  commandsQueueMaxLength: 1_000,
  socket: { connectTimeout: 2_000 },
});
redisClient.on("error", (error) => console.error("Redis client error", error));
await redisClient.connect();

const dialcache = new DialCache({
  namespace: "users-api",
  redis: {
    client: createNodeRedisDialCacheClient(redisClient),
    readTimeoutMs: 100, // Optional; the library default is 50 ms.
  },
});
```

The helper accepts the promise-based node-redis client, including its Cluster
client. It requires binary command replies and does not support `legacyMode`.
It manages invalidation script dispatch internally; no caller-side script
registration is needed. Tracked Cluster reads route to the slot primary.

These connection options are examples, not a complete operation budget. Bound
queueing, retries, reconnects, and command settlement for your application.

## Valkey GLIDE

Pass the direct standalone or Cluster client and the same module namespace that
created it:

```ts
import * as valkeyGlide from "@valkey/valkey-glide";
import { DialCache } from "dialcache";
import { createValkeyGlideDialCacheClient } from "dialcache/valkey-glide";

const glideClient = await valkeyGlide.GlideClient.createClient({
  addresses: [{ host: "127.0.0.1", port: 6379 }],
  requestTimeout: 2_000,
  advancedConfiguration: { connectionTimeout: 2_000 },
});

const dialcache = new DialCache({
  namespace: "users-api",
  redis: {
    client: createValkeyGlideDialCacheClient(glideClient, valkeyGlide),
  },
});
```

The adapter uses `GlideClient` and `GlideClusterClient` identities, `Batch`, and
`Decoder.Bytes` from that namespace. It does not import its own GLIDE runtime.
It rejects ambiguous forwarding wrappers or clients from another module
instance because their topology cannot be established safely.

In Cluster mode, tracked `MGET` uses an explicit primary route. In standalone
mode, a one-command non-atomic batch selects the primary even when the client
has a replica-read preference. `MGET` itself supplies the atomic snapshot;
there is no transaction and caller-owned `WATCH` state is not consumed.
`ClusterBatch` is not required.

## Remote-read deadlines and async liveness

The read deadline is resolved per invocation:

```text
runtime remoteReadTimeoutMs → defaultConfig.remoteReadTimeoutMs
                           → redis.readTimeoutMs → 50 ms
```

Values are positive safe integers through `2_147_483_647` milliseconds. A
remote read cannot be configured as unbounded.

When the wait expires, DialCache aborts `RedisReadContext.signal`, logs a
`RedisReadTimeoutError`, records `cache_read_timeout`, and invokes the source.
Late read outcomes are consumed and ignored. A read error or timeout does not
trigger a Redis refill or stale recovery. An active untracked local layer may
store the successful source result; a tracked path suppresses that publication.

The deadline covers the semantic read, not configuration, deserialization,
source work, writes, or invalidation. Coalesced followers share the leader's
remaining budget. The source deadline begins separately when fallback starts.
Recovery reuses the initial snapshot and creates no second read budget.

Node-redis passes a cooperative signal to native reads where supported. GLIDE
uses its configured native request budget. DialCache still bounds its own wait;
neither mechanism promises server-side cancellation or bounds all underlying
client work. See [Coalescing and liveness](coalescing.md).

## Lifecycle ownership

Before shutdown, stop new work and await public cache-operation and invalidation
promises, including loaders that may later write Redis. A read that DialCache
stopped waiting for can still be active in the client. Use client-native
controls to drain or terminate that work before closing the connection.

Close node-redis with `await redisClient.quit()` or close GLIDE with
`glideClient.close()` after draining application work. The adapters own no
additional resources. DialCache has no close or drain method.

Detached shadow work has no drain handle and does not keep a process alive.
Already-started Redis, source, serializer, or telemetry work may outlive its
shadow deadline. Account for that work when closing its dependencies; shutdown
may lose a best-effort shadow outcome even when a fill was dispatched.

## Serialization

Redis serialization precedence is operation `serializer`, then instance
`redis.serializer`, then `JsonSerializer`. In-memory caches retain native
references and do not serialize them.

### Default JSON behavior

`JsonSerializer` uses native JSON semantics and supports top-level `undefined`
through a private marker. Redis hits containing `null`, `false`, `0`, `""`, or
`undefined` are still hits.

JSON does not preserve every JavaScript value. Nested object `undefined` can
be omitted; undefined array elements and non-finite numbers can become `null`.
Dates lose their type, maps and sets lose their structure, and bigint or cycles
can fail serialization. Reference sharing and prototypes are not preserved.

Direct `JsonSerializer.dump(value)` calls return `Promise<string>`;
`load(string | Buffer)` returns `Promise<T>`, decoding Buffer input as UTF-8.
Malformed JSON rejects with `SyntaxError`. After handling top-level `undefined`,
`dump` rejects with `Error` when `JSON.stringify` returns undefined, as it does
for ordinary top-level functions or symbols. Bigint and cycles normally reject
with native `TypeError`. The generic `T` is a caller assertion, not schema
validation.

A fresh frame whose `load` fails becomes a refreshable miss: DialCache records
`serialization_load`, calls the source, and attempts replacement. The default
codec validates JSON syntax, not your application schema. For incompatible
value changes, use a validating serializer or change an identity dimension such
as `useCase`. Mixed incompatible readers can repeatedly replace one another's
values until a deployment converges.

A non-null shadow payload that fails deserialization is observation-only and
is never repaired. A retained recovery candidate that fails deserialization
preserves the original source rejection.

### Typed serializer requirement

The public types require a `Serializer<T>` when the result is not statically
JSON-compatible, even if the current policy uses only local memory. Runtime
policy can activate Redis later.

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig, type Serializer } from "dialcache";

const dialcache = new DialCache();
const dateSerializer: Serializer<Date> = {
  dump: (value) => value.toISOString(),
  load: (value) => new Date(Buffer.isBuffer(value) ? value.toString("utf8") : value),
};

const getUpdatedAt = dialcache.cached(
  async (userId: string) => new Date("2026-01-01T00:00:00Z"),
  {
    keyType: "user_id",
    useCase: "GetUpdatedAt",
    cacheKey: (userId) => userId,
    serializer: dateSerializer,
    defaultConfig: new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: 60 } }),
  },
);
```

`dump` produces `string | Buffer`; `load` receives that payload and returns the
value. Both may be asynchronous. Give them finite application-owned budgets.
A global `Serializer<unknown>` cannot satisfy a particular operation's typed
requirement.

The guard rejects known incompatible shapes including `Date`, `Map`, `Set`,
bigint, functions, symbols, Buffers, typed arrays, method-bearing classes,
required nested undefined, `unknown`, and `any`. It is conservative and cannot
prove runtime data has no cycles, non-finite numbers, getters, or `toJSON` hooks.
The structural check stops at eight property/array-element steps, so deeply
nested or recursive JSON types can also require a serializer. When ordinary JSON
correctly round-trips those values, supply an explicit `new JsonSerializer<T>()`.
Supplying a typed serializer is a trusted assertion, not an extra round-trip
validation performed by DialCache.

## Compression

Compression runs between the serializer and Redis adapter. It is on by default:

```ts
const dialcache = new DialCache({
  redis: {
    client: dialCacheRedisClient,
    compression: { thresholdBytes: 4_096, level: 3 },
  },
});
```

`thresholdBytes` is a positive safe integer; `level` is an integer from 1 to 22.
Use `compression: false` to disable compression of new writes. Invalid options
throw at instance construction. This is instance policy, not a runtime overlay.

Payloads meeting the threshold are compressed with zstd only when the stored
form is smaller. Reads always interpret the compression envelope, including
when new-write compression is disabled. Binary payloads beginning with an
envelope marker are escaped even in that disabled mode.

Compression and decompression execute synchronously on the event loop. Higher
levels trade CPU and latency for size reduction. Use the size, ratio, and
duration [metrics](observability.md#compression-metrics) to evaluate that tradeoff.

Decompressed output is capped at 512 MiB. Writes above the same ceiling remain
raw. With compression enabled, `below_threshold` takes precedence;
`write_over_limit` records an oversized payload that also reaches the threshold.
When native zstd rejects marked input, DialCache hands the original bytes to the
serializer (`fallback_raw`, or `read_over_limit` when the output limit caused
rejection). Native decoder acceptance is not corruption
validation: it can accept empty or truncated bodies as empty output and ignore
trailing bytes. A custom serializer must validate the application value it
receives, whether decompressed or raw. A compression exception fails the write
open.

See [Upgrading](upgrading.md#compression-and-value-schemas) for legacy binary
collisions and readers-first deployment of the envelope.

## Bundled Redis operations

### Reads

| Mode | Command | Meaning |
| --- | --- | --- |
| Untracked | `GET valueKey` | Decode one frame; ordinary client read routing applies |
| Tracked | `MGET valueKey watermarkKey` | Decode one authoritative value/watermark snapshot from the primary |

Each semantic read is one top-level command and one round trip. The payload
travels to Node before frame validation, watermark fencing, age checks, and
deserialization. An invalidated large value therefore still consumes transfer
bandwidth until it expires or is replaced.

The adapter returns either `DecodedRedisFrame { payload, createdAtMs }` or
`RedisReadMiss { kind: "miss", reason, observedWatermarkMs? }`. DialCache then checks
logical age against the operation's effective TTL. Future-dated or invalid
frames miss before deserialization. With recovery enabled, the initial read
may retain expired bytes while the source runs; see [Stale-on-error](stale-on-error.md).

Native wrong-type behavior is preserved. Untracked `GET` can reject with
`WRONGTYPE`. `MGET` represents a wrong-type member as `nil`: a wrong-type value
is absent, and a wrong-type watermark acts like a missing watermark. Explicit
invalidation repairs a wrong-type watermark.

### Writes

Every dispatched write uses the same complete-frame operation:

```text
SET valueKey frame PX cacheTtlMs
```

The frame carries the writer application's epoch timestamp. There is no value
write script, placeholder, transaction, or watermark mutation. Same-key writes
are last-writer-wins; tracked **reads** enforce invalidation.

Physical TTL is normally the remote TTL. With stale-on-error it is the maximum
recovery age instead. DialCache separately caps tracked values at one hour and emits
`tracked_ttl_clamped` for each dispatched write whose requested TTL exceeds the
cap. Untracked values retain their configured TTL, up to 365 days.

A tracked miss can carry a valid observed watermark. DialCache skips a replacement
already known to be fenced, checking once before payload preparation and again
immediately before dispatch. An admitted write uses the final timestamp exactly.
Misses without that fence let the adapter sample `Date.now()` before dispatch.
No path adds a fence-check command. See [Conditional refills](invalidation.md#conditional-refills).

### Invalidation retries and ambiguity

Invalidation is the only Lua operation. Both adapters dispatch `EVALSHA` and
retry a rejected dispatch once using `EVAL` with the source and the same
invalidation timestamp. The script only advances the watermark and widens its
retention, so duplicate execution after an ambiguous response is harmless.
Invalid reply-domain values are errors and are not retried.

If the retry also fails, GLIDE attaches the original error as `cause` when
possible. Node-redis surfaces the retry rejection unmodified because some
client errors are shared objects. A healed retry looks like success to DialCache
metrics; server command statistics expose unexpected `EVAL` activity.

A rejected or timed-out dispatched mutation does not prove that Redis remained
unchanged. Native writes do not implement compare-and-set or deduplicate retries
performed by an application or client.

### Redis compatibility and ACLs

The integration suite covers Redis 6.2, Valkey 8, and Redis Cluster. The bundled
operations require `GET`, `MGET`, and `SET`, plus `EVALSHA` and `EVAL` for
invalidation. If commands called inside scripts are checked separately, allow
`GET`, `SET`, and `PTTL` for the invalidation script.

DialCache does not issue `TIME`, `MULTI`, `EXEC`, `WATCH`, `UNLINK`, or
`SCRIPT LOAD`. Tracked invalidation also requires the
[clock and watermark durability contract](invalidation.md#application-clock-contract).

## Custom-client contract

Implement the three methods of `DialCacheRedisClient` and pass the object in
`redis.client`:

| Method | Return | Required semantics |
| --- | --- | --- |
| `read(request, context?)` | `RedisReadResult` or Promise | Decode the frame; atomically apply the primary watermark for tracked reads |
| `write(request)` | `void` or Promise | Write one complete frame with a finite TTL; honor an explicit `createdAtMs` exactly |
| `invalidate(request)` | `void` or Promise | Advance the watermark monotonically using the client timestamp and preserve required retention |

`read` receives `valueKey` and, only for tracked reads, `watermarkKey`.
`RedisReadContext` supplies `timeoutMs` and an `AbortSignal` for cooperative
cancellation. Returned payload bytes transfer to DialCache and must remain stable
while retained for shadow or recovery; return a dedicated Buffer if the client
pools or reuses response storage.

Use `decodeRedisReadResult` or `decodeTrackedRedisReadResult` from
`dialcache/redis-protocol`, or preserve their behavior exactly. Attach an
`observedWatermarkMs` only from the same valid tracked snapshot. Cause and fence
are independent: an absent value can carry a fence. DialCache validates the fence,
discards it for untracked keys, and maps unknown results/reasons to
`unclassified` misses. A `watermark_fenced` claim also becomes `unclassified` if
its observation is absent, invalid, or discarded for an untracked key.
Normalizing an unknown reason does not discard an otherwise valid tracked
observation. Use `isRedisReadMiss(result)` instead of a null comparison.

`write` receives `valueKey`, `value`, `cacheTtlMs`, and optional `createdAtMs`.
If present, that timestamp is the final value DialCache admitted against an observed
fence: honor it exactly. Otherwise sample real client time before dispatch.
A constant timestamp is incompatible with logical age enforcement.

`invalidate` receives `watermarkKey` and `futureBufferMs`. Supply a valid
`Date.now()` sample to `INVALIDATE_CACHE_SCRIPT` and reuse it across retries of
that logical operation. The public script takes `[futureBufferMs,
invalidatedAtMs]` as its arguments and returns integer `1`.

Bound connection, queue, dispatch, retry, reconnect, and response lifetimes.
DialCache bounds read waits but does not own the client's resource lifecycle or add
write/invalidation deadlines.

## Advanced wire protocol

The protocol subpath exports:

| Export | Contract |
| --- | --- |
| `encodeRedisFrame(payload, createdAtMs)` | Copy a `string \| Buffer` into a new version-1 Buffer; timestamp must be a nonnegative safe-integer number or it throws `RangeError` |
| `decodeRedisReadResult(raw)` | Decode one `Buffer \| null` reply into a frame or classified miss |
| `decodeTrackedRedisReadResult(raw, rawWatermark)` | Decode an atomic pair of `Buffer \| null` replies and preserve a valid observed fence on misses |
| `isRedisReadMiss(result)` | Test for a non-null object with `kind === "miss"`; does not validate its reason or watermark |
| `INVALIDATE_CACHE_SCRIPT` | Lua source; one watermark key and arguments `[futureBufferMs, invalidatedAtMs]`; returns numeric `1` |
| `validateRedisSetReply(reply)` | Accept exactly `"OK"` or a Buffer decoding to `"OK"`; return void, otherwise throw `DialCacheRedisProtocolError` |
| `validateRedisScriptInvalidationReply(reply)` | Accept and return numeric `1` only; otherwise throw `DialCacheRedisProtocolError` |
| `ceilSupportedCacheTtlMs(value)` | Accept a number whose ceiling is in `1..31_536_000_000` ms; return that ceiling, otherwise throw `RangeError` |

`CacheMissReason`, `DecodedRedisFrame`, `RedisReadMiss`, and `RedisReadResult`
are also exported as types from this subpath.

A stored value has a ten-byte header followed by payload:

| Bytes | Meaning |
| --- | --- |
| `0` | Version `1` |
| `1..8` | Big-endian unsigned 64-bit application epoch timestamp; writers must stay within the JavaScript safe-integer domain |
| `9` | Encoding: `0` UTF-8 string, `1` binary |
| `10..` | Payload, possibly a compression envelope |

### Read decoding and validation order

Both decoders reject invalid raw reply types, including JavaScript strings, with
`DialCacheRedisPayloadError`. The tracked decoder validates both reply types
before classifying either value. Binary payloads are views into the input frame;
copy them if the backing Buffer may be mutated or reused.

After reply validation, a null value is `value_absent`; a short frame or unknown
version is `unclassified`. Either tracked miss can preserve a valid paired
watermark. Watermark text must contain decimal digits only and represent a value
from zero through `Number.MAX_SAFE_INTEGER`. Zero and leading zeros are accepted;
signs, whitespace, fractions, and exponent notation are not. A missing watermark
uses a zero baseline and does not attach `observedWatermarkMs`.

For a supported tracked frame, malformed present watermark text produces
`unclassified`. A zero frame timestamp also produces `unclassified`. A positive
timestamp at or below a valid watermark produces `watermark_fenced`. These
checks precede payload decoding, so even an unknown encoding can be hidden by
one of these misses. An otherwise eligible frame with an unsupported encoding
throws `DialCacheRedisPayloadEncodingError`.

The untracked decoder accepts a zero timestamp. Both decoders convert the raw
uint64 to a JavaScript number without rejecting unsafe values, which can lose
precision. DialCache separately rejects unsafe timestamps and applies its
[age and clock rules](observability.md#value-ages-and-clock-offsets); the codecs
alone do not establish that a decoded frame is fresh or safe to serve.

### Invalidation script and payload envelope

The script requires digit-only decimal arguments in the nonnegative safe-integer
domain. The buffer must be at most `31_536_000_000` ms, and timestamp plus buffer
must remain safe. Invalid arguments return Redis errors before any mutation.
Its repair and retention rules are covered under
[Watermark lifetime](invalidation.md#watermark-lifetime).

The binary payload envelope uses `0x00` to escape raw marker-prefixed bytes,
`0x01` for compressed string output, and `0x02` for compressed binary output.
Adapters treat the payload as opaque: DialCache interprets this envelope above them.
The physical value key appends `:dialcache-frame-v1` to the logical key.

Read [Upgrading](upgrading.md) before migrating an older adapter or namespace.
