# Observability

[Documentation](index.md) · [API reference](api.md)

Metrics are disabled unless a `DialCacheMetricsAdapter` is passed to the
constructor. `new DialCache()` does not import a metrics backend, register
collectors, or emit metrics.

DialCache provides first-party adapters for Prometheus and Datadog. Both use
caller-created, caller-owned clients and preserve one backend-neutral set of
bounded labels.

## Reading the signals

Start with source load and caller latency, then explain changes with the cache
metrics. An earlier-layer hit stops traversal; a coalesced follower does not
repeat the leader's full read/miss trail.

| Signal | Interpretation |
| --- | --- |
| Requests and misses by layer | Which layer actually serves or falls through |
| Miss reason | Absence, logical expiry, invalidation fencing, or an unclassified miss |
| Disabled reason | Intentional policy/ramp skips versus invalid configuration |
| Errors and fallback duration | Dependency failures and source cost, including recovered source failures |
| Shadow outcomes and value ages | Comparison verdicts, fill activity, drops, and detached failures |
| Recovery outcomes and value ages | How often an older snapshot serves during eligible source failures |
| Compression size, ratio, and duration | Prepared payload savings versus synchronous CPU cost |
| Future timestamp offset | Observed frames ahead of the reader clock; an incomplete clock-health signal |

Durations and ages use seconds; sizes use bytes. Namespace, use case, and key
type should remain bounded application-defined labels. No metric includes cache
ids, arguments, payloads, or raw error text.

## Miss reasons

`miss()` receives `MissMetricLabels` with one required reason. Both bundled
backends emit the same bounded values:

| `reason` | Meaning |
| --- | --- |
| `value_absent` | No retrievable value: never populated, physically expired, evicted, Redis nil, or tracked MGET wrong-type-as-nil. All local misses use this reason. |
| `expired` | A supported valid non-future Redis frame reached its logical fresh age, including retained stale candidates and frames beyond the recovery maximum. |
| `watermark_fenced` | A supported positive-timestamp tracked frame was rejected at or below a valid observed watermark, before deserialization. |
| `unclassified` | Other real misses, including unknown adapter results, malformed frames/metadata, invalid or future timestamps, and deserialization failures. |

Read errors and timeouts are errors, not ordinary misses. The observed watermark
used for refill suppression is separate from the reason; a missing value can
carry a valid fence.

## Prometheus

Install `prom-client` separately:

```bash
npm install prom-client@^15.1.3
```

Create the registry your application owns, then pass an explicit adapter to
DialCache:

```ts
import { Registry } from "prom-client";
import { DialCache } from "dialcache";
import { createPrometheusDialCacheMetrics } from "dialcache/prometheus";

const registry = new Registry();

const dialcache = new DialCache({
  namespace: "users-api",
  metrics: createPrometheusDialCacheMetrics({
    registry,
    prefix: "myapp_",
  }),
});

app.get("/metrics", async (_req, res) => {
  res.type(registry.contentType).send(await registry.metrics());
});
```

The adapter requires a caller-owned `Registry`. It never uses the global
default registry, and it does not clear or otherwise own the registry
lifecycle. `prefix` defaults to `""` and is concatenated literally with each
metric name; include any desired separator yourself.

Multiple adapters with the same registry and prefix reuse existing collectors
when their type, help, labels, histogram buckets, and exemplar mode match.
Adapter construction fails before registering anything if a same-name
collector has an incompatible schema. Use a unique prefix or separate registry
to resolve a collision. DialCache's collectors do not enable exemplars, so an
exemplar-enabled collector with the same name is incompatible.

### Histogram buckets

Bucket boundaries are fixed; the adapter has no bucket customization option:

