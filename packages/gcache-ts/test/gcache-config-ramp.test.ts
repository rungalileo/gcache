import { describe, expect, it, vi } from "vitest";

import { CacheLayer, GCache, GCacheKeyConfig, type RedisCommandClient, type RedisStoredValue } from "../src/index.js";

class FakeRedis implements RedisCommandClient {
  readonly values = new Map<string, RedisStoredValue>();
  getCalls = 0;
  setCalls = 0;

  async get(key: string): Promise<RedisStoredValue | null> {
    this.getCalls += 1;
    return this.values.get(key) ?? null;
  }

  async setEx(key: string, _ttlSec: number, value: RedisStoredValue): Promise<void> {
    this.setCalls += 1;
    this.values.set(key, value);
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }
}

const configFor = (ttlSec: Partial<Record<CacheLayer, number>>, ramp: Partial<Record<CacheLayer, number>>) =>
  new GCacheKeyConfig({ ttlSec, ramp });

describe("GCache runtime config and ramp controls", () => {
  it("falls back to decorator defaultConfig when the provider returns null", async () => {
    // Given a runtime config provider that has no dynamic config for this key.
    const cacheConfigProvider = vi.fn(async () => null);
    const gcache = new GCache({ cacheConfigProvider });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "ProviderFallbackDefaultConfig",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When the same key is read twice inside an enabled scope.
    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));

    // Then the decorator defaultConfig keeps the local cache active.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(calls).toBe(1);
    expect(cacheConfigProvider).toHaveBeenCalled();
  });

  it("applies runtime config changes to subsequent calls", async () => {
    // Given a provider whose config can change without redeploying the cached function.
    let runtimeConfig: GCacheKeyConfig | null = GCacheKeyConfig.enabled(60);
    const gcache = new GCache({ cacheConfigProvider: async () => runtimeConfig });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "DynamicProviderConfig",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When the provider disables local caching after the first cached read.
    const first = await gcache.enable(async () => await getUser("123"));
    runtimeConfig = configFor({}, {});
    const second = await gcache.enable(async () => await getUser("123"));

    // Then the second call honors the new disabled config instead of returning the existing local entry.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect(calls).toBe(2);
  });

  it("treats ramp 0 and 100 as deterministic layer controls", async () => {
    // Given one local key is ramped out and another is fully ramped in.
    const rampSampler = vi.fn(() => {
      throw new Error("0/100 ramps should not need random sampling");
    });
    const gcache = new GCache({ rampSampler });
    let disabledCalls = 0;
    const disabled = gcache.cached({
      keyType: "user_id",
      useCase: "LocalRampZero",
      id: ([userId]: [string]) => userId,
      defaultConfig: configFor({ [CacheLayer.LOCAL]: 60 }, { [CacheLayer.LOCAL]: 0 }),
    })(async (userId: string) => ({ userId, calls: ++disabledCalls }));
    let enabledCalls = 0;
    const enabled = gcache.cached({
      keyType: "user_id",
      useCase: "LocalRampHundred",
      id: ([userId]: [string]) => userId,
      defaultConfig: configFor({ [CacheLayer.LOCAL]: 60 }, { [CacheLayer.LOCAL]: 100 }),
    })(async (userId: string) => ({ userId, calls: ++enabledCalls }));

    // When each key is read twice.
    const disabledFirst = await gcache.enable(async () => await disabled("123"));
    const disabledSecond = await gcache.enable(async () => await disabled("123"));
    const enabledFirst = await gcache.enable(async () => await enabled("456"));
    const enabledSecond = await gcache.enable(async () => await enabled("456"));

    // Then ramp 0 disables the layer, ramp 100 enables it, and neither path samples randomness.
    expect(disabledFirst).toEqual({ userId: "123", calls: 1 });
    expect(disabledSecond).toEqual({ userId: "123", calls: 2 });
    expect(enabledFirst).toEqual({ userId: "456", calls: 1 });
    expect(enabledSecond).toEqual({ userId: "456", calls: 1 });
    expect(rampSampler).not.toHaveBeenCalled();
  });

  it("uses the injected sampler to make ramp 50 behavior testable", async () => {
    // Given one sampler lands inside ramp 50 and another lands just outside it.
    const passingSampler = vi.fn(() => 49);
    const blockedSampler = vi.fn(() => 50);
    const passingCache = new GCache({ rampSampler: passingSampler });
    const blockedCache = new GCache({ rampSampler: blockedSampler });
    let passingCalls = 0;
    const passing = passingCache.cached({
      keyType: "user_id",
      useCase: "LocalRampFiftyPassing",
      id: ([userId]: [string]) => userId,
      defaultConfig: configFor({ [CacheLayer.LOCAL]: 60 }, { [CacheLayer.LOCAL]: 50 }),
    })(async (userId: string) => ({ userId, calls: ++passingCalls }));
    let blockedCalls = 0;
    const blocked = blockedCache.cached({
      keyType: "user_id",
      useCase: "LocalRampFiftyBlocked",
      id: ([userId]: [string]) => userId,
      defaultConfig: configFor({ [CacheLayer.LOCAL]: 60 }, { [CacheLayer.LOCAL]: 50 }),
    })(async (userId: string) => ({ userId, calls: ++blockedCalls }));

    // When both caches read the same key twice.
    const passingFirst = await passingCache.enable(async () => await passing("123"));
    const passingSecond = await passingCache.enable(async () => await passing("123"));
    const blockedFirst = await blockedCache.enable(async () => await blocked("123"));
    const blockedSecond = await blockedCache.enable(async () => await blocked("123"));

    // Then the sampled-in key caches and the sampled-out key falls through.
    expect(passingFirst).toEqual({ userId: "123", calls: 1 });
    expect(passingSecond).toEqual({ userId: "123", calls: 1 });
    expect(blockedFirst).toEqual({ userId: "123", calls: 1 });
    expect(blockedSecond).toEqual({ userId: "123", calls: 2 });
    expect(passingSampler).toHaveBeenCalledWith(expect.objectContaining({ layer: CacheLayer.LOCAL, ramp: 50 }));
    expect(blockedSampler).toHaveBeenCalledWith(expect.objectContaining({ layer: CacheLayer.LOCAL, ramp: 50 }));
  });

  it("uses the injected sampler for remote ramp 50 behavior", async () => {
    // Given remote-only config with one sampler inside ramp 50 and another just outside it.
    const passingRedis = new FakeRedis();
    const blockedRedis = new FakeRedis();
    const passingSampler = vi.fn(() => 49);
    const blockedSampler = vi.fn(() => 50);
    const passingCache = new GCache({
      redis: { client: passingRedis },
      rampSampler: passingSampler,
      cacheConfigProvider: async () => configFor({ [CacheLayer.REMOTE]: 60 }, { [CacheLayer.REMOTE]: 50 }),
    });
    const blockedCache = new GCache({
      redis: { client: blockedRedis },
      rampSampler: blockedSampler,
      cacheConfigProvider: async () => configFor({ [CacheLayer.REMOTE]: 60 }, { [CacheLayer.REMOTE]: 50 }),
    });
    let passingCalls = 0;
    const passing = passingCache.cached({
      keyType: "user_id",
      useCase: "RemoteRampFiftyPassing",
      id: ([userId]: [string]) => userId,
    })(async (userId: string) => ({ userId, calls: ++passingCalls }));
    let blockedCalls = 0;
    const blocked = blockedCache.cached({
      keyType: "user_id",
      useCase: "RemoteRampFiftyBlocked",
      id: ([userId]: [string]) => userId,
    })(async (userId: string) => ({ userId, calls: ++blockedCalls }));

    // When both remote-only caches read the same key twice.
    const passingFirst = await passingCache.enable(async () => await passing("123"));
    const passingSecond = await passingCache.enable(async () => await passing("123"));
    const blockedFirst = await blockedCache.enable(async () => await blocked("123"));
    const blockedSecond = await blockedCache.enable(async () => await blocked("123"));

    // Then the sampled-in key uses Redis and the sampled-out key never touches Redis.
    expect(passingFirst).toEqual({ userId: "123", calls: 1 });
    expect(passingSecond).toEqual({ userId: "123", calls: 1 });
    expect(blockedFirst).toEqual({ userId: "123", calls: 1 });
    expect(blockedSecond).toEqual({ userId: "123", calls: 2 });
    expect(passingRedis.getCalls).toBe(2);
    expect(passingRedis.setCalls).toBe(1);
    expect(blockedRedis.getCalls).toBe(0);
    expect(blockedRedis.setCalls).toBe(0);
    expect(passingSampler).toHaveBeenCalledWith(expect.objectContaining({ layer: CacheLayer.REMOTE, ramp: 50 }));
    expect(blockedSampler).toHaveBeenCalledWith(expect.objectContaining({ layer: CacheLayer.REMOTE, ramp: 50 }));
  });

  it("disables missing local config while allowing the remote layer to work", async () => {
    // Given runtime config only enables the remote layer.
    const redis = new FakeRedis();
    const gcache = new GCache({
      redis: { client: redis },
      cacheConfigProvider: async () => configFor({ [CacheLayer.REMOTE]: 60 }, { [CacheLayer.REMOTE]: 100 }),
    });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "RemoteOnlyRuntimeConfig",
      id: ([userId]: [string]) => userId,
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When the same key is read twice through a Redis-backed cache.
    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));

    // Then local is skipped, Redis stores the fallback, and the second read comes from Redis.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(calls).toBe(1);
    expect(redis.getCalls).toBe(2);
    expect(redis.setCalls).toBe(1);
  });

  it("disables missing remote config while allowing the local layer to work", async () => {
    // Given Redis exists but runtime config only enables the local layer.
    const redis = new FakeRedis();
    const gcache = new GCache({
      redis: { client: redis },
      cacheConfigProvider: async () => configFor({ [CacheLayer.LOCAL]: 60 }, { [CacheLayer.LOCAL]: 100 }),
    });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "LocalOnlyRuntimeConfig",
      id: ([userId]: [string]) => userId,
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When the same key is read twice through a Redis-backed cache.
    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));

    // Then Redis is skipped and the second read comes from local cache.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(calls).toBe(1);
    expect(redis.getCalls).toBe(0);
    expect(redis.setCalls).toBe(0);
  });

  it("fails open when the runtime config provider throws", async () => {
    // Given the runtime config provider is temporarily unavailable.
    const providerError = new Error("config provider unavailable");
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const gcache = new GCache({
      logger,
      cacheConfigProvider: vi.fn(async () => {
        throw providerError;
      }),
    });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "ConfigProviderThrows",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When the cached function is called while config lookup fails.
    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));

    // Then no provider error escapes and no value is accidentally cached.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect(logger.error).toHaveBeenCalledWith("Error getting value from local cache", providerError);
  });
});
