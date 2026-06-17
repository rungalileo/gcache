import { LRUCache } from "lru-cache";

import { CacheLayer, type CacheConfigProvider, type CacheRampSampler } from "../config.js";
import type { GCacheKey } from "../key.js";
import type { CacheGetResult } from "./cache-result.js";
import { resolveLayerConfigResult } from "./runtime-config.js";

export type Fallback<T> = () => Promise<T>;

// Each entry carries its own expiry. TTL is enforced with `Date.now()` (consistent
// with the Redis layer and mockable in tests) rather than lru-cache's internal
// `performance.now()` clock; lru-cache handles only LRU + max-size eviction. The
// wrapper is always defined, so an `undefined` fallback result stays cacheable
// (`LRUCache.set(key, undefined)` is an alias for `delete`).
interface CachedEntry<T> {
  readonly value: T;
  readonly expiresAtMs: number;
}

export class LocalCache {
  // A single LRU keyed by the fully-qualified URN (which already encodes the use
  // case). One global instance bounds total local memory and gives true LRU
  // eviction across all use cases.
  private readonly cache: LRUCache<string, CachedEntry<unknown>>;

  constructor(
    private readonly configProvider: CacheConfigProvider,
    private readonly rampSampler: CacheRampSampler,
    maxSize: number,
  ) {
    this.cache = new LRUCache<string, CachedEntry<unknown>>({ max: maxSize });
  }

  async get<T>(key: GCacheKey, fallback: Fallback<T>): Promise<T> {
    const result = await this.getIfPresentResult<T>(key);
    if (result.status === "hit") {
      return result.value;
    }

    const value = await fallback();
    if (result.status === "miss") {
      await this.put(key, value, result.config);
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

    const hit = this.cache.get(key.urn) as CachedEntry<T> | undefined;
    if (hit !== undefined && hit.expiresAtMs > Date.now()) {
      return { status: "hit", value: hit.value };
    }

    if (hit !== undefined) {
      this.cache.delete(key.urn);
    }

    return { status: "miss", config: layerConfig.config };
  }

  async put<T>(key: GCacheKey, value: T, config?: { readonly ttlSec: number }): Promise<void> {
    const ttlSec = config?.ttlSec ?? (await this.resolveLocalTtlSec(key));
    if (ttlSec === null) {
      return;
    }

    this.cache.set(key.urn, { value, expiresAtMs: Date.now() + ttlSec * 1000 });
  }

  async delete(key: GCacheKey): Promise<boolean> {
    return this.cache.delete(key.urn);
  }

  async flushAll(): Promise<void> {
    this.cache.clear();
  }

  private async resolveLocalLayerConfig(key: GCacheKey) {
    return await resolveLayerConfigResult({
      configProvider: this.configProvider,
      key,
      layer: CacheLayer.LOCAL,
      rampSampler: this.rampSampler,
    });
  }

  private async resolveLocalTtlSec(key: GCacheKey): Promise<number | null> {
    const layerConfig = await this.resolveLocalLayerConfig(key);
    return layerConfig.status === "enabled" ? layerConfig.config.ttlSec : null;
  }
}