| Metric family | Unit | Finite bucket boundaries |
| --- | --- | --- |
| All timers | Seconds | `0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10` |
| Serialized and stored sizes | Bytes | `100, 1000, 10000, 100000, 1000000, 10000000` |
| Compression ratio | Ratio | `0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1` |
| Shadow and recovery value ages | Seconds | `1, 5, 15, 60, 300, 900, 3600, 10800, 43200, 86400, 259200, 604800` |
| Future timestamp offsets | Seconds | `0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5, 15, 60, 300, 900, 3600, 10800, 43200` |

### Prometheus metrics

The names below exclude the optional caller-selected prefix:

| Metric | Type | Labels | Description |
| --- | --- | --- | --- |
| `dialcache_request_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `layer` | Cache-layer requests that reached an enabled layer |
| `dialcache_miss_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `layer`, `reason` | Cache misses, classified by one required bounded reason |
| `dialcache_disabled_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `layer`, `reason` | Cache skips (`context`, `policy_disabled`, `invalid_ttl`, `invalid_ramp`, `ramped_down`, `config_error`) |
| `dialcache_error_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `layer`, `error`, `in_fallback` | Cache/fallback errors and the bounded `tracked_ttl_clamped` configuration signal |
| `dialcache_invalidation_counter` | Counter | `cache_namespace`, `key_type`, `layer` | Invalidation calls for the layers touched |
| `dialcache_coalesced_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `scope` | Coalesced requests split by `request_local` or `process` scope |
| `dialcache_shadow_validation_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `outcome` | Sampled Redis shadow-job outcomes |
| `dialcache_shadow_value_age_histogram` | Histogram | `cache_namespace`, `use_case`, `key_type`, `outcome` | Age in seconds of the validated Redis value at shadow verdict time, recorded for `match` and `mismatch` |
| `dialcache_future_timestamp_offset_histogram` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Positive offset in seconds for a valid frame dated after the observing process clock |
| `dialcache_stale_recovery_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `outcome` | Classifier-authorized stale-recovery checks: `served`, `miss`, or `deserialization_error` |
| `dialcache_stale_recovery_value_age_histogram` | Histogram | `cache_namespace`, `use_case`, `key_type`, `outcome` | Actual return-time age in seconds of a retained value, recorded only for `served` |
| `dialcache_compression_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `layer`, `outcome` | Payload compression outcomes: writes record `compressed`, `below_threshold`, `not_smaller`, or `write_over_limit`; reads record `decompressed`, `fallback_raw`, or `read_over_limit` |
| `dialcache_get_timer` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Cache get latency in seconds |
| `dialcache_fallback_timer` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Elapsed time until the underlying function settles or timeout rejection is delivered |
| `dialcache_serialization_timer` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer`, `operation` | Redis serializer dump/load latency |
| `dialcache_size_histogram` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Serialized Redis payload size in bytes, before compression |
| `dialcache_stored_size_histogram` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Prepared Redis payload size in bytes, after compression and escaping; before dispatch |
| `dialcache_compression_ratio_histogram` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Compressed-to-original payload size ratio for compressed writes |
| `dialcache_compression_timer` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer`, `operation` | Payload compression and decompression latency in seconds |

The disabled reasons are:

- `context`;
- `policy_disabled`;
- `invalid_ttl`;
- `invalid_ramp`;
- `ramped_down`; and
- `config_error`.

`policy_disabled` means that a process-local or remote layer has no effective
TTL after runtime overlays. This is an intentional policy result, including the
default when `defaultConfig` is omitted, rather than a configuration-loading
failure.

Every metric includes `cache_namespace`, even disabled-context,
key-construction, coalescing, and invalidation paths that do not have a
constructed key. Its value is `DialCacheConfig.namespace`, which defaults to
`urn`.

The `layer` label is:

- `request_local`;
- `local`, meaning process-local;
- `remote`;
- `remote_shadow` for Redis reads, fills, serialization, compression, and
  payload sizes performed by detached shadow jobs; or
- `noop` for disabled-context, key-construction, and config-provider failures
  where no cache layer was reached.

