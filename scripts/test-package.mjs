import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = await mkdtemp(join(tmpdir(), "dialcache-package-"));
const fallbackTimeoutMarker = "dialcache-fallback-timeout-delivered";
const nodeInvalidationMarker = "dialcache-node-invalidation-retry-verified";
const observerIsolationMarker = "dialcache-observer-rejections-isolated";
const shadowPayloadReleaseMarker = "dialcache-shadow-payload-released";
// Run the actual first TypeScript block from each onboarding page, without a
// separately maintained copy that could keep passing after the docs break.
const documentationExamples = [
  {
    source: "README.md",
    filename: "readme-example.mts",
    stdout: "Loading from source: 123\nLoading from source: 456\nLoading from source: 123\n",
  },
  {
    source: "docs/getting-started.md",
    filename: "getting-started-example.mts",
    stdout: "1\n2\n",
  },
];
const packedInvalidationCheckSource = String.raw`
function createPackedNodeRedisInvalidationAdapter(nodeRedis, dispatch, label) {
  const client = {
    get: async () => null,
    sendCommand: async (...callArgs) => {
      if (
        callArgs.length !== 2
        || !Array.isArray(callArgs[0])
        || callArgs[1]?.returnBuffers !== true
      ) {
        throw new Error("The packed " + label + " adapter used the wrong standalone command shape");
      }
      return await dispatch(callArgs[0]);
    },
  };
  return nodeRedis.createNodeRedisDialCacheClient(client);
}

function createPackedGlideInvalidationAdapter(glide, appGlide, dispatch) {
  const client = {
    customCommand: async (args) => await dispatch(args),
  };
  const runtime = {
    ...appGlide,
    GlideClient: { [Symbol.hasInstance]: (value) => value === client },
    GlideClusterClient: { [Symbol.hasInstance]: () => false },
  };
  return glide.createValkeyGlideDialCacheClient(client, runtime);
}

async function verifyPackedInvalidation({ createAdapter, label, redisProtocol }) {
  const dispatches = [];
  const dispatch = async (args) => {
    dispatches.push(args);
    if (dispatches.length === 1) {
      throw new Error("packed invalidation EVALSHA rejected");
    }
    return 1;
  };
  const invalidatedAtMs = 1700000000456;
  const nativeDateNow = Date.now;
  Date.now = () => invalidatedAtMs;
  try {
    await createAdapter(dispatch).invalidate({
      watermarkKey: "tracked:{id}:watermark",
      futureBufferMs: 50,
    });
  } finally {
    Date.now = nativeDateNow;
  }

  const script = redisProtocol.INVALIDATE_CACHE_SCRIPT;
  const sha = createHash("sha1").update(script).digest("hex");
  const args = ["1", "tracked:{id}:watermark", "50", String(invalidatedAtMs)];
  const expected = [
    ["EVALSHA", sha, ...args],
    ["EVAL", script, ...args],
  ];
  const commandsMatch = dispatches.length === expected.length
    && dispatches.every((command, index) =>
      command.length === expected[index].length
      && command.every((part, partIndex) => part === expected[index][partIndex]));
  if (!commandsMatch) {
    throw new Error("The packed " + label + " invalidation script or argument contract is invalid");
  }
}
`;
const packedStaleRecoveryCheckSource = String.raw`
async function verifyPackedStaleRecovery(root, label) {
  let readCalls = 0;
  const sourceError = new Error("packed source unavailable");
  const cache = new root.DialCache({
    shouldAttemptStaleRecovery: (error) => error === sourceError,
    redis: {
      client: {
        read: async () => {
          readCalls += 1;
          return {
            payload: JSON.stringify({ source: "cached" }),
            createdAtMs: Date.now() - 2_000,
          };
        },
        write: async () => undefined,
        invalidate: async () => undefined,
      },
    },
  });
  const load = cache.cached(async () => {
    throw sourceError;
  }, {
    keyType: "id",
    useCase: "PackedStaleRecovery",
    cacheKey: () => "123",
    defaultConfig: new root.DialCacheKeyConfig({
      ttlSec: { [root.CacheLayer.REMOTE]: 1 },
      ramp: { [root.CacheLayer.REMOTE]: 100 },
      staleOnErrorMaxAgeSec: 60,
    }),
  });
  const value = await cache.enable(() => load());
  if (readCalls !== 1 || value.source !== "cached") {
    throw new Error("The packed " + label + " stale recovery did not retain one Redis snapshot");
  }
}
`;
const rootConsumer = `import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  DialCacheRedisProtocolError,
  FallbackTimeoutError,
  JsonSerializer,
  RedisReadTimeoutError,
  isRedisReadMiss,
  type CacheMissReason,
  type CacheMetricLabels,
  type CacheConfigProvider,
  type CachedOptions,
  type CoalescedMetricLabels,
  type CoalescingScope,
  type CoalescingState,
  type CompressionConfig,
  type CompressionMetricLabels,
  type CompressionOperationMetricLabels,
  type CompressionOutcome,
  type DialCacheConfig,
  type DialCacheKeyInit,
  type DialCacheMetricsAdapter,
  type DialCacheRedisClient,
  type DisabledReason,
  type GetOrLoadOptions,
  type InvalidationMetricLabels,
  type MetricErrorKind,
  type MetricLayer,
  type MissMetricLabels,
  type ProcessCoalescingState,
  type RedisConfig,
  type RedisInvalidationRequest,
  type RedisReadContext,
  type RedisReadMiss,
  type RedisReadResult,
  type RedisWriteRequest,
  type Serializer,
  type ShadowComparator,
  type ShadowConfig,
  type ShadowValidationMetricLabels,
  type ShadowValidationOutcome,
  type StaleRecoveryMetricLabels,
  type StaleRecoveryOutcome,
  type StaleRecoveryPredicate,
} from "dialcache";
// @ts-expect-error The unused MissingKeyConfigError class was removed instead of deprecated.
import { MissingKeyConfigError } from "dialcache";
// @ts-expect-error Placeholder promotion was removed from the Redis adapter protocol.
import { DialCacheRedisPlaceholderLostError } from "dialcache";
// @ts-expect-error RedisWatermarkMiss folded into RedisReadMiss and its optional observedWatermarkMs fence.
import type { RedisWatermarkMiss } from "dialcache";
import { createNodeRedisDialCacheClient } from "dialcache/node-redis";
// @ts-expect-error The node-redis adapter no longer requires public script registrations.
import { dialcacheRedisScripts } from "dialcache/node-redis";
// @ts-expect-error The node-redis script-registration type was removed with the facade.
import type { DialCacheNodeRedisScripts } from "dialcache/node-redis";
import {
  ceilSupportedCacheTtlMs,
  decodeRedisReadResult,
  decodeTrackedRedisReadResult,
  encodeRedisFrame,
  isRedisReadMiss as isRedisProtocolReadMiss,
  validateRedisScriptInvalidationReply,
  validateRedisSetReply,
  type CacheMissReason as ProtocolCacheMissReason,
  type DecodedRedisFrame,
  type RedisReadMiss as RedisProtocolReadMiss,
  type RedisReadResult as RedisProtocolReadResult,
} from "dialcache/redis-protocol";
// @ts-expect-error The frame-or-null decoder was replaced by the classified decodeRedisReadResult.
import { decodeRedisFrame } from "dialcache/redis-protocol";
// @ts-expect-error The tracked frame-or-null decoder was replaced by decodeTrackedRedisReadResult.
import { decodeTrackedRedisFrame } from "dialcache/redis-protocol";
// @ts-expect-error Placeholder promotion was removed from the Redis adapter protocol.
import { encodeTrackedRedisPlaceholder } from "dialcache/redis-protocol";
// @ts-expect-error Tracked writes no longer have a script reply to resolve.
import { resolveTrackedRedisWriteReply } from "dialcache/redis-protocol";
// @ts-expect-error Tracked writes are native SET commands and no longer use Lua.
import { WRITE_TRACKED_STAMP_SCRIPT } from "dialcache/redis-protocol";
// @ts-expect-error The codec functions replaced the frame-version wire constant.
import { REDIS_FRAME_VERSION } from "dialcache/redis-protocol";
// @ts-expect-error The codec functions replaced the UTF-8 encoding wire constant.
import { REDIS_ENCODING_UTF8 } from "dialcache/redis-protocol";
// @ts-expect-error The codec functions replaced the binary encoding wire constant.
import { REDIS_ENCODING_BINARY } from "dialcache/redis-protocol";
// @ts-expect-error Read Lua sources were removed from the mutation-only Redis protocol.
import { READ_CACHE_SCRIPT } from "dialcache/redis-protocol";
// @ts-expect-error Tracked read Lua was removed from the mutation-only Redis protocol.
import { READ_TRACKED_CACHE_SCRIPT } from "dialcache/redis-protocol";
// @ts-expect-error The untracked write Lua was replaced by a native client-framed SET.
import { WRITE_CACHE_SCRIPT } from "dialcache/redis-protocol";
// @ts-expect-error The tracked write Lua was replaced by a native client-framed SET.
import { WRITE_TRACKED_CACHE_SCRIPT } from "dialcache/redis-protocol";
import {
  DatadogDialCacheMetrics,
  createDatadogDialCacheMetrics,
  type DatadogDogStatsDClient,
  type DatadogMetricsOptions,
  type DatadogObservationMetricType,
} from "dialcache/datadog";

const optionsFor = (useCase: string) => ({
  keyType: "id",
  useCase,
  cacheKey: (id: string) => id,
});
const inlineOptionsFor = (useCase: string, key = "1") => ({
  keyType: "id",
  useCase,
  key,
});
const metrics: DialCacheMetricsAdapter = {
  request: () => undefined,
  miss: (labels: MissMetricLabels) => {
    const reason: CacheMissReason = labels.reason;
    void reason;
  },
  disabled: () => undefined,
  error: () => undefined,
  invalidation: () => undefined,
  observeGet: () => undefined,
  observeFallback: () => undefined,
  observeSerialization: () => undefined,
  observeSize: () => undefined,
};
const shadowMetrics: DialCacheMetricsAdapter = {
  ...metrics,
  observeFutureTimestampOffset: (labels: CacheMetricLabels, seconds: number) => {
    const cacheNamespace: string = labels.cacheNamespace;
    const offsetSeconds: number = seconds;
    void cacheNamespace;
    void offsetSeconds;
  },
  shadowValidation: (labels: ShadowValidationMetricLabels) => {
    const outcome: ShadowValidationOutcome = labels.outcome;
    void outcome;
  },
};
const staleMetrics: DialCacheMetricsAdapter = {
  ...metrics,
  staleRecovery: (labels: StaleRecoveryMetricLabels) => {
    const outcome: StaleRecoveryOutcome = labels.outcome;
    void outcome;
  },
  observeStaleRecoveryValueAge: (labels: StaleRecoveryMetricLabels, seconds: number) => {
    const outcome: StaleRecoveryOutcome = labels.outcome;
    const ageSeconds: number = seconds;
    void outcome;
    void ageSeconds;
  },
};
const shadowOutcomes: Readonly<Record<ShadowValidationOutcome, true>> = {
  match: true,
  mismatch: true,
  superseded: true,
  filled: true,
  fill_fenced: true,
  fill_error: true,
  redis_error: true,
  source_error: true,
  deserialization_error: true,
  comparison_error: true,
  confirmation_error: true,
  timeout: true,
  dropped: true,
};
void shadowOutcomes;
const staleRecoveryOutcomes: Readonly<Record<StaleRecoveryOutcome, true>> = {
  served: true,
  miss: true,
  deserialization_error: true,
};
const staleRecoveryLabels: StaleRecoveryMetricLabels = {
  cacheNamespace: "consumer-cache",
  useCase: "Load",
  keyType: "id",
  outcome: "served",
};
void staleRecoveryOutcomes;
void staleRecoveryLabels;
const metricLayers: Readonly<Record<MetricLayer, true>> = {
  [CacheLayer.LOCAL]: true,
  [CacheLayer.REMOTE]: true,
  remote_shadow: true,
  request_local: true,
  noop: true,
};
void metricLayers;
const shadowCacheConfig: DialCacheConfig = {
  namespace: "consumer-shadow-cache",
  metrics: shadowMetrics,
  shadowMaxInFlight: 2,
};
const shadowCache = new DialCache(shadowCacheConfig);
const staleRecoveryPredicate: StaleRecoveryPredicate = (error) => error instanceof Error;
const invalidAsyncStaleRecoveryConfig: DialCacheConfig = {
  // @ts-expect-error Stale-recovery predicates must return a boolean synchronously.
  shouldAttemptStaleRecovery: async () => true,
};
const staleCacheConfig: DialCacheConfig = {
  namespace: "consumer-stale-cache",
  metrics: staleMetrics,
  shouldAttemptStaleRecovery: staleRecoveryPredicate,
};
const staleCache = new DialCache(staleCacheConfig);
const shadowConfig: ShadowConfig = {
  ramp: 50,
  logMismatches: true,
};
const shadowKeyConfig = new DialCacheKeyConfig({ shadow: shadowConfig });
const staleKeyConfig = new DialCacheKeyConfig({
  ttlSec: { [CacheLayer.REMOTE]: 60 },
  staleOnErrorMaxAgeSec: 300,
});
const staleRecoveryMaxAgeSec: number | undefined = staleKeyConfig.staleOnErrorMaxAgeSec;
const dogStatsDClient: DatadogDogStatsDClient = {
  increment: () => undefined,
  histogram: () => undefined,
  distribution: () => undefined,
};
const datadogObservationMetricType: DatadogObservationMetricType = "distribution";
const datadogOptions: DatadogMetricsOptions = {
  client: dogStatsDClient,
  observationMetricType: datadogObservationMetricType,
};
const datadogMetrics = createDatadogDialCacheMetrics(datadogOptions);
const datadogClassAdapter = new DatadogDialCacheMetrics(datadogOptions);
// @ts-expect-error The observation type is an explicit, required choice.
const missingObservationType: DatadogMetricsOptions = { client: dogStatsDClient };
const cache = new DialCache({ namespace: "consumer-cache", metrics });
const redisProtocolError = new DialCacheRedisProtocolError("Invalid DialCache Redis write reply");
const emptyRedisFrame = Buffer.alloc(10);
emptyRedisFrame[0] = 1;
emptyRedisFrame.writeBigUInt64BE(1n, 1);
const decodedEmptyRedisFrame: RedisReadResult = decodeRedisReadResult(emptyRedisFrame);
const decodedRedisReadResult: RedisReadResult = decodeRedisReadResult(null);
const absentReadMiss: RedisReadMiss = { kind: "miss", reason: "value_absent" };
const fencedReadMiss: RedisReadMiss = { kind: "miss", reason: "watermark_fenced", observedWatermarkMs: 1 };
void absentReadMiss;
void fencedReadMiss;
// @ts-expect-error A miss is only recognized behind the "miss" discriminant.
const missWithoutDiscriminant: RedisReadResult = { reason: "value_absent", observedWatermarkMs: 1 };
void missWithoutDiscriminant;
// @ts-expect-error null is no longer a legal Redis read result; misses are classified objects.
const nullRedisReadResult: RedisReadResult = null;
void nullRedisReadResult;
if ("kind" in decodedRedisReadResult) {
  const narrowedMiss: RedisReadMiss = decodedRedisReadResult;
  const reason: CacheMissReason = narrowedMiss.reason;
  const observedWatermarkMs: number | undefined = narrowedMiss.observedWatermarkMs;
  const protocolMiss: RedisProtocolReadMiss = narrowedMiss;
  void reason;
  void observedWatermarkMs;
  void protocolMiss;
}
if (isRedisReadMiss(decodedRedisReadResult)) {
  const rootGuardedMiss: RedisReadMiss = decodedRedisReadResult;
  void rootGuardedMiss;
} else {
  const rootGuardedFrame: DecodedRedisFrame = decodedRedisReadResult;
  void rootGuardedFrame;
}
const decodedTrackedRedisReadResult: RedisReadResult = decodeTrackedRedisReadResult(
  emptyRedisFrame,
  Buffer.from("1"),
);
if (isRedisProtocolReadMiss(decodedTrackedRedisReadResult)) {
  const protocolGuardedMiss: RedisReadMiss = decodedTrackedRedisReadResult;
  const observedWatermarkMs: number | undefined = protocolGuardedMiss.observedWatermarkMs;
  void observedWatermarkMs;
} else {
  const protocolGuardedFrame: DecodedRedisFrame = decodedTrackedRedisReadResult;
  void protocolGuardedFrame;
}
const protocolGuardMatchesRoot: typeof isRedisReadMiss = isRedisProtocolReadMiss;
const rootGuardMatchesProtocol: typeof isRedisProtocolReadMiss = isRedisReadMiss;
const protocolReadResult: RedisProtocolReadResult = decodedTrackedRedisReadResult;
void protocolGuardMatchesRoot;
void rootGuardMatchesProtocol;
void protocolReadResult;
const zeroTimestampRedisFrame: Buffer = encodeRedisFrame("pending", 0);
const setReplyValidation: void = validateRedisSetReply("OK");
const invalidationReplyValidation: 1 = validateRedisScriptInvalidationReply(1);
const ceiledCacheTtlMs: number = ceilSupportedCacheTtlMs(1_000.5);
const fallbackTimeoutError = new FallbackTimeoutError("Load", 1_000);
const redisReadTimeoutError = new RedisReadTimeoutError("Load", 100);
const coalescingState: CoalescingState = cache.getCoalescingState();
const processCoalescingState: ProcessCoalescingState = coalescingState.process;
const disabledOverlay: DialCacheKeyConfig = DialCacheKeyConfig.disabled();
const stringShadowComparator: ShadowComparator<string> = (cachedValue, sourceValue) =>
  cachedValue === sourceValue;
const load = cache.cached(async (id: string) => id, {
  keyType: "id",
  useCase: "Load",
  cacheKey: (id) => id,
  fallbackTimeoutMs: 1_000,
  shadowComparator: stringShadowComparator,
  shouldAttemptStaleRecovery: staleRecoveryPredicate,
  defaultConfig: new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.LOCAL]: 60, [CacheLayer.REMOTE]: 60 },
    ramp: { [CacheLayer.LOCAL]: 100, [CacheLayer.REMOTE]: 100 },
    remoteReadTimeoutMs: 100,
  }),
});
const loadWithoutFallbackDeadline = cache.cached(async (id: string) => id, {
  keyType: "id",
  useCase: "LoadWithoutFallbackDeadline",
  cacheKey: (id) => id,
  fallbackTimeoutMs: null,
});
const inlineSync: Promise<{ readonly id: string }> = cache.getOrLoad(
  () => ({ id: "sync" as const }),
  inlineOptionsFor("InlineSync"),
);
const inlineAsync: Promise<{ readonly id: string }> = cache.getOrLoad(
  async () => ({ id: "async" as const }),
  {
    ...inlineOptionsFor("InlineAsync"),
    shadowComparator: (cachedValue, sourceValue) => cachedValue.id === sourceValue.id,
    shouldAttemptStaleRecovery: staleRecoveryPredicate,
  },
);

interface JsonCompatibleRecord {
  readonly id: string;
  readonly nested: { readonly enabled: boolean; readonly scores: readonly number[] };
  readonly nickname?: string;
}

const loadJsonRecord = cache.cached(
  async (id: string): Promise<JsonCompatibleRecord> => ({ id, nested: { enabled: true, scores: [1, 2] } }),
  optionsFor("JsonCompatibleRecord"),
);
const loadEmptyObject = cache.cached(async (_id: string) => ({}), optionsFor("EmptyObject"));
const loadUndefined = cache.cached(async (_id: string) => undefined, optionsFor("TopLevelUndefined"));
const loadVoid = cache.cached(async (_id: string): Promise<void> => undefined, optionsFor("TopLevelVoid"));

const dateSerializer: Serializer<Date> = {
  dump: (value) => value.toISOString(),
  load: (value) => new Date(Buffer.isBuffer(value) ? value.toString("utf8") : value),
};
const loadDate = cache.cached(async (_id: string) => new Date(0), {
  ...optionsFor("DateWithSerializer"),
  serializer: dateSerializer,
});
const loadDateWithTrustedJsonAssertion = cache.cached(async (_id: string) => new Date(0), {
  ...optionsFor("DateWithTrustedJsonAssertion"),
  serializer: new JsonSerializer<Date>(),
});
type DateLoader = (id: string) => Promise<Date>;
const dateOptions: CachedOptions<DateLoader> = {
  ...optionsFor("TypedDateOptions"),
  serializer: dateSerializer,
};
const inlineDateOptions: GetOrLoadOptions<Date> = {
  ...inlineOptionsFor("InlineDateWithSerializer"),
  serializer: dateSerializer,
};
const inlineDate: Promise<Date> = cache.getOrLoad(async () => new Date(0), inlineDateOptions);

class MethodBearingValue {
  constructor(readonly id: string) {}
  label(): string {
    return this.id;
  }
}

// @ts-expect-error Date needs an explicit serializer.
cache.cached(async (_id: string) => new Date(0), optionsFor("DateWithoutSerializer"));
// @ts-expect-error Map needs an explicit serializer.
cache.cached(async (_id: string) => new Map<string, string>(), optionsFor("MapWithoutSerializer"));
// @ts-expect-error Set needs an explicit serializer.
cache.cached(async (_id: string) => new Set<string>(), optionsFor("SetWithoutSerializer"));
// @ts-expect-error bigint needs an explicit serializer.
cache.cached(async (_id: string) => 1n, optionsFor("BigIntWithoutSerializer"));
// @ts-expect-error Functions need an explicit serializer.
cache.cached(async (_id: string) => (value: string) => value, optionsFor("FunctionWithoutSerializer"));
// @ts-expect-error Symbols need an explicit serializer.
cache.cached(async (_id: string) => Symbol("value"), optionsFor("SymbolWithoutSerializer"));
// @ts-expect-error Required nested undefined is not preserved by JSON.
cache.cached(async (_id: string): Promise<{ value: string | undefined }> => ({ value: undefined }), optionsFor("NestedUndefinedWithoutSerializer"));
// @ts-expect-error unknown cannot establish JSON compatibility.
cache.cached(async (_id: string): Promise<unknown> => ({ id: "unknown" }), optionsFor("UnknownWithoutSerializer"));
// @ts-expect-error any cannot establish JSON compatibility.
cache.cached(async (_id: string): Promise<any> => ({ id: "any" }), optionsFor("AnyWithoutSerializer"));
// @ts-expect-error Buffer needs an explicit serializer.
cache.cached(async (_id: string) => Buffer.from("value"), optionsFor("BufferWithoutSerializer"));
// @ts-expect-error Typed arrays need an explicit serializer.
cache.cached(async (_id: string) => new Uint8Array([1, 2]), optionsFor("TypedArrayWithoutSerializer"));
// @ts-expect-error Method-bearing class instances need an explicit serializer.
cache.cached(async (id: string) => new MethodBearingValue(id), optionsFor("ClassWithoutSerializer"));
// @ts-expect-error CachedOptions itself requires a serializer for Date values.
const missingDateSerializer: CachedOptions<DateLoader> = optionsFor("TypedDateOptionsWithoutSerializer");
// @ts-expect-error getOrLoad requires an explicit serializer for an inferred Date value.
cache.getOrLoad(async () => new Date(0), inlineOptionsFor("InlineDateWithoutSerializer"));
// @ts-expect-error GetOrLoadOptions itself requires a serializer for Date values.
const missingInlineDateSerializer: GetOrLoadOptions<Date> = inlineOptionsFor("TypedInlineDateWithoutSerializer");
cache.cached(async (id: string) => id, {
  ...optionsFor("InvalidShadowComparatorValueType"),
  // @ts-expect-error Shadow comparators receive the cached function's resolved value type.
  shadowComparator: (cachedValue: number, sourceValue: number) => cachedValue === sourceValue,
});
cache.cached(async (id: string) => id, {
  ...optionsFor("InvalidAsyncShadowComparator"),
  // @ts-expect-error Shadow comparators must return a boolean synchronously.
  shadowComparator: async (cachedValue, sourceValue) => cachedValue === sourceValue,
});

const requestLocalConfig = new DialCacheKeyConfig({ requestLocal: true });
const uncoalescedConfig = new DialCacheKeyConfig({ coalesce: false });
const coalesceFlag: boolean | undefined = uncoalescedConfig.coalesce;
const structuralConfigProvider: CacheConfigProvider = () => ({
  ttlSec: { [CacheLayer.LOCAL]: 60 },
  ramp: { [CacheLayer.LOCAL]: 100 },
});
const requestLocalCoalescingLabels: CoalescedMetricLabels = {
  cacheNamespace: "consumer-cache",
  useCase: "Load",
  keyType: "id",
  scope: "request_local",
};
const cacheMetricLabels: CacheMetricLabels = {
  cacheNamespace: "consumer-cache",
  useCase: "Load",
  keyType: "id",
  layer: CacheLayer.LOCAL,
};
const missMetricLabels: MissMetricLabels = {
  ...cacheMetricLabels,
  reason: "value_absent",
};
const missReasons: Readonly<Record<CacheMissReason, true>> = {
  value_absent: true,
  expired: true,
  watermark_fenced: true,
  unclassified: true,
};
const protocolMissReason: ProtocolCacheMissReason = missMetricLabels.reason;
const rootMissReasonFromProtocol: CacheMissReason = protocolMissReason;
// @ts-expect-error Miss reasons are a bounded public taxonomy.
const unboundedMissReason: CacheMissReason = "evicted";
// @ts-expect-error The reason is required only for the miss callback's labels.
const missingMissReason: MissMetricLabels = cacheMetricLabels;
const cacheMetricLabelsWithMissReason: CacheMetricLabels = {
  ...cacheMetricLabels,
  // @ts-expect-error CacheMetricLabels intentionally remains shared by non-miss callbacks.
  reason: "value_absent",
};
const invalidationMetricLabels: InvalidationMetricLabels = {
  cacheNamespace: "consumer-cache",
  keyType: "id",
  layer: CacheLayer.REMOTE,
};
const keyInit: DialCacheKeyInit = {
  namespace: "consumer-cache",
  keyType: "id",
  id: "123",
  useCase: "Load",
};
const keyInitHasNoUrnPrefix: "urnPrefix" extends keyof DialCacheKeyInit ? false : true = true;
// @ts-expect-error DialCacheKeyInit.urnPrefix was renamed to namespace.
const legacyKeyInit: DialCacheKeyInit = { keyType: "id", id: "123", useCase: "Load", urnPrefix: "consumer-cache" };
const namespacedKey = new DialCacheKey(keyInit);
const requestLocalCoalescingScope: CoalescingScope = "request_local";
const boundedErrorKind: MetricErrorKind = "cache_read_timeout";
const disabledReasons: Readonly<Record<DisabledReason, true>> = {
  context: true,
  policy_disabled: true,
  invalid_ttl: true,
  invalid_ramp: true,
  ramped_down: true,
  config_error: true,
};
// @ts-expect-error Missing configuration now means the documented disabled policy, not a separate reason.
const legacyMissingConfigReason: DisabledReason = "missing_config";
const metricErrorKinds: Readonly<Record<MetricErrorKind, true>> = {
  key_construction: true,
  config_resolution: true,
  cache_read: true,
  cache_read_timeout: true,
  cache_write: true,
  tracked_ttl_clamped: true,
  serialization_load: true,
  serialization_dump: true,
  compression: true,
  invalidation: true,
  fallback: true,
  unknown: true,
};
// @ts-expect-error Arbitrary exception names are not DialCache metric error categories.
const unboundedErrorKind: MetricErrorKind = "Tenant123Error";
const compressionConfig: CompressionConfig = { thresholdBytes: 4096, level: 3 };
const compressionMetricLabels: CompressionMetricLabels = {
  cacheNamespace: "consumer-cache",
  useCase: "Load",
  keyType: "id",
  layer: CacheLayer.REMOTE,
  outcome: "compressed",
};
const compressionOutcomes: Readonly<Record<CompressionOutcome, true>> = {
  compressed: true,
  below_threshold: true,
  not_smaller: true,
  write_over_limit: true,
  decompressed: true,
  fallback_raw: true,
  read_over_limit: true,
};
const compressionOperationMetricLabels: CompressionOperationMetricLabels = {
  cacheNamespace: "consumer-cache",
  useCase: "Load",
  keyType: "id",
  layer: CacheLayer.REMOTE,
  operation: "compress",
};
// @ts-expect-error Compression outcomes are a bounded metric category.
const unboundedCompressionOutcome: CompressionOutcome = "inflated";

const customRedisClient: DialCacheRedisClient = {
  // The optional second argument may be omitted; hits are frames and misses are classified objects.
  read: async (): Promise<RedisReadResult> => ({
    payload: Buffer.from([0, 255]),
    createdAtMs: 1,
  }),
  write: async ({ value }) => {
    void (typeof value === "string" || Buffer.isBuffer(value));
  },
  invalidate: async () => undefined,
};
const legacyNullMissRedisClient: DialCacheRedisClient = {
  ...customRedisClient,
  // @ts-expect-error Legacy frame-or-null reads must return a classified RedisReadMiss instead of null.
  read: async (): Promise<DecodedRedisFrame | null> => null,
};
void legacyNullMissRedisClient;
const redisClientMethods: Readonly<Record<keyof DialCacheRedisClient, true>> = {
  read: true,
  write: true,
  invalidate: true,
};
void redisClientMethods;
const redisConfigAcceptsCompressionOptOut: RedisConfig = {
  client: customRedisClient,
  compression: false,
};
const cacheHasNoFlushAll: "flushAll" extends keyof DialCache ? false : true = true;
const cacheHasNoClose: "close" extends keyof DialCache ? false : true = true;
const clientHasNoFlushAll: "flushAll" extends keyof DialCacheRedisClient ? false : true = true;
const writeHasNoWatermark: "watermarkKey" extends keyof RedisWriteRequest ? false : true = true;
const trackedWriteHasNoWatermarkTtlFloor: "watermarkTtlFloorMs" extends keyof RedisWriteRequest
  ? false
  : true = true;
const writeAcceptsOptionalCreatedAt: {} extends Pick<RedisWriteRequest, "createdAtMs">
  ? true
  : false = true;
const invalidationHasNoWatermarkTtlFloor: "watermarkTtlFloorMs" extends keyof RedisInvalidationRequest
  ? false
  : true = true;
const invalidationHasNoInvalidatedAt: "invalidatedAtMs" extends keyof RedisInvalidationRequest
  ? false
  : true = true;
const legacyTrackedWriteRequest: RedisWriteRequest = {
  valueKey: "tracked:{id}:value",
  // @ts-expect-error Writes no longer inspect or mutate invalidation watermarks.
  watermarkKey: "tracked:{id}:watermark",
  cacheTtlMs: 1_000,
  value: "tracked",
};
const timestampedWriteRequest: RedisWriteRequest = {
  valueKey: "tracked:{id}:value",
  cacheTtlMs: 1_000,
  value: "tracked",
  createdAtMs: 1,
};
const omittedTimestampWriteRequest: RedisWriteRequest = {
  valueKey: "legacy:{id}:value",
  cacheTtlMs: 1_000,
  value: "legacy",
};
const legacyInvalidationRequest: RedisInvalidationRequest = {
  watermarkKey: "tracked:{id}:watermark",
  futureBufferMs: 0,
  // @ts-expect-error Watermark lifetime is derived by the Redis invalidation protocol.
  watermarkTtlFloorMs: 1_000,
};
const configHasNoMetricsRegistry: "metricsRegistry" extends keyof DialCacheConfig ? false : true = true;
const configHasNoMetricsPrefix: "metricsPrefix" extends keyof DialCacheConfig ? false : true = true;
const configRejectsFalseMetrics: false extends NonNullable<DialCacheConfig["metrics"]> ? false : true = true;
const configHasNamespace: "namespace" extends keyof DialCacheConfig ? true : false = true;
const configHasNoUrnPrefix: "urnPrefix" extends keyof DialCacheConfig ? false : true = true;
// @ts-expect-error urnPrefix was renamed to namespace.
const legacyNamespaceConfig: DialCacheConfig = { urnPrefix: "consumer-cache" };
const configHasNoRampSampler: "rampSampler" extends keyof DialCacheConfig ? false : true = true;
// @ts-expect-error Ramp assignment is owned internally by DialCache.
const legacyRampSamplerConfig: DialCacheConfig = { rampSampler: () => 0 };
const redisConfigHasNoKeyPrefix: "keyPrefix" extends keyof RedisConfig ? false : true = true;
// @ts-expect-error keyPrefix was removed in favor of DialCacheConfig.namespace.
const legacyKeyPrefixConfig: RedisConfig = { client: customRedisClient, readTimeoutMs: 100, keyPrefix: "legacy:" };
const redisConfigRequiresClient: {} extends Pick<RedisConfig, "client"> ? false : true = true;
const redisConfigAllowsDefaultReadTimeout: {} extends Pick<RedisConfig, "readTimeoutMs"> ? true : false = true;
const redisConfigHasNoCreateClient: "createClient" extends keyof RedisConfig ? false : true = true;
const redisConfigHasNoWatermarkTtlSec: "watermarkTtlSec" extends keyof RedisConfig ? false : true = true;
// @ts-expect-error Redis requires a caller-owned client.
const missingRedisClientConfig: RedisConfig = {};
const defaultRedisReadTimeoutConfig: RedisConfig = { client: customRedisClient };
// @ts-expect-error createClient was removed; construct and pass RedisConfig.client instead.
const legacyRedisFactoryConfig: RedisConfig = { createClient: () => customRedisClient };
// @ts-expect-error Watermark lifetime is derived internally by DialCache.
const legacyWatermarkTtlConfig: RedisConfig = { client: customRedisClient, watermarkTtlSec: 60 };
const redisReadContext: RedisReadContext = {
  timeoutMs: 100,
  signal: new AbortController().signal,
};
// @ts-expect-error RedisClientFactory was removed with RedisConfig.createClient.
type LegacyRedisClientFactory = import("dialcache").RedisClientFactory;
// @ts-expect-error CacheRampSampler was removed with the public sampler override.
type LegacyCacheRampSampler = import("dialcache").CacheRampSampler;
// @ts-expect-error CacheRampSample was removed with the public sampler override.
type LegacyCacheRampSample = import("dialcache").CacheRampSample;
type DialCacheRoot = typeof import("dialcache");
const rootHasNoDefaultWatermarkTtlSec: "DEFAULT_WATERMARK_TTL_SEC" extends keyof DialCacheRoot ? false : true = true;
const rootHasNoPrometheusFactory: "createPrometheusDialCacheMetrics" extends keyof DialCacheRoot ? false : true = true;
const rootHasNoDatadogFactory: "createDatadogDialCacheMetrics" extends keyof DialCacheRoot ? false : true = true;
const rootHasNoDeterministicRampSampler: "deterministicRampSampler" extends keyof DialCacheRoot ? false : true = true;
const rootHasNoRandomRampSampler: "randomRampSampler" extends keyof DialCacheRoot ? false : true = true;

void load;
void loadWithoutFallbackDeadline;
void inlineSync;
void inlineAsync;
void loadJsonRecord;
void loadEmptyObject;
void loadUndefined;
void loadVoid;
void loadDate;
void loadDateWithTrustedJsonAssertion;
void dateOptions;
void inlineDateOptions;
void inlineDate;
void missingDateSerializer;
void missingInlineDateSerializer;
void requestLocalConfig;
void uncoalescedConfig;
void coalesceFlag;
void structuralConfigProvider;
void shadowCache;
void shadowKeyConfig;
void staleMetrics;
void staleCache;
void staleCacheConfig;
void staleRecoveryPredicate;
void staleKeyConfig;
void staleRecoveryMaxAgeSec;
void requestLocalCoalescingLabels;
void cacheMetricLabels;
void missMetricLabels;
void missReasons;
void rootMissReasonFromProtocol;
void unboundedMissReason;
void missingMissReason;
void cacheMetricLabelsWithMissReason;
void invalidationMetricLabels;
void keyInitHasNoUrnPrefix;
void legacyKeyInit;
void namespacedKey.namespace;
void redisProtocolError.name;
void fallbackTimeoutError.timeoutMs;
void redisReadTimeoutError.timeoutMs;
void coalescingState.process;
void processCoalescingState.activeLeaders;
void requestLocalCoalescingScope;
void boundedErrorKind;
void disabledReasons;
void legacyMissingConfigReason;
void MissingKeyConfigError;
void disabledOverlay;
void metricErrorKinds;
void unboundedErrorKind;
void compressionConfig;
void compressionMetricLabels;
void compressionOperationMetricLabels;
void compressionOutcomes;
void unboundedCompressionOutcome;
void redisConfigAcceptsCompressionOptOut;
void createNodeRedisDialCacheClient;
void decodedEmptyRedisFrame;
void decodeRedisFrame;
void decodeTrackedRedisFrame;
void (undefined as unknown as RedisWatermarkMiss);
void dialcacheRedisScripts;
void (undefined as unknown as DialCacheNodeRedisScripts);
void READ_CACHE_SCRIPT;
void READ_TRACKED_CACHE_SCRIPT;
void WRITE_CACHE_SCRIPT;
void WRITE_TRACKED_CACHE_SCRIPT;
void zeroTimestampRedisFrame;
void setReplyValidation;
void DialCacheRedisPlaceholderLostError;
void encodeTrackedRedisPlaceholder;
void resolveTrackedRedisWriteReply;
void REDIS_FRAME_VERSION;
void REDIS_ENCODING_UTF8;
void REDIS_ENCODING_BINARY;
void WRITE_TRACKED_STAMP_SCRIPT;
void customRedisClient;
const globalSerializer: Serializer<unknown> = {
  dump: () => "global",
  load: () => ({ source: "global" }),
};
const cacheWithGlobalSerializer = new DialCache({
  redis: { client: customRedisClient, readTimeoutMs: 1_000, serializer: globalSerializer },
});
// @ts-expect-error A global serializer cannot establish per-function Date compatibility.
cacheWithGlobalSerializer.cached(async (_id: string) => new Date(0), optionsFor("GlobalSerializerNeedsTypedOverride"));
// @ts-expect-error A global serializer cannot establish per-invocation Date compatibility.
cacheWithGlobalSerializer.getOrLoad(async () => new Date(0), inlineOptionsFor("GlobalSerializerNeedsInlineTypedOverride"));
void cacheHasNoFlushAll;
void cacheHasNoClose;
void clientHasNoFlushAll;
void writeHasNoWatermark;
void trackedWriteHasNoWatermarkTtlFloor;
void writeAcceptsOptionalCreatedAt;
void invalidationHasNoWatermarkTtlFloor;
void invalidationHasNoInvalidatedAt;
void legacyTrackedWriteRequest;
void timestampedWriteRequest;
void omittedTimestampWriteRequest;
void legacyInvalidationRequest;
void configHasNoMetricsRegistry;
void configHasNoMetricsPrefix;
void configRejectsFalseMetrics;
void configHasNamespace;
void configHasNoUrnPrefix;
void legacyNamespaceConfig;
void configHasNoRampSampler;
void legacyRampSamplerConfig;
void redisConfigHasNoKeyPrefix;
void legacyKeyPrefixConfig;
void redisConfigRequiresClient;
void redisConfigAllowsDefaultReadTimeout;
void redisConfigHasNoCreateClient;
void missingRedisClientConfig;
void defaultRedisReadTimeoutConfig;
void legacyRedisFactoryConfig;
void redisReadContext.signal;
void rootHasNoPrometheusFactory;
void rootHasNoDatadogFactory;
void rootHasNoDeterministicRampSampler;
void rootHasNoRandomRampSampler;
void datadogMetrics;
void datadogClassAdapter;
void missingObservationType;
void invalidAsyncStaleRecoveryConfig;
`;
const integrationConsumer = `import * as valkeyGlide from "@valkey/valkey-glide";
import { DialCache } from "dialcache";
import StatsD from "hot-shots";
import { createClient as createRedisClient, createCluster as createRedisCluster } from "redis";
import {
  DatadogDialCacheMetrics,
  createDatadogDialCacheMetrics,
  type DatadogDogStatsDClient,
  type DatadogMetricsOptions,
  type DatadogObservationMetricType,
} from "dialcache/datadog";
import {
  PrometheusDialCacheMetrics,
  createPrometheusDialCacheMetrics,
  type PrometheusMetricsOptions,
} from "dialcache/prometheus";
import { type DialCacheRedisClient } from "dialcache";
import {
  createValkeyGlideDialCacheClient,
  type ValkeyGlideRuntime,
} from "dialcache/valkey-glide";
// @ts-expect-error The stateless GLIDE adapter removed its dispose wrapper type.
import { type ValkeyGlideDialCacheClient } from "dialcache/valkey-glide";
// @ts-expect-error The handle-free GLIDE adapter removed the Script handle type.
import { type ValkeyGlideScriptHandle } from "dialcache/valkey-glide";
import { createNodeRedisDialCacheClient } from "dialcache/node-redis";
import { Registry, type OpenMetricsContentType } from "prom-client";

const registry = new Registry();
const options: PrometheusMetricsOptions = { registry, prefix: "consumer_" };
const metrics = createPrometheusDialCacheMetrics(options);
const cache = new DialCache({ metrics });
const classAdapter = new PrometheusDialCacheMetrics({ registry, prefix: "class_" });
const openMetricsRegistry = new Registry<OpenMetricsContentType>();
openMetricsRegistry.setContentType(Registry.OPENMETRICS_CONTENT_TYPE);
const openMetricsAdapter = new PrometheusDialCacheMetrics({ registry: openMetricsRegistry, prefix: "open_" });
const registryIsRequired: {} extends Pick<PrometheusMetricsOptions, "registry"> ? false : true = true;
const glideRedisClient: DialCacheRedisClient | undefined = undefined;
const standaloneNodeRedisClient = createRedisClient();
const clusterNodeRedisClient = createRedisCluster({
  rootNodes: [{ url: "redis://127.0.0.1:6379" }],
});
const standaloneNodeRedisAdapter = createNodeRedisDialCacheClient(standaloneNodeRedisClient);
const clusterNodeRedisAdapter = createNodeRedisDialCacheClient(clusterNodeRedisClient);
const glideRuntime: ValkeyGlideRuntime<valkeyGlide.Decoder> = valkeyGlide;
const glideRuntimeWithoutClusterBatch: ValkeyGlideRuntime<valkeyGlide.Decoder> = {
  Batch: valkeyGlide.Batch,
  GlideClient: valkeyGlide.GlideClient,
  GlideClusterClient: valkeyGlide.GlideClusterClient,
  Decoder: valkeyGlide.Decoder,
};
declare const standaloneGlideClient: valkeyGlide.GlideClient;
declare const clusterGlideClient: valkeyGlide.GlideClusterClient;
const standaloneGlideAdapter: DialCacheRedisClient = createValkeyGlideDialCacheClient(standaloneGlideClient, glideRuntime);
const clusterGlideAdapter: DialCacheRedisClient = createValkeyGlideDialCacheClient(clusterGlideClient, glideRuntime);
// @ts-expect-error The caller's GLIDE runtime is required for native Batch ownership.
createValkeyGlideDialCacheClient(standaloneGlideClient);
const dogStatsD = new StatsD({ mock: true });
const compatibleDogStatsD: DatadogDogStatsDClient = dogStatsD;
const observationMetricType: DatadogObservationMetricType = "distribution";
const datadogOptions: DatadogMetricsOptions = {
  client: compatibleDogStatsD,
  observationMetricType,
};
const datadogMetrics = createDatadogDialCacheMetrics(datadogOptions);
const datadogClassAdapter = new DatadogDialCacheMetrics({
  client: dogStatsD,
  observationMetricType: "histogram",
});
const datadogCache = new DialCache({ metrics: datadogMetrics });
const observationMetricTypeIsRequired: {} extends Pick<DatadogMetricsOptions, "observationMetricType">
  ? false
  : true = true;

void cache;
void classAdapter;
void openMetricsAdapter;
void registryIsRequired;
void glideRedisClient;
void glideRuntimeWithoutClusterBatch;
void standaloneNodeRedisAdapter;
void clusterNodeRedisAdapter;
void standaloneGlideAdapter;
void clusterGlideAdapter;
void datadogClassAdapter;
void datadogCache;
void observationMetricTypeIsRequired;
`;

