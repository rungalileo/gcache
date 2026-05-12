import { CacheLayer, type CacheConfigProvider, type CacheRampSampler } from "../config.js";
import type { GCacheKey } from "../key.js";
import type { CacheGetResult } from "./cache-result.js";
import { resolveLayerConfigResult } from "./runtime-config.js";

export type Fallback<T> = () => Promise<T>;

interface LocalEntry<T> {
  readonly expiresAtMs: number;
  readonly value: T;
}

export class LocalCache {
  private readonly caches = new Map<string, Map<string, LocalEntry<unknown>>>();

  constructor(
    private readonly configProvider: CacheConfigProvider,
    private readonly rampSampler: CacheRampSampler,
    private readonly maxSize: number,
  ) {}

  async get<T>(key: GCacheKey, fallback: Fallback<T>): Promise<T> {
    const result = await this.getIfPresentResult<T>(key);
    if (result.status === "hit") {
      return result.value;
    }

    const value = await fallback();
    if (result.status === "miss") {
      await this.put(key, value);
    }
    return value;
  }

  async getIfPresent<T>(key: GCacheKey): Promise<T | undefined> {
    const result = await this.getIfPresentResult<T>(key);
    return result.status === "hit" ? result.value : undefined;
  }

  async getIfPresentResult<T>(key: GCacheKey): Promise<CacheGetResult<T>> {
    const layerConfig = await this.resolveLocalLayerConfig(key);
    if (layerConfig.status === "disabled") {
      return layerConfig;
    }

    const cache = this.caches.get(key.useCase);
    const now = Date.now();
    const hit = cache?.get(key.urn) as LocalEntry<T> | undefined;

    if (hit !== undefined && hit.expiresAtMs > now) {
      return { status: "hit", value: hit.value };
    }

    if (hit !== undefined) {
      cache?.delete(key.urn);
    }

    return { status: "miss" };
  }

  async put<T>(key: GCacheKey, value: T): Promise<void> {
    const layerConfig = await this.resolveLocalLayerConfig(key);
    if (layerConfig.status === "disabled") {
      return;
    }

    const cache = this.getOrCreateUseCaseCache(key);
    cache.set(key.urn, { expiresAtMs: Date.now() + layerConfig.config.ttlSec * 1000, value });
    this.evictOldestIfNeeded(cache);
  }

  async delete(key: GCacheKey): Promise<boolean> {
    const cache = this.caches.get(key.useCase);
    return cache?.delete(key.urn) ?? false;
  }

  async flushAll(): Promise<void> {
    this.caches.clear();
  }

  private getOrCreateUseCaseCache(key: GCacheKey): Map<string, LocalEntry<unknown>> {
    let cache = this.caches.get(key.useCase);
    if (cache === undefined) {
      cache = new Map<string, LocalEntry<unknown>>();
      this.caches.set(key.useCase, cache);
    }
    return cache;
  }

  private async resolveLocalLayerConfig(key: GCacheKey) {
    return await resolveLayerConfigResult({
      configProvider: this.configProvider,
      key,
      layer: CacheLayer.LOCAL,
      rampSampler: this.rampSampler,
    });
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