The bounded `scope` label on `dialcache_coalesced_counter` distinguishes
`request_local` from `process`. `scope="process"` coordinates calls only within
one `DialCache` instance; separate instances in the same process do not share
in-flight state. A use case with `coalesce: false` emits no coalesced counter;
each caller instead emits its own request, miss, duration, and error metrics.

## Datadog

Install `hot-shots` separately:

```bash
npm install hot-shots@^17.0.0
```

Create the DogStatsD client your application owns, then pass it to the Datadog
adapter:

```ts
import StatsD from "hot-shots";
import { DialCache } from "dialcache";
import { createDatadogDialCacheMetrics } from "dialcache/datadog";

const dogStatsD = new StatsD({
  host: process.env.DD_AGENT_HOST ?? "127.0.0.1",
  globalTags: {
    service: "users-api",
    env: process.env.DD_ENV ?? "development",
  },
  errorHandler: (error) =>
    logger.warn("DogStatsD error", { error }),
});

const dialcache = new DialCache({
  namespace: "users-api",
  metrics: createDatadogDialCacheMetrics({
    client: dogStatsD,
    observationMetricType: "distribution",
    namespace: "dialcache",
  }),
});

function shutdown(): void {
  // Close the client yourself once outstanding DialCache calls have settled.
  // DialCache never flushes or closes it.
  dogStatsD.close();
}
```

`hot-shots` is the supported and tested client, but the adapter depends only on
the exported `DatadogDogStatsDClient` structural interface. Construction requires
all three methods, `increment`, `histogram`, and `distribution`, to be functions,
regardless of the selected observation mode.

DialCache does not:

- import or install `hot-shots`;
- create a client;
- flush buffers;
- close sockets; or
- otherwise own the client lifecycle.

### Distribution or histogram

`observationMetricType` is required.

Choose `"distribution"` when latency and size percentiles must aggregate across
hosts. Enable the desired distribution percentiles and aggregations in
Datadog.

Choose `"histogram"` when host-level histogram aggregation matches the existing
Datadog setup. The choice applies uniformly to every duration, size, ratio, age, and offset
observation emitted by the adapter. Both modes produce Datadog custom metrics.

