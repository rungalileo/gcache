import { CacheLayer, type CacheConfigProvider, type CacheRampSampler } from "../config.js";
import type { GCacheKey } from "../key.js";

export interface ResolvedLayerConfig {
  readonly ttlSec: number;
  readonly ramp: number;
}

interface ResolveLayerConfigOptions {
  readonly configProvider: CacheConfigProvider;
  readonly key: GCacheKey;
  readonly layer: CacheLayer;
  readonly rampSampler: CacheRampSampler;
}

export async function resolveLayerConfig(options: ResolveLayerConfigOptions): Promise<ResolvedLayerConfig | null> {
  const config = (await options.configProvider(options.key)) ?? options.key.defaultConfig;
  if (config === null) {
    return null;
  }

  const ttlSec = config.ttlSec[options.layer];
  if (ttlSec === undefined || ttlSec <= 0) {
    return null;
  }

  const ramp = clampPercentage(config.ramp[options.layer] ?? 0);
  if (ramp <= 0) {
    return null;
  }
  if (ramp >= 100) {
    return { ttlSec, ramp };
  }

  const sample = await options.rampSampler({ key: options.key, layer: options.layer, ramp });
  if (!Number.isFinite(sample)) {
    return null;
  }

  return clampPercentage(sample) < ramp ? { ttlSec, ramp } : null;
}

function clampPercentage(value: number): number {
  if (value <= 0) {
    return 0;
  }
  if (value >= 100) {
    return 100;
  }
  return value;
}
