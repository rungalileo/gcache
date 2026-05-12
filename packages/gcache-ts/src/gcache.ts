import { performance } from "node:perf_hooks";

import { CacheLayer, GCacheConfig, randomRampSampler, type CacheConfigProvider, type CacheRampSampler, type InvalidateOptions, type Logger } from "./config.js";
import { GCacheContext } from "./context.js";
import { UseCaseIsAlreadyRegisteredError, UseCaseNameIsReservedError } from "./errors.js";
import { GCacheKey, normalizeArgs } from "./key.js";
import { createPrometheusGCacheMetrics, errorName, labelsFor, type CacheMetricLabels, type GCacheMetricsAdapter } from "./metrics.js";
import type { Serializer } from "./serializer.js";
import { LocalCache } from "./internal/local-cache.js";
import { RedisCache } from "./internal/redis-cache.js";

type Awaitable<T> = T | Promise<T>;
type CacheableArgs = readonly unknown[];
type CacheArgs = Record<string, string | number | boolean | bigint | null | undefined>;

export interface CachedOptions<Args extends CacheableArgs> {
  readonly keyType: string;
  readonly useCase: string;
  readonly id: (args: Args) => string | number | bigint;
  readonly args?: (args: Args) => CacheArgs;
  readonly defaultConfig?: import("./config.js").GCacheKeyConfig | null;
  readonly serializer?: Serializer<unknown> | null;
  readonly trackForInvalidation?: boolean;
}

const DEFAULT_LOCAL_MAX_SIZE = 10_000;
const defaultConfigProvider: CacheConfigProvider = async () => null;
const defaultLogger: Logger = console;

export class GCache {
  private readonly context = new GCacheContext();
  private readonly localCache: LocalCache;
  private readonly useCases = new Set<string>();
  private readonly configProvider: CacheConfigProvider;
  private readonly urnPrefix: string;
  private readonly logger: Logger;
  private readonly rampSampler: CacheRampSampler;
  private readonly redisCache: RedisCache | null;
  private readonly metrics: GCacheMetricsAdapter | null;

  constructor(config: GCacheConfig = {}) {
    this.configProvider = config.cacheConfigProvider ?? defaultConfigProvider;
    this.urnPrefix = config.urnPrefix ?? "urn";
    this.logger = config.logger ?? defaultLogger;
    this.rampSampler = config.rampSampler ?? randomRampSampler;
    this.metrics =
      config.metrics === false
        ? null
        : config.metrics ??
          createPrometheusGCacheMetrics({
            prefix: config.metricsPrefix ?? "",
            ...(config.metricsRegistry === undefined ? {} : { registry: config.metricsRegistry }),
          });
    this.localCache = new LocalCache(this.configProvider, this.rampSampler, config.localMaxSize ?? DEFAULT_LOCAL_MAX_SIZE);
    this.redisCache =
      config.redis === undefined
        ? null
        : new RedisCache({
            configProvider: this.configProvider,
            rampSampler: this.rampSampler,
            redis: config.redis,
            metrics: this.metrics,
          });
  }

  enable<T>(fn: () => Awaitable<T>): Promise<T> {
    return this.context.enable(fn);
  }

  disable<T>(fn: () => Awaitable<T>): Promise<T> {
    return this.context.disable(fn);
  }

  withEnabled<T>(fn: () => Awaitable<T>): Promise<T> {
    return this.enable(fn);
  }

  withDisabled<T>(fn: () => Awaitable<T>): Promise<T> {
    return this.disable(fn);
  }

  isEnabled(): boolean {
    return this.context.isEnabled();
  }