try {
  await exec("corepack", ["pnpm", "pack", "--pack-destination", workspace], { cwd: root });
  const tarball = (await readdir(workspace)).find((name) => name.endsWith(".tgz"));
  if (tarball === undefined) {
    throw new Error("pnpm pack did not produce a tarball");
  }
  const packageTarball = join(workspace, tarball);

  await exec(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-save",
      packageTarball,
      "redis@~4.7.1",
      "typescript@5.9.3",
    ],
    { cwd: workspace },
  );

  for (const integrationDependency of ["prom-client", "@valkey/valkey-glide", "hot-shots"]) {
    if (await isResolvable(integrationDependency, workspace)) {
      throw new Error(`The ${integrationDependency} integration dependency was installed automatically`);
    }
  }

  await Promise.all([
    writeFile(join(workspace, "root-consumer.mts"), rootConsumer),
    writeFile(join(workspace, "root-consumer.cts"), rootConsumer),
    writeFile(
      join(workspace, "tsconfig.root.json"),
      typescriptConfig([
        "root-consumer.mts",
        "root-consumer.cts",
        ...documentationExamples.map((example) => example.filename),
      ]),
    ),
    ...documentationExamples.map(async (example) => {
      const markdown = await readFile(join(root, example.source), "utf8");
      const code = markdown.match(/^```ts\r?\n([\s\S]*?)^```\s*$/m)?.[1];
      if (code === undefined) {
        throw new Error(`${example.source} has no runnable TypeScript example`);
      }
      await writeFile(join(workspace, example.filename), code);
    }),
  ]);

  const { stdout: esmRootRuntimeOutput } = await exec(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const { createHash } = await import("node:crypto");
const root = await import("dialcache");
const nodeRedis = await import("dialcache/node-redis");
await import("dialcache/valkey-glide");
await import("dialcache/datadog");
const redisProtocol = await import("dialcache/redis-protocol");
${packedInvalidationCheckSource}
${packedStaleRecoveryCheckSource}
if (typeof nodeRedis.createNodeRedisDialCacheClient !== "function") {
  throw new Error("The packed ESM node-redis adapter export is missing");
}
if ("dialcacheRedisScripts" in nodeRedis) {
  throw new Error("The removed ESM node-redis script-registration facade is still exported");
}
await verifyPackedInvalidation({
  createAdapter: (dispatch) =>
    createPackedNodeRedisInvalidationAdapter(nodeRedis, dispatch, "ESM node-redis"),
  label: "ESM node-redis",
  redisProtocol,
});
await verifyPackedStaleRecovery(root, "ESM");
console.log("${nodeInvalidationMarker}");
const fallbackTimeoutError = new root.FallbackTimeoutError("PackageRuntime", 1000);
if (!(fallbackTimeoutError instanceof root.DialCacheError) || fallbackTimeoutError.timeoutMs !== 1000) {
  throw new Error("The root ESM fallback-timeout error export is invalid");
}
const redisReadTimeoutError = new root.RedisReadTimeoutError("PackageRuntime", 100);
if (!(redisReadTimeoutError instanceof root.DialCacheError) || redisReadTimeoutError.timeoutMs !== 100) {
  throw new Error("The root ESM Redis-read-timeout error export is invalid");
}
const coalescingState = new root.DialCache().getCoalescingState();
const idleCoalescingState = { process: { activeLeaders: 0, activeFollowers: 0, oldestLeaderAgeMs: null } };
if (JSON.stringify(coalescingState) !== JSON.stringify(idleCoalescingState)) {
  throw new Error("The root ESM coalescing snapshot export is invalid");
}
const timeoutCache = new root.DialCache();
const neverSettles = timeoutCache.cached(async () => await new Promise(() => undefined), {
  keyType: "id",
  useCase: "PackageOnlyHandleTimeout",
  cacheKey: () => "1",
  defaultConfig: root.DialCacheKeyConfig.enabled(60),
  fallbackTimeoutMs: 20,
});
try {
  await timeoutCache.enable(() => neverSettles());
  throw new Error("Expected the packaged ESM fallback to time out");
} catch (error) {
  if (!(error instanceof root.FallbackTimeoutError) || error.timeoutMs !== 20) {
    throw new Error("The packaged ESM fallback timeout was not delivered");
  }
  console.log("${fallbackTimeoutMarker}");
}
if ("MissingKeyConfigError" in root || "DialCacheRedisPlaceholderLostError" in root) {
  throw new Error("Removed error classes must not be exported from the root ESM entry");
}
if (
  "READ_CACHE_SCRIPT" in redisProtocol
  || "READ_TRACKED_CACHE_SCRIPT" in redisProtocol
) {
  throw new Error("The removed read scripts must not be exported by the packed ESM Redis protocol entry");
}
if (
  "WRITE_CACHE_SCRIPT" in redisProtocol
  || "WRITE_TRACKED_CACHE_SCRIPT" in redisProtocol
) {
  throw new Error("The removed write scripts must not be exported by the packed ESM Redis protocol entry");
}
if (
  "WRITE_TRACKED_STAMP_SCRIPT" in redisProtocol
  || "encodeTrackedRedisPlaceholder" in redisProtocol
  || "resolveTrackedRedisWriteReply" in redisProtocol
) {
  throw new Error("Removed placeholder and stamp helpers must not be exported by the packed ESM Redis protocol entry");
}
if (
  "decodeRedisFrame" in redisProtocol
  || "decodeTrackedRedisFrame" in redisProtocol
) {
  throw new Error("The legacy frame-or-null decoders must not be exported by the packed ESM Redis protocol entry");
}
if (typeof root.isRedisReadMiss !== "function" || typeof redisProtocol.isRedisReadMiss !== "function") {
  throw new Error("The packed ESM isRedisReadMiss guard is missing from the root or Redis protocol entry");
}
const esmRoundTrip = redisProtocol.decodeRedisReadResult(redisProtocol.encodeRedisFrame("value", 1));
if (
  redisProtocol.isRedisReadMiss(esmRoundTrip)
  || root.isRedisReadMiss(esmRoundTrip)
  || esmRoundTrip.payload !== "value"
  || esmRoundTrip.createdAtMs !== 1
) {
  throw new Error("The packed ESM Redis protocol encoder did not round-trip through the classified decoder");
}
const esmAbsentRead = redisProtocol.decodeRedisReadResult(null);
if (
  esmAbsentRead.kind !== "miss"
  || esmAbsentRead.reason !== "value_absent"
  || !redisProtocol.isRedisReadMiss(esmAbsentRead)
  || !root.isRedisReadMiss(esmAbsentRead)
  || "observedWatermarkMs" in esmAbsentRead
  || "payload" in esmAbsentRead
  || "createdAtMs" in esmAbsentRead
) {
  throw new Error("The packed ESM Redis result decoder did not classify an absent value");
}
if (
  root.isRedisReadMiss(null)
  || root.isRedisReadMiss({ reason: "value_absent", observedWatermarkMs: 1 })
  || redisProtocol.isRedisReadMiss({ kind: "watermark_miss", reason: "watermark_fenced", observedWatermarkMs: 1 })
) {
  throw new Error("The packed ESM isRedisReadMiss guard accepted a value without the miss discriminant");
}
const esmEqualTimestampRead = redisProtocol.decodeTrackedRedisReadResult(
  redisProtocol.encodeRedisFrame("pending", 0),
  Buffer.from("0"),
);
if (!redisProtocol.isRedisReadMiss(esmEqualTimestampRead) || "payload" in esmEqualTimestampRead) {
  throw new Error("The packed ESM tracked decoder did not reject a frame timestamped at the watermark");
}
const esmWatermarkMiss = redisProtocol.decodeTrackedRedisReadResult(
  redisProtocol.encodeRedisFrame("pending", 1),
  Buffer.from("1"),
);
if (
  esmWatermarkMiss.kind !== "miss"
  || esmWatermarkMiss.reason !== "watermark_fenced"
  || esmWatermarkMiss.observedWatermarkMs !== 1
  || "payload" in esmWatermarkMiss
  || "createdAtMs" in esmWatermarkMiss
) {
  throw new Error("The packed ESM tracked result decoder did not classify a watermark-fenced miss");
}
const esmTrackedHitWithoutWatermark = redisProtocol.decodeTrackedRedisReadResult(
  redisProtocol.encodeRedisFrame("value", 1),
  null,
);
if (
  redisProtocol.isRedisReadMiss(esmTrackedHitWithoutWatermark)
  || esmTrackedHitWithoutWatermark.payload !== "value"
  || esmTrackedHitWithoutWatermark.createdAtMs !== 1
) {
  throw new Error("The packed ESM tracked decoder did not use zero for a missing watermark");
}
const esmAbsentTrackedRead = redisProtocol.decodeTrackedRedisReadResult(null, null);
if (
  esmAbsentTrackedRead.kind !== "miss"
  || esmAbsentTrackedRead.reason !== "value_absent"
  || "observedWatermarkMs" in esmAbsentTrackedRead
  || "payload" in esmAbsentTrackedRead
  || "createdAtMs" in esmAbsentTrackedRead
) {
  throw new Error("The packed ESM tracked result decoder did not classify an absent value");
}
const esmAbsentTrackedReadWithWatermark = redisProtocol.decodeTrackedRedisReadResult(null, Buffer.from("7"));
if (
  esmAbsentTrackedReadWithWatermark.kind !== "miss"
  || esmAbsentTrackedReadWithWatermark.reason !== "value_absent"
  || esmAbsentTrackedReadWithWatermark.observedWatermarkMs !== 7
  || "payload" in esmAbsentTrackedReadWithWatermark
  || "createdAtMs" in esmAbsentTrackedReadWithWatermark
) {
  throw new Error("The packed ESM tracked result decoder did not preserve an absent-value refill fence");
}
if (
  "REDIS_FRAME_VERSION" in redisProtocol
  || "REDIS_ENCODING_UTF8" in redisProtocol
  || "REDIS_ENCODING_BINARY" in redisProtocol
) {
  throw new Error("The removed wire constants must not be exported by the packed ESM Redis protocol entry");
}
if (redisProtocol.validateRedisScriptInvalidationReply(1) !== 1) {
  throw new Error("The packed ESM invalidation reply validator must accept reply 1");
}
for (const invalidInvalidationReply of [0, 2]) {
  try {
    redisProtocol.validateRedisScriptInvalidationReply(invalidInvalidationReply);
    throw new Error("Expected an out-of-domain invalidation reply to fail");
  } catch (error) {
    if (!(error instanceof root.DialCacheRedisProtocolError)) {
      throw new Error("The invalidation reply error does not match the root ESM export");
    }
  }
}
if (redisProtocol.ceilSupportedCacheTtlMs(1_000.5) !== 1_001) {
  throw new Error("The packed ESM TTL guard did not ceil a fractional cacheTtlMs");
}
for (const invalidCacheTtlMs of [0, 31_536_000_001]) {
  try {
    redisProtocol.ceilSupportedCacheTtlMs(invalidCacheTtlMs);
    throw new Error("Expected an out-of-domain cacheTtlMs to fail");
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw new Error("The packed ESM TTL guard must reject out-of-domain durations with RangeError");
    }
  }
}
const esmEmptyFrame = Buffer.alloc(10);
esmEmptyFrame[0] = 1;
esmEmptyFrame.writeBigUInt64BE(1n, 1);
const esmEmptyFrameRead = redisProtocol.decodeRedisReadResult(esmEmptyFrame);
if (redisProtocol.isRedisReadMiss(esmEmptyFrameRead) || esmEmptyFrameRead.payload !== "") {
  throw new Error("The packed ESM Redis protocol decoder did not preserve an empty UTF-8 payload");
}
if (redisProtocol.decodeTrackedRedisReadResult(esmEmptyFrame, Buffer.from("1")).kind !== "miss") {
  throw new Error("The packed ESM Redis protocol decoder did not reject a stale tracked frame");
}
try {
  redisProtocol.decodeRedisReadResult("not binary");
  throw new Error("Expected the packed ESM Redis protocol decoder to reject a non-binary reply");
} catch (error) {
  if (!(error instanceof root.DialCacheRedisPayloadError)) {
    throw new Error("The Redis protocol payload error does not match the root ESM export");
  }
}
const esmInvalidEncodingFrame = Buffer.from(esmEmptyFrame);
esmInvalidEncodingFrame[9] = 2;
try {
  redisProtocol.decodeRedisReadResult(esmInvalidEncodingFrame);
  throw new Error("Expected the packed ESM Redis protocol decoder to reject an unsupported encoding");
} catch (error) {
  if (!(error instanceof root.DialCacheRedisPayloadEncodingError)) {
    throw new Error("The Redis protocol encoding error does not match the root ESM export");
  }
}
const esmDisabledOverlay = root.DialCacheKeyConfig.disabled();
if (
  esmDisabledOverlay.requestLocal !== false
  || esmDisabledOverlay.coalesce !== undefined
  || esmDisabledOverlay.staleOnErrorMaxAgeSec !== 0
  || esmDisabledOverlay.shadow?.ramp !== 0
  || esmDisabledOverlay.shadow.logMismatches !== false
  || esmDisabledOverlay.ramp[root.CacheLayer.LOCAL] !== 0
  || esmDisabledOverlay.ramp[root.CacheLayer.REMOTE] !== 0
) {
  throw new Error("The packed ESM runtime did not build the disabled() kill-switch overlay");
}
let calls = 0;
const overlayCache = new root.DialCache({
  cacheConfigProvider: () => new root.DialCacheKeyConfig({
    ramp: { [root.CacheLayer.LOCAL]: 100 },
  }),
});
const load = overlayCache.cached(async (id) => ({ id, calls: ++calls }), {
  keyType: "id",
  useCase: "PackedRuntimeOverlay",
  cacheKey: (id) => id,
  defaultConfig: new root.DialCacheKeyConfig({
    ttlSec: { [root.CacheLayer.LOCAL]: 60 },
  }),
});
const first = await overlayCache.enable(() => load("123"));
const second = await overlayCache.enable(() => load("123"));
if (calls !== 1 || second !== first) {
  throw new Error("The packed ESM runtime did not inherit the default local TTL through a sparse overlay");
}
let inlineCalls = 0;
const inlineOptions = {
  keyType: "id",
  useCase: "PackedRuntimeGetOrLoad",
  key: "123",
  defaultConfig: root.DialCacheKeyConfig.enabled(60),
};
const inlineFirst = await overlayCache.enable(() =>
  overlayCache.getOrLoad(() => ({ source: "inline", calls: ++inlineCalls }), inlineOptions),
);
const inlineSecond = await overlayCache.enable(() =>
  overlayCache.getOrLoad(() => ({ source: "unexpected", calls: ++inlineCalls }), inlineOptions),
);
if (inlineCalls !== 1 || inlineSecond !== inlineFirst) {
  throw new Error("The packed ESM runtime did not execute getOrLoad through the cache chain");
}
let ancientTimestampReadCalls = 0;
let ancientTimestampFallbackCalls = 0;
const ancientTimestampCache = new root.DialCache({
  redis: {
    client: {
      read: async () => {
        ancientTimestampReadCalls += 1;
        return {
          payload: JSON.stringify({ source: "cached" }),
          createdAtMs: 1,
        };
      },
      write: async () => undefined,
      invalidate: async () => undefined,
    },
  },
});
const ancientTimestampLoad = ancientTimestampCache.cached(async () => {
  ancientTimestampFallbackCalls += 1;
  return { source: "fallback" };
}, {
  keyType: "id",
  useCase: "PackedAncientUntrackedTimestamp",
  cacheKey: () => "123",
  defaultConfig: new root.DialCacheKeyConfig({
    ttlSec: { [root.CacheLayer.REMOTE]: 60 },
  }),
});
const ancientTimestampValue = await ancientTimestampCache.enable(() => ancientTimestampLoad());
if (
  ancientTimestampReadCalls !== 1
  || ancientTimestampFallbackCalls !== 1
  || ancientTimestampValue.source !== "fallback"
) {
  throw new Error("The packed ESM runtime did not reject an ancient untracked frame timestamp");
}`,
    ],
    { cwd: workspace },
  );
  if (!esmRootRuntimeOutput.includes(fallbackTimeoutMarker)) {
    throw new Error("The packaged ESM only-handle fallback timeout marker is missing");
  }
  if (!esmRootRuntimeOutput.includes(nodeInvalidationMarker)) {
    throw new Error("The packaged ESM node-redis invalidation marker is missing");
  }

  const { stdout: observerIsolationOutput } = await exec(
    process.execPath,
    [
      "--unhandled-rejections=strict",
      "--input-type=module",
      "--eval",
      `const root = await import("dialcache");
