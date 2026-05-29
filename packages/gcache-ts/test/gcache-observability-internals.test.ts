import { describe, expect, it, vi } from "vitest";

import { CacheLayer, GCacheKey, GCacheKeyConfig, type RedisCommandClient, type RedisStoredValue } from "../src/index.js";
import { LocalCache } from "../src/internal/local-cache.js";
import { RedisCache, type RedisValueEnvelope } from "../src/internal/redis-cache.js";
import { resolveLayerConfig } from "../src/internal/runtime-config.js";
import { errorName } from "../src/metrics.js";

class MemoryRedis implements RedisCommandClient {
  readonly values = new Map<string, RedisStoredValue>();

  async get(key: string): Promise<RedisStoredValue | null> {
    return this.values.get(key) ?? null;
  }

  async setEx(key: string, _ttlSec: number, value: RedisStoredValue): Promise<void> {
    this.values.set(key, value);
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }
}

const key = (defaultConfig: GCacheKeyConfig | null = GCacheKeyConfig.enabled(60)) =>
  new GCacheKey({ keyType: "user_id", id: "123", useCase: "ObservabilityInternals", defaultConfig });

describe("GCache observability internal compatibility paths", () => {
  it("keeps LocalCache get/getIfPresent compatibility while exposing disabled reads", async () => {
    // Given a local cache with enabled config and a second key with no config.
    const cache = new LocalCache(async () => null, () => 0, 10);
    const enabledKey = key();
    const disabledKey = key(null);
    let calls = 0;

    // When get() populates a value and getIfPresent() reads it back.
    const first = await cache.get(enabledKey, async () => ({ calls: ++calls }));
    const hit = await cache.getIfPresent<{ calls: number }>(enabledKey);
    const disabled = await cache.getIfPresentResult(disabledKey);

    // Then compatibility helpers still behave like the pre-metrics API, and disabled state is explicit.
    expect(first).toEqual({ calls: 1 });
    expect(hit).toEqual({ calls: 1 });
    expect(disabled).toEqual({ status: "disabled", reason: "missing_config" });
    expect(calls).toBe(1);
  });

  it("keeps RedisCache get compatibility and skips writes when remote config is disabled", async () => {
    // Given a Redis cache with one valid stored envelope and one key without remote config.
    const redis = new MemoryRedis();
    const redisCache = new RedisCache({
      configProvider: async () => null,
      rampSampler: () => 0,
      redis: { client: redis },
      metrics: null,
    });
    const enabledKey = key();
    const disabledKey = new GCacheKey({
      keyType: "user_id",
      id: "456",
      useCase: "ObservabilityInternals",
      defaultConfig: new GCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 60 },
        ramp: { [CacheLayer.LOCAL]: 100 },
      }),
    });
    redis.values.set(
      enabledKey.urn,
      JSON.stringify({
        version: 1,
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
        encoding: "utf8",
        payload: JSON.stringify({ source: "redis" }),
      } satisfies RedisValueEnvelope),
    );

    // When the compatibility get() reads Redis and put() sees disabled remote config.
    const hit = await redisCache.get<{ source: string }>(enabledKey);
    await redisCache.put(disabledKey, { source: "fallback" });

    // Then get() unwraps the value and the disabled remote write is skipped.
    expect(hit).toEqual({ source: "redis" });
    expect(redis.values.has(disabledKey.urn)).toBe(false);
  });

  it("preserves runtime-config and error-name edge behavior used by metrics", async () => {
    // Given configs for missing ramp and non-finite ramp samples.
    const missingRamp = new GCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: 60 }, ramp: {} });
    const partialRamp = new GCacheKeyConfig({
      ttlSec: { [CacheLayer.LOCAL]: 60 },
      ramp: { [CacheLayer.LOCAL]: 50 },
    });

    // When runtime config is resolved through compatibility and sampled disabled paths.
    const noConfig = await resolveLayerConfig({
      configProvider: async () => null,
      key: key(null),
      layer: CacheLayer.LOCAL,
      rampSampler: vi.fn(),
    });
    const noRamp = await resolveLayerConfig({
      configProvider: async () => missingRamp,
      key: key(),
      layer: CacheLayer.LOCAL,
      rampSampler: vi.fn(),
    });
    const nonFiniteSample = await resolveLayerConfig({
      configProvider: async () => partialRamp,
      key: key(),
      layer: CacheLayer.LOCAL,
      rampSampler: () => Number.NaN,
    });

    // Then disabled config returns null and non-Error throws get stable metric labels.
    expect(noConfig).toBeNull();
    expect(noRamp).toBeNull();
    expect(nonFiniteSample).toBeNull();
    expect(errorName("string failure")).toBe("string");
  });
});
