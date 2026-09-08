# Upgrading

[Documentation](index.md) · [Maintainer guide](maintainers.md)

Check the installed version and the behavior being enabled before sharing a
Redis namespace across releases. A compatible frame layout does not by itself
make two implementations safe to run together.

This guide covers the transitions relevant to the implementation on `main`.
Use the [release notes](https://github.com/lan17/DialCache/releases) and matching
tagged source for the versions in your fleet.

## Tracked protocol cutover

The current protocol writes one complete client-stamped frame with native `SET`.
Older tracked writers used a placeholder and stamp script; those writers and
invalidators must not coexist with the new protocol in an active namespace.

Before enabling the new protocol:

1. Stop and drain every old writer and invalidator, including in-flight source
   fallbacks, shadow work, client queues, and operations that can still write.
2. Purge every tracked value, including complete frames and placeholders, and
   every watermark in the affected namespace.
3. Start the new fleet with its clock, buffer, and watermark-preservation
   requirements in place.

On a dedicated Redis deployment, an authorized full namespace purge is the
simplest option. Untracked complete frames may be retained. This is an external
operational procedure; DialCache does not implement a deployment gate or purge
API.

Alternatively, leave affected traffic disabled until all old tracked values
and watermarks expire. That is safe only when their maximum remaining lifetimes
are bounded, no watermark is persistent, and the wait covers both old value
retention and future-buffer-derived watermark retention.

Changing the namespace creates a cold boundary, but old and new namespaces also
have separate watermarks. Overlapping fleets need a coordinated invalidation
strategy; simply changing the string does not preserve mutable-data freshness.

The current cap of one hour for tracked values and watermark floor of two hours
are part of this protocol relationship. Raising the cap or shrinking the floor
requires another coordinated transition because old markers cannot be extended
by deploying new constants alone.

## Removed configuration fields

Remove these legacy properties entirely; construction rejects their own-property
presence even when the value is `undefined`:

| Older field | Replacement |
| --- | --- |
| `DialCacheConfig.urnPrefix`, `DialCacheKeyInit.urnPrefix` | `namespace` |
| `DialCacheConfig.rampSampler` | Built-in deterministic key-and-layer ramp assignment; no injected sampler |
| `DialCacheKeyConfig.shadowRamp` | `shadow.ramp` |
| `RedisConfig.keyPrefix` | The instance's `namespace` |
| `RedisConfig.createClient` | Create and connect the client in the application, then pass the semantic `client` |
| `RedisConfig.watermarkTtlSec` | Remove it; DialCache derives watermark retention |

See [Runtime validation](configuration.md#validation-and-snapshots) for how an
obsolete field in a provider result differs from invalid static configuration.

## Custom Redis adapters

Migrate against the current [semantic interface](redis.md#custom-client-contract):

| Older surface | Current contract |
| --- | --- |
| Tracked placeholder and stamp helpers | `encodeRedisFrame` plus one complete-frame `SET` |
| Write request with `watermarkKey`; boolean outcome | `RedisWriteRequest` has no watermark field; `write()` returns void |
| `dialcacheRedisScripts`, `DialCacheNodeRedisScripts` | Removed; node-redis manages invalidation dispatch internally |
| `DialCacheRedisPlaceholderLostError` | Removed with the placeholder write path |
| `ClusterBatch` required by GLIDE runtime | No longer required; direct Cluster MGET routing |
| `null` or `RedisWatermarkMiss` typed misses | `RedisReadMiss { kind: "miss", reason, observedWatermarkMs? }` |
| `decodeRedisFrame`, `decodeTrackedRedisFrame` | `decodeRedisReadResult`, `decodeTrackedRedisReadResult` |

Use `isRedisReadMiss` from the root or protocol subpath to discriminate read
results. Runtime unknown results, including legacy null, become unclassified
misses and refill normally, but lose reason precision and observed-fence refill
suppression.

If an adapter returns a trustworthy `observedWatermarkMs`, it must honor a
supplied `RedisWriteRequest.createdAtMs` exactly. Direct callers may omit that
field; the adapter then samples real client time immediately before dispatch.
All decoded frames need their real writer timestamp. Constants that older
untracked adapters treated as informational fail current logical-age checks.

Invalidation is the only Lua script. It receives `[futureBufferMs,
invalidatedAtMs]`; reuse the second argument across retries of one logical
operation. See [Targeted invalidation](invalidation.md) for timing and retention.

## Stale retention and downgrades

Stale-on-error keeps the same frame keys and layout but can retain values
physically through `M` while ordinary reads enforce the shorter logical age
`F`.

Deploy readers that enforce `F` everywhere **before** enabling writers with
longer `M` retention. A pre-feature reader that trusts physical expiry can
otherwise serve retained data normally between `F` and `M`.

Once a key is written with physical `M`, do not reintroduce older readers until
all such keys expire or are explicitly removed. Turning recovery off on current
readers is safe because they still enforce `F`; it does not remove the older
readers' downgrade barrier.

A larger maximum age does not extend an existing Redis key. Tracked values
retain their one-hour physical cap, and a snapshot already retained by a process
can remain eligible within `M` after Redis expiry or invalidation.

## Compression and value schemas

Current readers always decode the compression envelope, even when new-write
compression is disabled. For string/JSON values, a readers-first deployment with
`compression: false`, followed by enabling compression after convergence, avoids
old readers encountering compressed values.

A reader without envelope support may fail `load` and refill a compressed value.
During an overlapping deployment, expect serialization failures and refill churn
unless the rollout prevents those reads. A permissive binary decoder can
misinterpret foreign bytes instead of rejecting them.

Legacy binary output can collide with envelope markers:

- A legacy `0x01`/`0x02` prefix whose remaining bytes are accepted by native zstd
  can be decoded as compressed data. Acceptance does not guarantee a complete
  valid stream; empty/truncated bodies or trailing bytes may also be accepted.
- A legacy payload beginning with `0x00` followed by `0x00`, `0x01`, or `0x02`
  can lose its first byte to the escape rule.
- New writers escape colliding raw binary prefixes even with compression off.

Version an identity dimension, such as the use case, when a custom binary
serializer can produce these collisions. A compression-off first phase alone
does not protect an old permissive reader from escaped binary values.

For application schema changes, native JSON validates syntax only. Keep values
compatible, use a serializer that validates and rejects old shapes, or move to
a new identity. Mutually incompatible validating readers can continually replace
each other's values while they overlap.

## Metric migrations

Miss metrics carry a required bounded `reason`: `value_absent`, `expired`,
`watermark_fenced`, or `unclassified`. Old Prometheus collectors with four miss
labels cannot share the same in-process registry/prefix with the current
five-label collector. The future-offset histogram also uses dedicated clock-skew
buckets; an incompatible same-name collector fails adapter construction before
partial registration. Use a separate registry or prefix where needed.

During a mixed-fleet rollout, aggregate away `reason` when comparing total misses
with total requests. For example:

```text
sum by (cache_namespace, use_case, key_type, layer) (
  rate(dialcache_miss_counter[5m])
)
/
sum by (cache_namespace, use_case, key_type, layer) (
  rate(dialcache_request_counter[5m])
)
```

Reason dashboards should group explicitly by `reason`. In Datadog, the extra
tag increases miss-series combinations by up to four per prior tuple; account
for overlapping old/new tag sets and the selected metric aggregations.

Update exhaustive public-union mappings: `tracked_ttl_clamped` is a
`MetricErrorKind`; `fill_blocked` is removed and `fill_fenced` is a
`ShadowValidationOutcome`. Recovery has `served`, `miss`, and
`deserialization_error` outcomes. Custom `miss` handlers now receive
`MissMetricLabels`; broader handlers may ignore the additional reason, while
exact label mappings and direct calls need to include it.

See [Observability](observability.md) for current names, units, and hooks.