const rejectObserver = () => Promise.reject(new Error("observer transport failed"));
const metrics = {
  request: rejectObserver,
  miss: rejectObserver,
  disabled: rejectObserver,
  error: rejectObserver,
  invalidation: rejectObserver,
  observeGet: rejectObserver,
  observeFallback: rejectObserver,
  observeSerialization: rejectObserver,
  observeSize: rejectObserver,
};
const cache = new root.DialCache({
  logger: {
    debug: rejectObserver,
    error: rejectObserver,
    warn: rejectObserver,
  },
  metrics,
});
const load = cache.cached(async () => "fallback", {
  keyType: "id",
  useCase: "PackageObserverIsolation",
  cacheKey: () => {
    throw new Error("key construction failed");
  },
  defaultConfig: root.DialCacheKeyConfig.enabled(60),
});
const value = await cache.enable(() => load());
if (value !== "fallback") {
  throw new Error("Observer rejection changed the packaged fallback result");
}
await new Promise((resolve) => setImmediate(resolve));
console.log("${observerIsolationMarker}");`,
    ],
    { cwd: workspace },
  );
  if (!observerIsolationOutput.includes(observerIsolationMarker)) {
    throw new Error("The packaged observer-rejection isolation marker is missing");
  }

  const { stdout: shadowPayloadReleaseOutput } = await exec(
    process.execPath,
    [
      "--expose-gc",
      "--input-type=module",
      "--eval",
      `const root = await import("dialcache");