  cached<Args extends CacheableArgs>(
    options: CachedOptions<Args>,
  ): <Value>(fn: (...args: Args) => Awaitable<Value>) => (...args: Args) => Promise<Value> {
    this.registerUseCase(options.useCase);

    return <Value>(fn: (...args: Args) => Awaitable<Value>) => {
      return async (...args: Args): Promise<Value> => {
        if (!this.isEnabled()) {
          this.metrics?.disabled({
            useCase: options.useCase,
            keyType: options.keyType,
            layer: "noop",
            reason: "context",
          });
          return await fn(...args);
        }

        let key: GCacheKey;
        try {
          key = this.createKey(options, args);
        } catch (error) {
          this.logger.error("Could not construct GCache key", error);
          this.metrics?.error({
            useCase: options.useCase,
            keyType: options.keyType,
            layer: "noop",
            error: errorName(error),
            inFallback: false,
          });
          return await this.callFallback({ useCase: options.useCase, keyType: options.keyType, layer: "noop" }, async () => await fn(...args));
        }

        if (this.redisCache === null) {
          return await this.getThroughLocalOnly(key, async () => await fn(...args));
        }

        return await this.getThroughRedisChain(key, async () => await fn(...args));
      };
    };
  }

  async delete(key: GCacheKey): Promise<boolean> {
    this.metrics?.invalidation({ keyType: key.keyType, layer: CacheLayer.LOCAL });
    const localDeleted = await this.localCache.delete(key);
    if (this.redisCache === null) {
      return localDeleted;
    }

    this.metrics?.invalidation({ keyType: key.keyType, layer: CacheLayer.REMOTE });
    try {
      return (await this.redisCache.delete(key)) || localDeleted;
    } catch (error) {
      this.logger.warn("Error deleting value from Redis cache", error);
      this.recordError(key, CacheLayer.REMOTE, error, false);
      return localDeleted;
    }
  }

  async invalidate(keyType: string, id: string | number | bigint, options: InvalidateOptions = {}): Promise<void> {
    if (this.redisCache === null) {
      return;
    }

    this.metrics?.invalidation({ keyType, layer: CacheLayer.REMOTE });
    try {
      await this.redisCache.invalidate(keyType, String(id), options.futureBufferMs ?? 0, this.urnPrefix);
    } catch (error) {
      this.logger.warn("Error writing GCache invalidation watermark", error);
      this.metrics?.error({
        useCase: "watermark",
        keyType,
        layer: CacheLayer.REMOTE,
        error: errorName(error),
        inFallback: false,
      });
    }
  }

  async flushAll(): Promise<void> {
    await this.localCache.flushAll();
    if (this.redisCache === null) {
      return;
    }

    try {
      await this.redisCache.flushAll();
    } catch (error) {
      this.logger.warn("Error flushing Redis cache", error);
      this.metrics?.error({
        useCase: "flushAll",
        keyType: "all",
        layer: CacheLayer.REMOTE,
        error: errorName(error),
        inFallback: false,
      });
    }
  }

  private async getThroughLocalOnly<T>(key: GCacheKey, fallback: () => Promise<T>): Promise<T> {
    const local = await this.readLocal<T>(key);
    if (local.status === "hit") {
      return local.value;
    }

    const value = await this.callFallback(labelsFor(key, CacheLayer.LOCAL), fallback);
    if (local.status === "miss") {
      await this.putLocalFailOpen(key, value);
    }
    return value;
  }

  private async getThroughRedisChain<T>(key: GCacheKey, fallback: () => Promise<T>): Promise<T> {
    const local = await this.readLocal<T>(key);
    if (local.status === "hit") {
      return local.value;
    }

    const remote = await this.readRemote<T>(key);
    if (remote.status === "hit") {
      await this.putLocalFailOpen(key, remote.value);
      return remote.value;
    }

    const remoteErrored = remote.status === "disabled" && remote.reason === "config_error";
    const fallbackLayer = remote.status === "miss" || remoteErrored ? CacheLayer.REMOTE : CacheLayer.LOCAL;
    const value = await this.callFallback(labelsFor(key, fallbackLayer), fallback);
    const skipCacheWrite = (remote.status === "miss" || remote.status === "disabled") && remote.skipCacheWrite === true;
    if (!skipCacheWrite && (remote.status === "miss" || remoteErrored)) {
      try {
        await this.redisCache?.put(key, value);
      } catch (error) {
        this.logger.warn("Error putting value in Redis cache", error);
        this.recordError(key, CacheLayer.REMOTE, error, false);
      }
    }
    if (!skipCacheWrite) {
      await this.putLocalFailOpen(key, value);
    }
    return value;
  }

