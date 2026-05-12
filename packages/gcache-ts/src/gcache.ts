import { GCacheConfig, type CacheConfigProvider, type Logger } from "./config.js";
import { GCacheContext } from "./context.js";
import { UseCaseIsAlreadyRegisteredError, UseCaseNameIsReservedError } from "./errors.js";
import { GCacheKey, normalizeArgs } from "./key.js";
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
  private readonly redisCache: RedisCache | null;

  constructor(config: GCacheConfig = {}) {
    this.configProvider = config.cacheConfigProvider ?? defaultConfigProvider;
    this.urnPrefix = config.urnPrefix ?? "urn";
    this.logger = config.logger ?? defaultLogger;
    this.localCache = new LocalCache(this.configProvider, config.localMaxSize ?? DEFAULT_LOCAL_MAX_SIZE);
    this.redisCache = config.redis === undefined ? null : new RedisCache({ configProvider: this.configProvider, redis: config.redis });
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
          return await fn(...args);
        }

        let key: GCacheKey;
        try {
          key = this.createKey(options, args);
        } catch (error) {
          this.logger.error("Could not construct GCache key", error);
          return await fn(...args);
        }

        if (this.redisCache === null) {
          try {
            return await this.localCache.get(key, async () => await fn(...args));
          } catch (error) {
            this.logger.error("Error getting value from local cache", error);
            return await fn(...args);
          }
        }

        return await this.getThroughRedisChain(key, async () => await fn(...args));
      };
    };
  }

  async delete(key: GCacheKey): Promise<boolean> {
    const localDeleted = await this.localCache.delete(key);
    if (this.redisCache === null) {
      return localDeleted;
    }

    try {
      return (await this.redisCache.delete(key)) || localDeleted;
    } catch (error) {
      this.logger.warn("Error deleting value from Redis cache", error);
      return localDeleted;
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
    }
  }

  private async getThroughRedisChain<T>(key: GCacheKey, fallback: () => Promise<T>): Promise<T> {
    try {
      const localHit = await this.localCache.getIfPresent<T>(key);
      if (localHit !== undefined) {
        return localHit;
      }
    } catch (error) {
      this.logger.warn("Error getting value from local cache", error);
    }

    try {
      const redisHit = await this.redisCache?.get<T>(key);
      if (redisHit !== undefined) {
        await this.putLocalFailOpen(key, redisHit);
        return redisHit;
      }
    } catch (error) {
      this.logger.warn("Error getting value from Redis cache", error);
    }

    const value = await fallback();
    try {
      await this.redisCache?.put(key, value);
    } catch (error) {
      this.logger.warn("Error putting value in Redis cache", error);
    }
    await this.putLocalFailOpen(key, value);
    return value;
  }

  private async putLocalFailOpen<T>(key: GCacheKey, value: T): Promise<void> {
    try {
      await this.localCache.put(key, value);
    } catch (error) {
      this.logger.warn("Error putting value in local cache", error);
    }
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
    });
  }
}
