import type { GCacheKey } from "./key.js";

export enum CacheLayer {
  NOOP = "noop",
  LOCAL = "local",
  REMOTE = "remote",
}

export type LayerConfig = Partial<Record<CacheLayer, number>>;

export class GCacheKeyConfig {
  readonly ttlSec: LayerConfig;
  readonly ramp: LayerConfig;

  constructor(config: { ttlSec: LayerConfig; ramp: LayerConfig }) {
    this.ttlSec = { ...config.ttlSec };
    this.ramp = { ...config.ramp };
  }

  static enabled(ttlSec: number): GCacheKeyConfig {
    return new GCacheKeyConfig({
      ttlSec: {
        [CacheLayer.LOCAL]: ttlSec,
        [CacheLayer.REMOTE]: ttlSec,
        [CacheLayer.NOOP]: ttlSec,
      },
      ramp: {
        [CacheLayer.LOCAL]: 100,
        [CacheLayer.REMOTE]: 100,
        [CacheLayer.NOOP]: 100,
      },
    });
  }
}

export type CacheConfigProvider = (key: GCacheKey) => Promise<GCacheKeyConfig | null>;

export type Logger = Pick<Console, "debug" | "error" | "warn">;

export interface GCacheConfig {
  readonly cacheConfigProvider?: CacheConfigProvider;
  readonly urnPrefix?: string;
  readonly logger?: Logger;
  readonly localMaxSize?: number;
}