let payload = Buffer.alloc(4 * 1024 * 1024, 1);
const payloadReference = new WeakRef(payload);
const redis = {
  read: async () => ({ payload, createdAtMs: Date.now() }),
  write: async () => undefined,
  invalidate: async () => undefined,
};
let resolveTimeout;
const timeoutObserved = new Promise((resolve) => {
  resolveTimeout = resolve;
});
const metrics = {
  request: () => undefined,
  miss: () => undefined,
  disabled: () => undefined,
  error: () => undefined,
  invalidation: () => undefined,
  observeGet: () => undefined,
  observeFallback: () => undefined,
  observeSerialization: () => undefined,
  observeSize: () => undefined,
  shadowValidation: ({ outcome }) => {
    if (outcome === "timeout") {
      resolveTimeout();
    }
  },
};
const cache = new root.DialCache({
  redis: { client: redis, serializer: {
    dump: () => "unused",
    load: () => ({ id: "123" }),
  } },
  metrics,
});
const load = cache.cached(async () => await new Promise(() => undefined), {
  keyType: "id",
  useCase: "PackageShadowPayloadRelease",
  cacheKey: () => "123",
  trackForInvalidation: true,
  fallbackTimeoutMs: 20,
  defaultConfig: new root.DialCacheKeyConfig({
    ttlSec: { [root.CacheLayer.REMOTE]: 60 },
    ramp: { [root.CacheLayer.REMOTE]: 100 },
    shadow: { ramp: 100 },
  }),
});
let value = await cache.enable(() => load());
if (value.id !== "123") {
  throw new Error("The packaged shadow payload setup did not produce a served hit");
}
value = null;
payload = null;
let shadowTimeoutGuard;
const missingShadowTimeout = new Promise((_, reject) => {
  shadowTimeoutGuard = setTimeout(() => {
    reject(new Error("The packaged shadow payload test did not observe timeout delivery"));
  }, 2_000);
});
try {
  await Promise.race([timeoutObserved, missingShadowTimeout]);
  for (let attempt = 0; attempt < 40 && payloadReference.deref() !== undefined; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    Buffer.alloc(4 * 1024 * 1024);
    globalThis.gc();
  }
  if (payloadReference.deref() !== undefined) {
    throw new Error("A timed-out shadow operation retained its original Redis payload");
  }
} finally {
  clearTimeout(shadowTimeoutGuard);
}
console.log("${shadowPayloadReleaseMarker}");`,
    ],
    { cwd: workspace, timeout: 10_000 },
  );
  if (!shadowPayloadReleaseOutput.includes(shadowPayloadReleaseMarker)) {
    throw new Error("The packaged shadow-payload release marker is missing");
  }

  const { stdout: cjsRootRuntimeOutput } = await exec(
    process.execPath,
    [
      "--eval",
      `const { createHash } = require("node:crypto");