Metric volume depends on tag combinations and selected aggregations. Review
[Datadog's custom-metrics billing guidance](https://docs.datadoghq.com/account_management/billing/custom_metrics/)
before rollout.

Do not send both observation types under the same metric namespace. When
changing types, use a new namespace during migration so one metric identity
never mixes histogram and distribution points.

### Datadog namespaces

`DatadogMetricsOptions.namespace` is the metric-name namespace and defaults to
`dialcache`. It is separate from `DialCacheConfig.namespace`, the logical cache
namespace emitted as the `cache_namespace` tag.

The Datadog metric namespace must:

- start with a letter;
- contain only letters, numbers, underscores, and dot-separated non-empty
  segments; and
- produce final metric names no longer than 200 characters.

The adapter rejects invalid namespaces and overlong final names instead of
relying on client-side normalization.

A `hot-shots` `prefix` is applied after the adapter constructs the name. Include
that prefix when checking final length, and avoid accidentally combining it
with the adapter namespace. Client-level `globalTags` are appended by
`hot-shots`; the table below lists only tags added by DialCache.

### Datadog metrics

The adapter emits exact increments of `1` for counters and preserves seconds
and bytes without unit conversion:

| Metric | Type | Tags | Description |
| --- | --- | --- | --- |
| `dialcache.request.count` | Count | `cache_namespace`, `use_case`, `key_type`, `layer` | Cache-layer requests that reached an enabled layer |
| `dialcache.miss.count` | Count | `cache_namespace`, `use_case`, `key_type`, `layer`, `reason` | Cache misses, classified by one required bounded reason |
| `dialcache.disabled.count` | Count | `cache_namespace`, `use_case`, `key_type`, `layer`, `reason` | Cache skips by bounded reason |
| `dialcache.error.count` | Count | `cache_namespace`, `use_case`, `key_type`, `layer`, `error`, `in_fallback` | Cache/fallback errors and the bounded `tracked_ttl_clamped` configuration signal |
| `dialcache.invalidation.count` | Count | `cache_namespace`, `key_type`, `layer` | Invalidation calls for the layers touched |
| `dialcache.coalesced.count` | Count | `cache_namespace`, `use_case`, `key_type`, `scope` | Coalesced requests by sharing scope |
| `dialcache.shadow.count` | Count | `cache_namespace`, `use_case`, `key_type`, `outcome` | Sampled Redis shadow-job outcomes |
| `dialcache.shadow.value_age` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `outcome` | Age in seconds of the validated Redis value at shadow verdict time, recorded for `match` and `mismatch` |
| `dialcache.future_timestamp_offset` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Positive offset in seconds for a valid frame dated after the observing process clock |
| `dialcache.stale_recovery.count` | Count | `cache_namespace`, `use_case`, `key_type`, `outcome` | Classifier-authorized stale-recovery checks: `served`, `miss`, or `deserialization_error` |
| `dialcache.stale_recovery.value_age` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `outcome` | Actual return-time age in seconds of a retained value, recorded only for `served` |
| `dialcache.compression.count` | Count | `cache_namespace`, `use_case`, `key_type`, `layer`, `outcome` | Payload compression outcomes: writes record `compressed`, `below_threshold`, `not_smaller`, or `write_over_limit`; reads record `decompressed`, `fallback_raw`, or `read_over_limit` |
| `dialcache.get.duration` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Cache get latency in seconds |
| `dialcache.fallback.duration` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Elapsed time until the underlying function settles or timeout rejection is delivered |
| `dialcache.serialization.duration` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer`, `operation` | Redis serializer dump/load latency in seconds |
| `dialcache.serialization.size` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Serialized Redis payload size in bytes, before compression |
| `dialcache.stored.size` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Prepared Redis payload size in bytes, after compression and escaping; before dispatch |
| `dialcache.compression.ratio` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Compressed-to-original payload size ratio for compressed writes |
| `dialcache.compression.duration` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer`, `operation` | Payload compression and decompression latency in seconds |

Synchronous client throws are isolated when DialCache invokes the adapter.
DialCache also consumes thenables returned by adapter hooks, but this adapter does
not forward every client return value: only `shadowValidation` and
`staleRecovery` return the counter call's result. A custom DogStatsD client must
handle its own asynchronous delivery failures, including rejected promises.
Direct adapter calls do not have DialCache's observer guard. Configure client error
handling and shutdown as part of application ownership.

## Shadow outcomes

`dialcache_shadow_validation_counter` reports one terminal outcome for each
admitted or explicitly dropped shadow job. Datadog exposes the same bounded
outcomes through `dialcache.shadow.count`:

| `outcome` | Meaning |
| --- | --- |
| `match` | The cached and source values matched. |
| `mismatch` | They differed, and a confirmation read found the original Redis payload unchanged. |
| `superseded` | They differed, but the Redis payload changed or disappeared before confirmation. |
| `filled` | A clean shadow miss was populated successfully. |
| `fill_fenced` | A timestamp check skipped tracked fill dispatch against the watermark observed in the initial read. |
| `fill_error` | Preparing the payload (serialization or compression) or writing a clean-miss fill failed. |
| `redis_error` | The initial detached Redis read failed. |
| `source_error` | The source-of-truth read failed. |
| `deserialization_error` | The retained Redis payload could not be deserialized for comparison. |
| `comparison_error` | The comparator threw or did not return a synchronous boolean. |
| `confirmation_error` | The confirmation Redis read failed. |
| `timeout` | The shadow deadline expired. |
| `dropped` | Per-key deduplication or the instance flight cap rejected the job. |

The outcome counter deliberately has no `layer` or cache-id label. Operational
Redis metrics produced inside the same job use `layer="remote_shadow"`, which
keeps detached work separate from caller-serving `layer="remote"` telemetry.
See [Shadow validation](shadow-validation.md) for the read, confirmation, fill,
and deadline semantics behind these outcomes.

## Stale recovery outcomes

`dialcache_stale_recovery_counter` and `dialcache.stale_recovery.count` record one
outcome for each classifier-authorized recovery check:

| Outcome | Meaning |
| --- | --- |
| `served` | A retained candidate passed return-time age checks and supplied the result |
| `miss` | No candidate remained eligible |
| `deserialization_error` | Decoding the retained candidate failed |

Only `served` emits the corresponding value-age observation. Recovery adds no
second Redis request, miss, or read-duration sequence. The source failure and
fallback duration remain visible even when a snapshot serves. Classifier denial
emits no recovery outcome. See [Stale-on-error](stale-on-error.md).

## Value ages and clock offsets

Shadow value age is reported only for `match` and confirmed `mismatch`, at verdict
time. Recovery age is reported only for `served`, at return time. Both use the
observing application's epoch clock minus the frame's writer timestamp.
Shadow age uses the original `C0` timestamp, even if confirmation finds identical
payload bytes with a newer timestamp. It clamps to zero after clock rollback and
skips nonfinite age observations.

The future-offset histogram records a positive offset for valid decoded frames
ahead of the observer clock. Ordinary and initial-shadow reads then miss;
confirmation can retain the frame only for comparison. Invalid timestamps never
enter histogram sums. Repeated reads can observe the same future frame.

For direct adapter callers, Prometheus additionally discards nonfinite or
nonpositive `observeFutureTimestampOffset` values. Datadog forwards those
observations without that extra guard; normal DialCache calls supply positive finite
offsets to both.

Use external fleet clock monitoring as well: workload observations cannot detect
every skew direction or determine which node is wrong. Its dedicated histogram
buckets cover millisecond-scale through multi-hour faults.

## Compression metrics

Compression telemetry is bounded and uses `layer="remote"` for caller-serving
work or `layer="remote_shadow"` for detached shadow work.

Write-side outcomes are:

- `compressed`: zstd plus its envelope was smaller and selected for the
  prepared Redis payload;
- `below_threshold`: the serialized payload did not reach the configured
  threshold; this check runs before the size ceiling;
- `not_smaller`: compression ran, but the marked result was not smaller than
  the raw stored form; and
- `write_over_limit`: the serialized value reached the threshold but exceeded
  the 512 MiB decompression ceiling and was kept raw for the attempted write.
  This is a capacity signal, not an error.

Read-side outcomes are:

- `decompressed`: a marked zstd payload was restored;
- `fallback_raw`: native zstd rejected a marked payload for a reason other than
  the output limit, so it was passed unchanged to the serializer; and
- `read_over_limit`: decompression would exceed the 512 MiB ceiling, so the
  stored bytes were passed unchanged to the serializer. Treat this as a
  corruption or integrity signal.

Raw reads do not emit a compression outcome. With `compression: false`, new
writes are still escaped when necessary but emit no compression outcome; reads
continue to report marked values because disabling writes does not disable
decoding.

`dialcache_size_histogram` measures serializer output before compression and is
the distribution to use when selecting `thresholdBytes`.
`dialcache_stored_size_histogram` measures the prepared bytes after compression
or binary-envelope escaping. DialCache records it before final shadow-deadline/fence
gates and before calling the Redis client, so it is not proof that a write was
dispatched or succeeded. The ratio histogram is emitted when compression
selects the smaller representation, at the same pre-write stage.

Compression duration is observed when zstd runs and produces either
`compressed` or `not_smaller`; decompression duration is observed for each
marked payload that produces a read-side outcome.

A zstd exception while preparing a write records `error="compression"` and
the cache write fails open. Decompression rejects neither the cache call nor
the observer path directly: rejected marked bytes reach the configured
serializer. If `load` rejects, it records `serialization_load`. An ordinary fresh
read becomes a refreshable miss; shadow comparison reports
`deserialization_error` without repair, and retained recovery preserves the
original source rejection. See [Serialization](redis.md#serialization).

zstd work is synchronous on the Node.js event loop. Use the duration, ratio,
and pre/post-size series together when changing the threshold or level; a good
space ratio does not make an event-loop stall acceptable. See
[Redis payload compression](redis.md#compression) for the envelope, limits,
and mixed-version rollout contract.

## Confirmed mismatch warnings

Shadow metrics remain bounded and contain no cache ids or values. A use case can
separately set `shadow.logMismatches: true` to emit one warning after a terminal
`mismatch` is confirmed. Logging is default-off, does not replace the outcome
metric, and does not activate shadow work without the `shadowValidation` hook.

The warning contains stable metadata, the logical cache key capped at 2 KiB,
and independently generated native-JSON strings for the cached and source
comparator inputs capped at 8 KiB each. Those fields are value-bearing, and
truncation is not redaction.

See
[Confirmed mismatch logging](shadow-validation.md#confirmed-mismatch-logging)
for confirmation semantics, exact fields, JSON behavior, operational limits,
and data-handling considerations.

## Error categories

The `error` label reports the operation that failed instead of copying the
thrown value's class or `Error.name`:

| `error` | Meaning |
| --- | --- |
| `key_construction` | The cache-key selector or `DialCacheKey` construction failed |
| `config_resolution` | Runtime or layer configuration validation or resolution failed |
| `cache_read` | A process-local read or non-timeout remote read failed |
| `cache_read_timeout` | A remote read exceeded its effective DialCache deadline |
| `cache_write` | A process-local or remote cache write failed |
| `tracked_ttl_clamped` | A dispatched tracked write requested retention above the one-hour physical cap |
| `serialization_load` | Deserializing a Redis payload failed |
| `serialization_dump` | Serializing a value for Redis failed |
| `compression` | zstd compression failed while preparing a Redis write |
| `invalidation` | Writing an invalidation watermark failed |
| `fallback` | The source loader failed or exceeded its DialCache deadline |
| `unknown` | Reserved for a future failure site that cannot be classified otherwise |

DialCache defines these values itself, so they are identical for every adapter.

A valid `invalidateRemote()` call without a configured Redis client is still an
invalidation attempt: DialCache records `dialcache_invalidation_counter` (or
`dialcache.invalidation.count`), logs the failure, records
`error="invalidation"`, and rejects with the original focused `TypeError`.
Invalid `futureBufferMs` input is rejected before these observers run.

Caller-serving remote-read timeouts use `layer="remote"` and
`in_fallback="false"`. They are
errors rather than misses, and the remote get-duration observation includes
the wait. Coalesced followers do not multiply the timeout error. Deadline
details remain out of labels and are available on the logged
`RedisReadTimeoutError`.

Detached initial and confirmation reads attribute their operational metrics to
`remote_shadow`. Read failures, including read timeouts, can report `redis_error`
or `confirmation_error` without a matching error log. The overall shadow deadline
instead reports `timeout`; see [Shadow outcomes](#shadow-outcomes).

Raw thrown values, error names, messages, cache ids, arguments, and Redis keys
are never included in labels. When DialCache logs a cache-plumbing failure, the
raw details remain available through the configured logger; not every metric
error or shadow outcome has a matching log entry.

The explicitly opted-in confirmed-mismatch warning is a separate value-bearing
log and does not alter the metric schema.

`in_fallback` remains the explicit distinction between cache plumbing and
application fallback failures.

## Custom adapters

Implement `DialCacheMetricsAdapter` and pass it through
`new DialCache({ metrics })` for another telemetry backend.

| Hook | Required | Value |
| --- | --- | --- |
| `request(labels)` | yes | One active cache-layer lookup. |
| `miss(labels)` | yes | One cache miss with required bounded `reason` (`MissMetricLabels`). |
| `disabled(labels)` | yes | One skipped layer or no-layer invocation with a bounded `reason`. |
| `error(labels)` | yes | One bounded failure site with `inFallback`. |
| `invalidation(labels)` | yes | One explicit remote invalidation call. |
| `coalesced(labels)` | no | One follower that joined request-local or process-scoped work. |
| `shadowValidation(labels)` | no | One terminal sampled-shadow outcome. This hook must be implemented for shadow jobs to execute. |
| `observeShadowValueAge(labels, seconds)` | no | Age for shadow match/mismatch verdicts; does not gate admission. |
| `observeFutureTimestampOffset(labels, seconds)` | no | Positive decoded-frame clock offset; does not change read decisions. |
| `staleRecovery(labels)` | no | One authorized recovery outcome; omission does not disable recovery. |
| `observeStaleRecoveryValueAge(labels, seconds)` | no | Return-time age for served recovery only. |
| `compression(labels)` | no | One bounded compression or decompression outcome. |
| `observeGet(labels, seconds)` | yes | Cache-read duration in seconds. |
| `observeFallback(labels, seconds)` | yes | Fallback duration in seconds. |
| `observeSerialization(labels, seconds)` | yes | Serializer dump/load duration in seconds. |
| `observeSize(labels, bytes)` | yes | Serialized remote payload size in bytes, before compression. |
| `observeStoredSize(labels, bytes)` | no | Prepared remote payload size in bytes, after compression and escaping; emitted before client dispatch. |
| `observeCompressionRatio(labels, ratio)` | no | Compressed-to-original size ratio when compression selects the prepared representation. |
| `observeCompression(labels, seconds)` | no | Compression or decompression duration with `operation="compress"` or `operation="decompress"`. |

The root package exports `DialCacheMetricsAdapter` and every associated label,
reason, error-kind, layer, scope, and shadow-outcome type, including
`ShadowValidationMetricLabels`, `ShadowValidationOutcome`,
`CompressionMetricLabels`, `CompressionOperationMetricLabels`, and
`CompressionOutcome`, `CacheMissReason`, `MissMetricLabels`,
`StaleRecoveryMetricLabels`, and `StaleRecoveryOutcome`.
`shadowValidation` remains optional so existing custom adapters keep
compiling, but DialCache does not admit shadow work when the configured
adapter omits it. The Prometheus and Datadog adapters implement the hook.

The compression hooks are also optional for source compatibility with existing
custom adapters. They control observation only: omitting them does not disable
compression or decompression. The Prometheus and Datadog adapters implement
all four hooks.

Metrics and logger methods are typed `void` and invoked as fire-and-forget
observers. DialCache also defensively consumes, but never awaits, a thenable
returned at runtime.

Synchronous throws and rejections of those returned thenables are isolated so
telemetry cannot change cache correctness, fallback results, or shadow outcomes.
This guard applies when DialCache invokes the observer, not to direct calls to an
adapter or to asynchronous work whose promise the hook does not return.

A custom adapter may buffer or transmit asynchronously, but it owns delivery,
flushing, resources, and shutdown after the call returns. Keep
application-owned namespace, use-case, and key-type labels stable and
low-cardinality, and preserve the seconds and bytes units shown above.

Every backend-neutral label object exposes the logical namespace as camel-case
`cacheNamespace`. Map it to the backend's `cache_namespace` label or tag. This
field is present even when no key or cache layer was reached.

Omit `metrics` to disable metrics entirely. Because shadow jobs require an
observable terminal outcome, omitting metrics also disables shadow execution
even when a key policy sets `shadow.ramp` or enables
`shadow.logMismatches`.

See [Metric migrations](upgrading.md#metric-migrations) when upgrading collectors,
miss queries, or exhaustive outcome mappings.