  private async readLocal<T>(key: GCacheKey) {
    const start = performance.now();
    try {
      const result = await this.localCache.getIfPresentResult<T>(key);
      if (result.status === "disabled") {
        this.metrics?.disabled({ ...labelsFor(key, CacheLayer.LOCAL), reason: result.reason });
        return result;
      }

      this.metrics?.request(labelsFor(key, CacheLayer.LOCAL));
      this.metrics?.observeGet(labelsFor(key, CacheLayer.LOCAL), elapsedSeconds(start));
      if (result.status === "miss") {
        this.metrics?.miss(labelsFor(key, CacheLayer.LOCAL));
      }
      return result;
    } catch (error) {
      this.logger.error("Error getting value from local cache", error);
      this.recordError(key, CacheLayer.LOCAL, error, false);
      this.metrics?.disabled({ ...labelsFor(key, CacheLayer.LOCAL), reason: "config_error" });
      return { status: "disabled", reason: "config_error" } as const;
    }
  }

  private async readRemote<T>(key: GCacheKey) {
    const start = performance.now();
    try {
      const result = await this.redisCache?.getResult<T>(key);
      if (result === undefined) {
        return { status: "disabled", reason: "missing_config" } as const;
      }
      if (result.status === "disabled") {
        this.metrics?.disabled({ ...labelsFor(key, CacheLayer.REMOTE), reason: result.reason });
        return result;
      }

      this.metrics?.request(labelsFor(key, CacheLayer.REMOTE));
      this.metrics?.observeGet(labelsFor(key, CacheLayer.REMOTE), elapsedSeconds(start));
      if (result.status === "miss") {
        this.metrics?.miss(labelsFor(key, CacheLayer.REMOTE));
      }
      return result;
    } catch (error) {
      this.logger.warn("Error getting value from Redis cache", error);
      this.recordError(key, CacheLayer.REMOTE, error, false);
      return { status: "disabled", reason: "config_error", ...(key.trackForInvalidation ? { skipCacheWrite: true } : {}) } as const;
    }
  }

  private async putLocalFailOpen<T>(key: GCacheKey, value: T): Promise<void> {
    try {
      await this.localCache.put(key, value);
    } catch (error) {
      this.logger.warn("Error putting value in local cache", error);
      this.recordError(key, CacheLayer.LOCAL, error, false);
    }
  }

  private async callFallback<T>(labels: CacheMetricLabels, fallback: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fallback();
    } catch (error) {
      this.metrics?.error({ ...labels, error: errorName(error), inFallback: true });
      throw error;
    } finally {
      this.metrics?.observeFallback(labels, elapsedSeconds(start));
    }
  }

  private recordError(key: GCacheKey, layer: CacheLayer, error: unknown, inFallback: boolean): void {
    this.metrics?.error({ ...labelsFor(key, layer), error: errorName(error), inFallback });
  }

  private registerUseCase(useCase: string): void {
    if (useCase === "watermark") {
      throw new UseCaseNameIsReservedError(useCase);
    }
    if (this.useCases.has(useCase)) {
      throw new UseCaseIsAlreadyRegisteredError(useCase);
    }
    this.useCases.add(useCase);
  }

  private createKey<Args extends CacheableArgs>(options: CachedOptions<Args>, args: Args): GCacheKey {
    return new GCacheKey({
      keyType: options.keyType,
      id: String(options.id(args)),
      useCase: options.useCase,
      args: normalizeArgs(options.args?.(args) ?? {}),
      urnPrefix: this.urnPrefix,
      defaultConfig: options.defaultConfig ?? null,
      serializer: (options.serializer as Serializer<unknown> | null | undefined) ?? null,
      trackForInvalidation: options.trackForInvalidation ?? false,
    });
  }
}

function elapsedSeconds(startMs: number): number {
  return Math.max((performance.now() - startMs) / 1000, 0);
}