const root = require("dialcache");
const nodeRedis = require("dialcache/node-redis");
require("dialcache/valkey-glide");
require("dialcache/datadog");
const redisProtocol = require("dialcache/redis-protocol");
${packedInvalidationCheckSource}
${packedStaleRecoveryCheckSource}
if (typeof nodeRedis.createNodeRedisDialCacheClient !== "function") {
  throw new Error("The packed CommonJS node-redis adapter export is missing");
}
if ("dialcacheRedisScripts" in nodeRedis) {
  throw new Error("The removed CommonJS node-redis script-registration facade is still exported");
}
const cjsNodeInvalidationCheck = verifyPackedInvalidation({
  createAdapter: (dispatch) =>
    createPackedNodeRedisInvalidationAdapter(nodeRedis, dispatch, "CommonJS node-redis"),
  label: "CommonJS node-redis",
  redisProtocol,
}).then(() => console.log("${nodeInvalidationMarker}"));
const fallbackTimeoutError = new root.FallbackTimeoutError("PackageRuntime", 1000);
if (!(fallbackTimeoutError instanceof root.DialCacheError) || fallbackTimeoutError.timeoutMs !== 1000) {
  throw new Error("The root CommonJS fallback-timeout error export is invalid");
}
const redisReadTimeoutError = new root.RedisReadTimeoutError("PackageRuntime", 100);
if (!(redisReadTimeoutError instanceof root.DialCacheError) || redisReadTimeoutError.timeoutMs !== 100) {
  throw new Error("The root CommonJS Redis-read-timeout error export is invalid");
}
const coalescingState = new root.DialCache().getCoalescingState();
const idleCoalescingState = { process: { activeLeaders: 0, activeFollowers: 0, oldestLeaderAgeMs: null } };
if (JSON.stringify(coalescingState) !== JSON.stringify(idleCoalescingState)) {
  throw new Error("The root CommonJS coalescing snapshot export is invalid");
}
const timeoutCache = new root.DialCache();
const neverSettles = timeoutCache.cached(async () => await new Promise(() => undefined), {
  keyType: "id",
  useCase: "PackageOnlyHandleTimeout",
  cacheKey: () => "1",
  defaultConfig: root.DialCacheKeyConfig.enabled(60),
  fallbackTimeoutMs: 20,
});
void (async () => {
  try {
    await timeoutCache.enable(() => neverSettles());
    throw new Error("Expected the packaged CommonJS fallback to time out");
  } catch (error) {
    if (!(error instanceof root.FallbackTimeoutError) || error.timeoutMs !== 20) {
      throw new Error("The packaged CommonJS fallback timeout was not delivered");
    }
    console.log("${fallbackTimeoutMarker}");
  }
})();
if ("MissingKeyConfigError" in root || "DialCacheRedisPlaceholderLostError" in root) {
  throw new Error("Removed error classes must not be exported from the root CommonJS entry");
}
if (
  "READ_CACHE_SCRIPT" in redisProtocol
  || "READ_TRACKED_CACHE_SCRIPT" in redisProtocol
) {
  throw new Error("The removed read scripts must not be exported by the packed CommonJS Redis protocol entry");
}
if (
  "WRITE_CACHE_SCRIPT" in redisProtocol
  || "WRITE_TRACKED_CACHE_SCRIPT" in redisProtocol
) {
  throw new Error("The removed write scripts must not be exported by the packed CommonJS Redis protocol entry");
}
if (
  "WRITE_TRACKED_STAMP_SCRIPT" in redisProtocol
  || "encodeTrackedRedisPlaceholder" in redisProtocol
  || "resolveTrackedRedisWriteReply" in redisProtocol
) {
  throw new Error("Removed placeholder and stamp helpers must not be exported by the packed CommonJS Redis protocol entry");
}
if (
  "decodeRedisFrame" in redisProtocol
  || "decodeTrackedRedisFrame" in redisProtocol
) {
  throw new Error("The legacy frame-or-null decoders must not be exported by the packed CommonJS Redis protocol entry");
}
if (typeof root.isRedisReadMiss !== "function" || typeof redisProtocol.isRedisReadMiss !== "function") {
  throw new Error("The packed CommonJS isRedisReadMiss guard is missing from the root or Redis protocol entry");
}
const cjsRoundTrip = redisProtocol.decodeRedisReadResult(redisProtocol.encodeRedisFrame("value", 1));
if (
  redisProtocol.isRedisReadMiss(cjsRoundTrip)
  || root.isRedisReadMiss(cjsRoundTrip)
  || cjsRoundTrip.payload !== "value"
  || cjsRoundTrip.createdAtMs !== 1
) {
  throw new Error("The packed CommonJS Redis protocol encoder did not round-trip through the classified decoder");
}
const cjsAbsentRead = redisProtocol.decodeRedisReadResult(null);
if (
  cjsAbsentRead.kind !== "miss"
  || cjsAbsentRead.reason !== "value_absent"
  || !redisProtocol.isRedisReadMiss(cjsAbsentRead)
  || !root.isRedisReadMiss(cjsAbsentRead)
  || "observedWatermarkMs" in cjsAbsentRead
  || "payload" in cjsAbsentRead
  || "createdAtMs" in cjsAbsentRead
) {
  throw new Error("The packed CommonJS Redis result decoder did not classify an absent value");
}
if (
  root.isRedisReadMiss(null)
  || root.isRedisReadMiss({ reason: "value_absent", observedWatermarkMs: 1 })
  || redisProtocol.isRedisReadMiss({ kind: "watermark_miss", reason: "watermark_fenced", observedWatermarkMs: 1 })
) {
  throw new Error("The packed CommonJS isRedisReadMiss guard accepted a value without the miss discriminant");
}
const cjsEqualTimestampRead = redisProtocol.decodeTrackedRedisReadResult(
  redisProtocol.encodeRedisFrame("pending", 0),
  Buffer.from("0"),
);
if (!redisProtocol.isRedisReadMiss(cjsEqualTimestampRead) || "payload" in cjsEqualTimestampRead) {
  throw new Error("The packed CommonJS tracked decoder did not reject a frame timestamped at the watermark");
}
const cjsWatermarkMiss = redisProtocol.decodeTrackedRedisReadResult(
  redisProtocol.encodeRedisFrame("pending", 1),
  Buffer.from("1"),
);
if (
  cjsWatermarkMiss.kind !== "miss"
  || cjsWatermarkMiss.reason !== "watermark_fenced"
  || cjsWatermarkMiss.observedWatermarkMs !== 1
  || "payload" in cjsWatermarkMiss
  || "createdAtMs" in cjsWatermarkMiss
) {
  throw new Error("The packed CommonJS tracked result decoder did not classify a watermark-fenced miss");
}
const cjsTrackedHitWithoutWatermark = redisProtocol.decodeTrackedRedisReadResult(
  redisProtocol.encodeRedisFrame("value", 1),
  null,
);
if (
  redisProtocol.isRedisReadMiss(cjsTrackedHitWithoutWatermark)
  || cjsTrackedHitWithoutWatermark.payload !== "value"
  || cjsTrackedHitWithoutWatermark.createdAtMs !== 1
) {
  throw new Error("The packed CommonJS tracked decoder did not use zero for a missing watermark");
}
const cjsAbsentTrackedRead = redisProtocol.decodeTrackedRedisReadResult(null, null);
if (
  cjsAbsentTrackedRead.kind !== "miss"
  || cjsAbsentTrackedRead.reason !== "value_absent"
  || "observedWatermarkMs" in cjsAbsentTrackedRead
  || "payload" in cjsAbsentTrackedRead
  || "createdAtMs" in cjsAbsentTrackedRead
) {
  throw new Error("The packed CommonJS tracked result decoder did not classify an absent value");
}
const cjsAbsentTrackedReadWithWatermark = redisProtocol.decodeTrackedRedisReadResult(null, Buffer.from("7"));
if (
  cjsAbsentTrackedReadWithWatermark.kind !== "miss"
  || cjsAbsentTrackedReadWithWatermark.reason !== "value_absent"
  || cjsAbsentTrackedReadWithWatermark.observedWatermarkMs !== 7
  || "payload" in cjsAbsentTrackedReadWithWatermark
  || "createdAtMs" in cjsAbsentTrackedReadWithWatermark
) {
  throw new Error("The packed CommonJS tracked result decoder did not preserve an absent-value refill fence");
}
if (
  "REDIS_FRAME_VERSION" in redisProtocol
  || "REDIS_ENCODING_UTF8" in redisProtocol
  || "REDIS_ENCODING_BINARY" in redisProtocol
) {
  throw new Error("The removed wire constants must not be exported by the packed CommonJS Redis protocol entry");
}
if (redisProtocol.validateRedisScriptInvalidationReply(1) !== 1) {
  throw new Error("The packed CommonJS invalidation reply validator must accept reply 1");
}
for (const invalidInvalidationReply of [0, 2]) {
  try {
    redisProtocol.validateRedisScriptInvalidationReply(invalidInvalidationReply);
    throw new Error("Expected an out-of-domain invalidation reply to fail");
  } catch (error) {
    if (!(error instanceof root.DialCacheRedisProtocolError)) {
      throw new Error("The invalidation reply error does not match the root CommonJS export");
    }
  }
}
if (redisProtocol.ceilSupportedCacheTtlMs(1_000.5) !== 1_001) {
  throw new Error("The packed CommonJS TTL guard did not ceil a fractional cacheTtlMs");
}
for (const invalidCacheTtlMs of [0, 31_536_000_001]) {
  try {
    redisProtocol.ceilSupportedCacheTtlMs(invalidCacheTtlMs);
    throw new Error("Expected an out-of-domain cacheTtlMs to fail");
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw new Error("The packed CommonJS TTL guard must reject out-of-domain durations with RangeError");
    }
  }
}
const cjsEmptyFrame = Buffer.alloc(10);
cjsEmptyFrame[0] = 1;
cjsEmptyFrame.writeBigUInt64BE(1n, 1);
const cjsEmptyFrameRead = redisProtocol.decodeRedisReadResult(cjsEmptyFrame);
if (redisProtocol.isRedisReadMiss(cjsEmptyFrameRead) || cjsEmptyFrameRead.payload !== "") {
  throw new Error("The packed CommonJS Redis protocol decoder did not preserve an empty UTF-8 payload");
}
if (redisProtocol.decodeTrackedRedisReadResult(cjsEmptyFrame, Buffer.from("1")).kind !== "miss") {
  throw new Error("The packed CommonJS Redis protocol decoder did not reject a stale tracked frame");
}
try {
  redisProtocol.decodeRedisReadResult("not binary");
  throw new Error("Expected the packed CommonJS Redis protocol decoder to reject a non-binary reply");
} catch (error) {
  if (!(error instanceof root.DialCacheRedisPayloadError)) {
    throw new Error("The Redis protocol payload error does not match the root CommonJS export");
  }
}
const cjsInvalidEncodingFrame = Buffer.from(cjsEmptyFrame);
cjsInvalidEncodingFrame[9] = 2;
try {
  redisProtocol.decodeRedisReadResult(cjsInvalidEncodingFrame);
  throw new Error("Expected the packed CommonJS Redis protocol decoder to reject an unsupported encoding");
} catch (error) {
  if (!(error instanceof root.DialCacheRedisPayloadEncodingError)) {
    throw new Error("The Redis protocol encoding error does not match the root CommonJS export");
  }
}
const cjsDisabledOverlay = root.DialCacheKeyConfig.disabled();
if (
  cjsDisabledOverlay.requestLocal !== false
  || cjsDisabledOverlay.coalesce !== undefined
  || cjsDisabledOverlay.staleOnErrorMaxAgeSec !== 0
  || cjsDisabledOverlay.shadow?.ramp !== 0
  || cjsDisabledOverlay.shadow.logMismatches !== false
  || cjsDisabledOverlay.ramp[root.CacheLayer.LOCAL] !== 0
  || cjsDisabledOverlay.ramp[root.CacheLayer.REMOTE] !== 0
) {
  throw new Error("The packed CommonJS runtime did not build the disabled() kill-switch overlay");
}
void (async () => {
  await cjsNodeInvalidationCheck;
  await verifyPackedStaleRecovery(root, "CommonJS");
  let calls = 0;
  const overlayCache = new root.DialCache({
    cacheConfigProvider: () => new root.DialCacheKeyConfig({
      ramp: { [root.CacheLayer.LOCAL]: 100 },
    }),
  });
  const load = overlayCache.cached(async (id) => ({ id, calls: ++calls }), {
    keyType: "id",
    useCase: "PackedRuntimeOverlay",
    cacheKey: (id) => id,
    defaultConfig: new root.DialCacheKeyConfig({
      ttlSec: { [root.CacheLayer.LOCAL]: 60 },
    }),
  });
  const first = await overlayCache.enable(() => load("123"));
  const second = await overlayCache.enable(() => load("123"));
  if (calls !== 1 || second !== first) {
    throw new Error("The packed CommonJS runtime did not inherit the default local TTL through a sparse overlay");
  }
  let inlineCalls = 0;
  const inlineOptions = {
    keyType: "id",
    useCase: "PackedRuntimeGetOrLoad",
    key: "123",
    defaultConfig: root.DialCacheKeyConfig.enabled(60),
  };
  const inlineFirst = await overlayCache.enable(() =>
    overlayCache.getOrLoad(() => ({ source: "inline", calls: ++inlineCalls }), inlineOptions),
  );
  const inlineSecond = await overlayCache.enable(() =>
    overlayCache.getOrLoad(() => ({ source: "unexpected", calls: ++inlineCalls }), inlineOptions),
  );
  if (inlineCalls !== 1 || inlineSecond !== inlineFirst) {
    throw new Error("The packed CommonJS runtime did not execute getOrLoad through the cache chain");
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});`,
    ],
    { cwd: workspace },
  );
  if (!cjsRootRuntimeOutput.includes(fallbackTimeoutMarker)) {
    throw new Error("The packaged CommonJS only-handle fallback timeout marker is missing");
  }
  if (!cjsRootRuntimeOutput.includes(nodeInvalidationMarker)) {
    throw new Error("The packaged CommonJS node-redis invalidation marker is missing");
  }
  await exec(
    join(workspace, "node_modules", ".bin", "tsc"),
    ["--project", join(workspace, "tsconfig.root.json")],
    { cwd: workspace },
  );

  for (const example of documentationExamples) {
    const { stdout } = await exec(
      process.execPath,
      ["--experimental-strip-types", example.filename],
      { cwd: workspace, timeout: 10_000 },
    );
    if (stdout !== example.stdout) {
      throw new Error(`${example.source} produced unexpected output: ${JSON.stringify(stdout)}`);
    }
  }

  await exec(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-save",
      packageTarball,
      "redis@~4.7.1",
      "typescript@5.9.3",
      "prom-client@^15.1.3",
      "@valkey/valkey-glide@2.0.0",
      "dialcache-test-glide@npm:@valkey/valkey-glide@2.4.2",
      "hot-shots@^17.0.0",
    ],
    { cwd: workspace },
  );

  await Promise.all([
    writeFile(join(workspace, "consumer.mts"), integrationConsumer),
    writeFile(join(workspace, "consumer.cts"), integrationConsumer),
    writeFile(join(workspace, "tsconfig.json"), typescriptConfig(["consumer.mts", "consumer.cts"])),
  ]);

  await exec(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const { createHash } = await import("node:crypto");
const glide = await import("dialcache/valkey-glide");
const appGlide = await import("@valkey/valkey-glide");
const otherGlide = await import("dialcache-test-glide");
await import("dialcache/datadog");
await import("dialcache/prometheus");
const redisProtocol = await import("dialcache/redis-protocol");
await import("dialcache/node-redis");
${packedInvalidationCheckSource}
const esmCreatedAtMs = 1700000000123;
const esmAdapterClockMs = esmCreatedAtMs + 999;
if (appGlide.Script === otherGlide.Script) {
  throw new Error("The package test requires two distinct GLIDE module instances");
}
let esmWriteCommand;
const esmFakeGlideClient = {
  exec: async (batch, _raiseOnError, options) => {
    if (!(batch instanceof appGlide.Batch) || batch instanceof otherGlide.Batch) {
      throw new Error("The ESM adapter did not use the caller-supplied GLIDE Batch constructor");
    }
    if (options.decoder !== appGlide.Decoder.Bytes) {
      throw new Error("The ESM adapter did not use the caller-supplied GLIDE byte decoder");
    }
    return [[esmWriteCommand[2], null]];
  },
  customCommand: async (args, options) => {
    if (args[0] !== "SET") {
      throw new Error("The ESM adapter's write must dispatch one native SET");
    }
    if (options.decoder !== appGlide.Decoder.Bytes) {
      throw new Error("The ESM adapter did not use the caller-supplied GLIDE byte decoder");
    }
    esmWriteCommand = args;
    return "OK";
  },
};
const esmGlideRuntime = {
  ...appGlide,
  GlideClient: { [Symbol.hasInstance]: (value) => value === esmFakeGlideClient },
  GlideClusterClient: { [Symbol.hasInstance]: () => false },
};
const adapter = glide.createValkeyGlideDialCacheClient(esmFakeGlideClient, esmGlideRuntime);
const esmNativeDateNow = Date.now;
Date.now = () => esmAdapterClockMs;
try {
  await adapter.write({
    valueKey: "tracked:{id}:value",
    cacheTtlMs: 1_000,
    value: "payload",
    createdAtMs: esmCreatedAtMs,
  });
  if (
    esmWriteCommand[0] !== "SET"
    || esmWriteCommand[3] !== "PX"
    || esmWriteCommand[4] !== "1000"
    || !Buffer.isBuffer(esmWriteCommand[2])
    || esmWriteCommand[2][0] !== 1
    || esmWriteCommand[2].readBigUInt64BE(1) !== BigInt(esmCreatedAtMs)
  ) {
    throw new Error("The packed ESM GLIDE write did not preserve the supplied frame timestamp exactly");
  }
  const trackedRead = await adapter.read({
    valueKey: "tracked:{id}:value",
    watermarkKey: "tracked:{id}:watermark",
  });
  if (trackedRead?.payload !== "payload" || trackedRead.createdAtMs !== esmCreatedAtMs) {
    throw new Error("The packed ESM GLIDE read did not use the caller-supplied Batch runtime");
  }
} finally {
  Date.now = esmNativeDateNow;
}
await verifyPackedInvalidation({
  createAdapter: (dispatch) => createPackedGlideInvalidationAdapter(glide, appGlide, dispatch),
  label: "ESM GLIDE",
  redisProtocol,
});`,
    ],
    { cwd: workspace },
  );
  await exec(
    process.execPath,
    [
      "--eval",
      `const { createHash } = require("node:crypto");
const glide = require("dialcache/valkey-glide");
const appGlide = require("@valkey/valkey-glide");
const otherGlide = require("dialcache-test-glide");
require("dialcache/datadog");
require("dialcache/prometheus");
const redisProtocol = require("dialcache/redis-protocol");
require("dialcache/node-redis");
${packedInvalidationCheckSource}
void (async () => {
  const cjsCreatedAtMs = 1700000000123;
  if (appGlide.Script === otherGlide.Script) {
    throw new Error("The package test requires two distinct GLIDE module instances");
  }
  let cjsWriteCommand;
  const cjsFakeGlideClient = {
    exec: async (batch, _raiseOnError, options) => {
      if (!(batch instanceof appGlide.Batch) || batch instanceof otherGlide.Batch) {
        throw new Error("The CommonJS adapter did not use the caller-supplied GLIDE Batch constructor");
      }
      if (options.decoder !== appGlide.Decoder.Bytes) {
        throw new Error("The CommonJS adapter did not use the caller-supplied GLIDE byte decoder");
      }
      return [[cjsWriteCommand[2], null]];
    },
    customCommand: async (args, options) => {
      if (args[0] !== "SET") {
        throw new Error("The CommonJS adapter's write must dispatch one native SET");
      }
      if (options.decoder !== appGlide.Decoder.Bytes) {
        throw new Error("The CommonJS adapter did not use the caller-supplied GLIDE byte decoder");
      }
      cjsWriteCommand = args;
      return "OK";
    },
  };
  const cjsGlideRuntime = {
    ...appGlide,
    GlideClient: { [Symbol.hasInstance]: (value) => value === cjsFakeGlideClient },
    GlideClusterClient: { [Symbol.hasInstance]: () => false },
  };
  const adapter = glide.createValkeyGlideDialCacheClient(cjsFakeGlideClient, cjsGlideRuntime);
  const cjsNativeDateNow = Date.now;
  Date.now = () => cjsCreatedAtMs;
  try {
    await adapter.write({
      valueKey: "tracked:{id}:value",
      cacheTtlMs: 1_000,
      value: "payload",
    });
    if (
      cjsWriteCommand[0] !== "SET"
      || cjsWriteCommand[3] !== "PX"
      || cjsWriteCommand[4] !== "1000"
      || !Buffer.isBuffer(cjsWriteCommand[2])
      || cjsWriteCommand[2][0] !== 1
      || cjsWriteCommand[2].readBigUInt64BE(1) !== BigInt(cjsCreatedAtMs)
    ) {
      throw new Error("The packed CommonJS GLIDE write did not stamp an omitted timestamp from its client clock");
    }
    const trackedRead = await adapter.read({
      valueKey: "tracked:{id}:value",
      watermarkKey: "tracked:{id}:watermark",
    });
    if (trackedRead?.payload !== "payload" || trackedRead.createdAtMs !== cjsCreatedAtMs) {
      throw new Error("The packed CommonJS GLIDE read did not use the caller-supplied Batch runtime");
    }
  } finally {
    Date.now = cjsNativeDateNow;
  }
  await verifyPackedInvalidation({
    createAdapter: (dispatch) => createPackedGlideInvalidationAdapter(glide, appGlide, dispatch),
    label: "CommonJS GLIDE",
    redisProtocol,
  });
})();`,
    ],
    { cwd: workspace },
  );
  await exec(
    join(workspace, "node_modules", ".bin", "tsc"),
    ["--project", join(workspace, "tsconfig.json")],
    { cwd: workspace },
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}

async function isResolvable(specifier, cwd) {
  try {
    await exec(process.execPath, ["--eval", `require.resolve(${JSON.stringify(specifier)})`], { cwd });
    return true;
  } catch {
    return false;
  }
}

function typescriptConfig(include) {
  return `${JSON.stringify(
    {
      compilerOptions: {
        module: "Node16",
        moduleResolution: "Node16",
        noEmit: true,
        strict: true,
        exactOptionalPropertyTypes: false,
      },
      include,
    },
    null,
    2,
  )}\n`;
}
