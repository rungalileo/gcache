import { CacheLayer, type CacheConfigProvider, type GCacheKeyConfig } from "../config.js";
import { MissingKeyConfigError } from "../errors.js";
import type { GCacheKey } from "../key.js";

export type Fallback<T> = () => Promise<T>;

interface LocalEntry<T> {
  readonly expiresAtMs: number;
  readonly value: T;
}

export class LocalCache {
  private readonly caches = new Map<string, Map<string, LocalEntry<unknown>>>();

  constructor(
    private readonly configProvider: CacheConfigProvider,
    private readonly maxSize: number,
  ) {}

  async get<T>(key: GCacheKey, fallback: Fallback<T>): Promise<T> {
    const hit = await this.getIfPresent<T>(key);
    if (hit !== undefined) {
      return hit;
    }

    const value = await fallback();
    await this.put(key, value);
    return value;
  }

  async getIfPresent<T>(key: GCacheKey): Promise<T | undefined> {
    const cache = await this.getUseCaseCache(key);
    const now = Date.now();
    const hit = cache.get(key.urn) as LocalEntry<T> | undefined;

    if (hit !== undefined && hit.expiresAtMs > now) {
      return hit.value;
    }

    if (hit !== undefined) {
      cache.delete(key.urn);
    }

    return undefined;
  }

  async put<T>(key: GCacheKey, value: T): Promise<void> {
    const cache = await this.getUseCaseCache(key);
    const ttlSec = await this.resolveLocalTtl(key);
    cache.set(key.urn, { expiresAtMs: Date.now() + ttlSec * 1000, value });
    this.evictOldestIfNeeded(cache);
  }

  async delete(key: GCacheKey): Promise<boolean> {
    const cache = this.caches.get(key.useCase);
    return cache?.delete(key.urn) ?? false;
  }

  async flushAll(): Promise<void> {
    this.caches.clear();
  }

  private async getUseCaseCache(key: GCacheKey): Promise<Map<string, LocalEntry<unknown>>> {
    await this.resolveLocalTtl(key);
    let cache = this.caches.get(key.useCase);
    if (cache === undefined) {
      cache = new Map<string, LocalEntry<unknown>>();
      this.caches.set(key.useCase, cache);
    }
    return cache;
  }

  private async resolveLocalTtl(key: GCacheKey): Promise<number> {
    const config = await this.resolveConfig(key);
    const ttlSec = config.ttlSec[CacheLayer.LOCAL];
    if (ttlSec === undefined || ttlSec <= 0) {
      throw new MissingKeyConfigError(key.useCase);
    }
    return ttlSec;
  }

  private async resolveConfig(key: GCacheKey): Promise<GCacheKeyConfig> {
    const config = (await this.configProvider(key)) ?? key.defaultConfig;
    if (config === null) {
      throw new MissingKeyConfigError(key.useCase);
    }
    return config;
  }

  private evictOldestIfNeeded(cache: Map<string, LocalEntry<unknown>>): void {
    while (cache.size > this.maxSize) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        return;
      }
      cache.delete(oldestKey);
    }
  }
}
