import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DEFAULT_WATERMARK_TTL_SEC,
  GCache,
  GCacheKey,
  GCacheKeyConfig,
  invalidationPrefix,
  redisClusterHashTag,
  type CacheMetricLabels,
  type DisabledMetricLabels,
  type ErrorMetricLabels,
  type GCacheMetricsAdapter,
  type InvalidationMetricLabels,
  type RedisCommandClient,
  type RedisStoredValue,
  type RedisValueEnvelope,
  type SerializationMetricLabels,
} from "../src/index.js";
import { RedisCache } from "../src/internal/redis-cache.js";

class FakeRedis implements RedisCommandClient {
  readonly values = new Map<string, { value: RedisStoredValue; ttlSec: number; expiresAtMs: number }>();
  getCalls = 0;
  mGetCalls = 0;
  setCalls = 0;
  delCalls = 0;
  failSet = false;
  failWatermarkGet = false;

  async get(key: string): Promise<RedisStoredValue | null> {
    this.getCalls += 1;
    return this.read(key);
  }

  async mGet(keys: readonly string[]): Promise<ReadonlyArray<RedisStoredValue | null>> {
    this.mGetCalls += 1;
    return keys.map((key) => this.read(key));
  }

  async mget(...keys: readonly string[]): Promise<ReadonlyArray<RedisStoredValue | null>> {
    return this.mGet(keys);
  }

  async setEx(key: string, ttlSec: number, value: RedisStoredValue): Promise<void> {
    this.setCalls += 1;
    if (this.failSet) {
      throw new Error("redis set failed");
    }
    this.values.set(key, { value, ttlSec, expiresAtMs: Date.now() + ttlSec * 1000 });
  }

  async del(key: string): Promise<number> {
    this.delCalls += 1;
    return this.values.delete(key) ? 1 : 0;
  }

  raw(key: string): string {
    const value = this.values.get(key)?.value;
    if (typeof value !== "string") {
      throw new Error(`missing string value for ${key}`);
    }
    return value;
  }

  private read(key: string): RedisStoredValue | null {
    if (this.failWatermarkGet && key.endsWith("#watermark")) {
      throw new Error("watermark read failed");
    }

    const entry = this.values.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAtMs <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }
}

class RecordingMetrics implements GCacheMetricsAdapter {
  readonly events: Array<{ readonly name: string; readonly labels: Record<string, unknown>; readonly value?: number }> = [];

  request(labels: CacheMetricLabels): void {
    this.record("request", labels);
  }

  miss(labels: CacheMetricLabels): void {
    this.record("miss", labels);
  }

  disabled(labels: DisabledMetricLabels): void {
    this.record("disabled", labels);
  }

  error(labels: ErrorMetricLabels): void {
    this.record("error", labels);
  }

  invalidation(labels: InvalidationMetricLabels): void {
    this.record("invalidation", labels);
  }

  observeGet(labels: CacheMetricLabels, seconds: number): void {
    this.record("get", labels, seconds);
  }

  observeFallback(labels: CacheMetricLabels, seconds: number): void {
    this.record("fallback", labels, seconds);
  }

  observeSerialization(labels: SerializationMetricLabels, seconds: number): void {
    this.record("serialization", labels, seconds);
  }

  observeSize(labels: CacheMetricLabels, bytes: number): void {
    this.record("size", labels, bytes);
  }

  private record(name: string, labels: object, value?: number): void {
    this.events.push({ name, labels: { ...labels }, ...(value === undefined ? {} : { value }) });
  }
}

const remoteOnly = (ttlSec = 60) =>
  new GCacheKeyConfig({
    ttlSec: { [CacheLayer.REMOTE]: ttlSec },
    ramp: { [CacheLayer.REMOTE]: 100 },
  });

const localAndRemote = (ttlSec = 60) => GCacheKeyConfig.enabled(ttlSec);

const valueKey = (useCase: string, args = ""): string => `{urn:user_id:123}${args}#${useCase}`;
const watermarkKey = "{urn:user_id:123}#watermark";

describe("GCache targeted invalidation watermarks", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("reads tracked Redis values and watermarks with one mGet", async () => {
    // Given a tracked Redis value already exists without a watermark.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T18:00:00.000Z"));
    const redis = new FakeRedis();
    redis.values.set(valueKey("TrackedAtomicRead"), {
      value: JSON.stringify({
        version: 1,
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
        encoding: "utf8",
        payload: JSON.stringify({ userId: "123", source: "redis" }),
      } satisfies RedisValueEnvelope),
      ttlSec: 60,
      expiresAtMs: Date.now() + 60_000,
    });
    const gcache = new GCache({ redis: { client: redis } });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "TrackedAtomicRead",
      id: ([userId]: [string]) => userId,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When the tracked key is read from Redis.
    const value = await gcache.enable(async () => await getUser("123"));

    // Then value and watermark are fetched together, matching the Python mget race guard.
    expect(value).toEqual({ userId: "123", source: "redis" });
    expect(calls).toBe(0);
    expect(redis.mGetCalls).toBe(1);
    expect(redis.getCalls).toBe(0);
  });

  it("rejects tracked Redis reads when the client lacks mGet/mget", async () => {
    // Given a tracked Redis key and a Redis-like client that only supports single-key get.
    const client: RedisCommandClient = {
      get: async () => null,
      setEx: async () => undefined,
      del: async () => 0,
      flushAll: async () => undefined,
    };
    const redisCache = new RedisCache({
      configProvider: async () => remoteOnly(),
      rampSampler: () => 0,
      redis: { client },
      metrics: null,
    });
    const key = new GCacheKey({
      keyType: "user_id",
      id: "123",
      useCase: "TrackedMissingMGet",
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    });

    // When the tracked Redis key is read, then the unsafe non-atomic path is rejected.
    await expect(redisCache.getResult(key)).rejects.toThrow("Redis client must support mGet/mget for invalidation-tracked GCache keys");
  });

  it("supports lowercase mget for tracked Redis reads", async () => {
    // Given a Redis-compatible client exposes lowercase mget instead of node-redis mGet.
    const key = new GCacheKey({
      keyType: "user_id",
      id: "123",
      useCase: "TrackedLowercaseMget",
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    });
    const envelope = JSON.stringify({
      version: 1,
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      encoding: "utf8",
      payload: JSON.stringify({ userId: "123", source: "redis" }),
    } satisfies RedisValueEnvelope);
    const mget = vi.fn(async (...keys: readonly string[]) => {
      expect(keys).toEqual([key.urn, `${key.prefix}#watermark`]);
      return [envelope, null];
    });
    const client: RedisCommandClient = {
      get: async () => {
        throw new Error("tracked reads must not call get");
      },
      mget,
      setEx: async () => undefined,
      del: async () => 0,
      flushAll: async () => undefined,
    };
    const redisCache = new RedisCache({
      configProvider: async () => remoteOnly(),
      rampSampler: () => 0,
      redis: { client },
      metrics: null,
    });

    // When the tracked key is read, then lowercase mget supplies value and watermark together.
    const result = await redisCache.getResult<{ userId: string; source: string }>(key);
    expect(result).toEqual({ status: "hit", value: { userId: "123", source: "redis" } });
    expect(mget).toHaveBeenCalledOnce();
  });

  it("rejects tracked Redis reads when mGet/mget returns too few values", async () => {
    // Given a tracked Redis read receives a malformed multi-get response.
    const client: RedisCommandClient = {
      get: async () => null,
      mGet: async () => [null],
      setEx: async () => undefined,
      del: async () => 0,
      flushAll: async () => undefined,
    };
    const redisCache = new RedisCache({
      configProvider: async () => remoteOnly(),
      rampSampler: () => 0,
      redis: { client },
      metrics: null,
    });
    const key = new GCacheKey({
      keyType: "user_id",
      id: "123",
      useCase: "TrackedShortMGet",
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    });

    // When the tracked key is read, then the malformed Redis client response is surfaced.
    await expect(redisCache.getResult(key)).rejects.toThrow("Redis mGet/mget returned too few values for invalidation-tracked GCache key");
  });

  it("rejects malformed Redis invalidation watermark values", async () => {
    // Given Redis returns watermark payloads that Number() would otherwise coerce unsafely.
    const malformedWatermarks: ReadonlyArray<RedisStoredValue> = ["-1", "1e3", "NaN", "Infinity", Buffer.from("0x10")];

    for (const watermark of malformedWatermarks) {
      const client: RedisCommandClient = {
        get: async () => null,
        mGet: async () => [null, watermark],
        setEx: async () => undefined,
        del: async () => 0,
        flushAll: async () => undefined,
      };
      const redisCache = new RedisCache({
        configProvider: async () => remoteOnly(),
        rampSampler: () => 0,
        redis: { client },
        metrics: null,
      });
      const key = new GCacheKey({
        keyType: "user_id",
        id: "123",
        useCase: `TrackedBadWatermark${String(watermark)}`,
        trackForInvalidation: true,
        defaultConfig: remoteOnly(),
      });

      // When a tracked read sees the malformed watermark, then it fails loudly for GCache's fail-open wrapper to handle.
      await expect(redisCache.getResult(key)).rejects.toThrow("Invalid GCache Redis watermark");
    }
  });

  it("invalidates older Redis values for all tracked use cases sharing the same key type and id", async () => {
    // Given two invalidation-tracked use cases have older Redis values for the same user id.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T18:00:00.000Z"));
    const redis = new FakeRedis();
    const gcache = new GCache({ redis: { client: redis } });
    let profileVersion = 1;
    let permissionsVersion = 1;
    const getProfile = gcache.cached({
      keyType: "user_id",
      useCase: "InvalidateProfile",
      id: ([userId]: [string]) => userId,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    })(async (userId: string) => ({ userId, profileVersion }));
    const getPermissions = gcache.cached({
      keyType: "user_id",
      useCase: "InvalidatePermissions",
      id: ([userId]: [string]) => userId,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    })(async (userId: string) => ({ userId, permissionsVersion }));
    await gcache.enable(async () => {
      await getProfile("123");
      await getPermissions("123");
    });
    profileVersion = 2;
    permissionsVersion = 2;

    // When the shared key type/id is invalidated and both use cases read again after the watermark timestamp.
    vi.setSystemTime(new Date("2026-05-12T18:00:00.001Z"));
    await gcache.invalidate("user_id", "123");
    vi.setSystemTime(new Date("2026-05-12T18:00:00.002Z"));
    const [profile, permissions] = await gcache.enable(async () => [await getProfile("123"), await getPermissions("123")]);

    // Then both stale Redis values are ignored and refreshed independently through fallback.
    const profileEnvelope = JSON.parse(redis.raw(valueKey("InvalidateProfile"))) as RedisValueEnvelope;
    const permissionsEnvelope = JSON.parse(redis.raw(valueKey("InvalidatePermissions"))) as RedisValueEnvelope;
    expect(profile).toEqual({ userId: "123", profileVersion: 2 });
    expect(permissions).toEqual({ userId: "123", permissionsVersion: 2 });
    expect(JSON.parse(profileEnvelope.payload)).toEqual({ userId: "123", profileVersion: 2 });
    expect(JSON.parse(permissionsEnvelope.payload)).toEqual({ userId: "123", permissionsVersion: 2 });
    expect(redis.delCalls).toBe(2);
  });

  it("does not write Redis or local cache while a future invalidation window is active", async () => {
    // Given a tracked Redis cache has an active future-buffer watermark.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T18:10:00.000Z"));
    const redis = new FakeRedis();
    const gcache = new GCache({ redis: { client: redis } });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "FutureBufferUser",
      id: ([userId]: [string]) => userId,
      trackForInvalidation: true,
      defaultConfig: localAndRemote(),
    })(async (userId: string) => ({ userId, calls: ++calls }));
    await gcache.invalidate("user_id", "123", { futureBufferMs: 1_000 });

    // When the fallback runs during the active invalidation window.
    vi.setSystemTime(new Date("2026-05-12T18:10:00.500Z"));
    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));

    // Then GCache returns fallback values but leaves only the watermark in Redis and does not populate local cache.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect([...redis.values.keys()]).toEqual([watermarkKey]);
  });

  it("does not write Redis or local cache when a future invalidation arrives during fallback", async () => {
    // Given a tracked cache miss starts before any invalidation watermark exists.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T18:15:00.000Z"));
    const redis = new FakeRedis();
    const gcache = new GCache({ redis: { client: redis } });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "FutureBufferFallbackRace",
      id: ([userId]: [string]) => userId,
      trackForInvalidation: true,
      defaultConfig: localAndRemote(),
    })(async (userId: string) => {
      calls += 1;
      await gcache.invalidate("user_id", userId, { futureBufferMs: 1_000 });
      return { userId, calls };
    });

    // When the fallback writes a future-buffer watermark before returning its result.
    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));

    // Then the fallback values return but neither Redis nor local cache stores stale in-flight results.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect([...redis.values.keys()]).toEqual([watermarkKey]);
  });

  it("refreshes malformed tracked Redis entries when no active watermark is present", async () => {
    // Given a tracked key has a malformed Redis value but no watermark-read failure.
    const redis = new FakeRedis();
    const redisKey = valueKey("TrackedMalformedEnvelope");
    redis.values.set(redisKey, { value: JSON.stringify({ version: 2, payload: "bad" }), ttlSec: 60, expiresAtMs: Date.now() + 60_000 });
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const gcache = new GCache({ redis: { client: redis }, logger });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "TrackedMalformedEnvelope",
      id: ([userId]: [string]) => userId,
      trackForInvalidation: true,
      defaultConfig: localAndRemote(),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When the malformed value is read twice.
    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));

    // Then GCache treats the bad envelope as a refreshable miss instead of a persistent cache bypass.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(calls).toBe(1);
    expect(logger.warn).not.toHaveBeenCalledWith("Error getting value from Redis cache", expect.any(Error));
  });

  it("keeps delimiter-containing tracked prefixes distinct", async () => {
    // Given two tracked key prefixes would collide if keyType/id were joined raw with colons.
    const first = invalidationPrefix("urn", "tenant:acme", "user");
    const second = invalidationPrefix("urn", "tenant", "acme:user");

    // When the prefixes are converted into Redis Cluster hash tags.
    const firstHashTag = redisClusterHashTag(first);
    const secondHashTag = redisClusterHashTag(second);

    // Then the tags remain distinct and safe for targeted invalidation.
    expect(first).not.toBe(second);
    expect(firstHashTag).not.toBe(secondHashTag);
  });

  it("constructs Redis Cluster-compatible hash-tagged keys for tracked values and watermarks", async () => {
    // Given Redis uses a key prefix and GCache uses a multi-part URN prefix.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T18:20:00.000Z"));
    const redis = new FakeRedis();
    const gcache = new GCache({
      urnPrefix: "urn:galileo:test",
      redis: { client: redis, keyPrefix: "gcache:", watermarkTtlSec: 42 },
    });
    const getUser = gcache.cached({
      keyType: "User",
      useCase: "ClusterSlotUser",
      id: ([userId]: [string, string]) => userId,
      args: ([, locale]: [string, string]) => ({ locale }),
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    })(async (userId: string, locale: string) => ({ userId, locale }));

    // When a tracked value and its watermark are written.
    await gcache.enable(async () => await getUser("123", "en"));
    await gcache.invalidate("User", "123");

    // Then both Redis keys share the same hash tag, custom prefix, and configured watermark TTL.
    expect([...redis.values.keys()].sort()).toEqual([
      "gcache:{urn%3Agalileo%3Atest:User:123}#watermark",
      "gcache:{urn%3Agalileo%3Atest:User:123}?locale=en#ClusterSlotUser",
    ]);
    expect(redis.values.get("gcache:{urn%3Agalileo%3Atest:User:123}#watermark")?.ttlSec).toBe(42);
    expect(DEFAULT_WATERMARK_TTL_SEC).toBe(3600 * 4);
    expect(redisClusterHashTag(invalidationPrefix("urn", "user_id", "123"))).toBe("{urn:user_id:123}");
    expect(() => new GCacheKey({ keyType: "user_id", id: "{123}", useCase: "BadTrackedKey", trackForInvalidation: true })).toThrow(
      /hash tag/,
    );
  });

  it("documents the local-cache consistency limitation by preserving a stale local hit after Redis invalidation", async () => {
    // Given a tracked mutable value is cached in both local and Redis layers.
    const redis = new FakeRedis();
    const gcache = new GCache({ redis: { client: redis } });
    let version = 1;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "LocalInvalidationLimit",
      id: ([userId]: [string]) => userId,
      trackForInvalidation: true,
      defaultConfig: localAndRemote(),
    })(async (userId: string) => ({ userId, version }));
    const before = await gcache.enable(async () => await getUser("123"));
    version = 2;

    // When Redis is invalidated but the same process still has a local cache hit.
    await gcache.invalidate("user_id", "123");
    const after = await gcache.enable(async () => await getUser("123"));

    // Then the local hit can remain stale, which is why strong invalidation should disable local cache.
    expect(before).toEqual({ userId: "123", version: 1 });
    expect(after).toEqual({ userId: "123", version: 1 });
  });

  it("propagates watermark write failures but fails open for tracked watermark reads", async () => {
    // Given invalidation watermark writes fail but metrics and logging are enabled.
    const writeRedis = new FakeRedis();
    writeRedis.failSet = true;
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const writeMetrics = new RecordingMetrics();
    const writeGCache = new GCache({ redis: { client: writeRedis }, logger, metrics: writeMetrics });

    // When targeted invalidation cannot write its watermark.
    await expect(writeGCache.invalidate("user_id", "123")).rejects.toThrow("redis set failed");

    // Then the API logs the operational failure and records both the invalidation attempt and error.
    expect(logger.warn).toHaveBeenCalledWith("Error writing GCache invalidation watermark", expect.any(Error));
    expect(writeMetrics.events).toContainEqual({ name: "invalidation", labels: { keyType: "user_id", layer: CacheLayer.REMOTE } });
    expect(writeMetrics.events).toContainEqual({
      name: "error",
      labels: { useCase: "watermark", keyType: "user_id", layer: CacheLayer.REMOTE, error: "Error", inFallback: false },
    });

    // Given watermark reads fail for a tracked cached function.
    const readRedis = new FakeRedis();
    readRedis.failWatermarkGet = true;
    const readMetrics = new RecordingMetrics();
    const readGCache = new GCache({ redis: { client: readRedis }, logger, metrics: readMetrics });
    let calls = 0;
    const getUser = readGCache.cached({
      keyType: "user_id",
      useCase: "WatermarkReadFailOpen",
      id: ([userId]: [string]) => userId,
      trackForInvalidation: true,
      defaultConfig: localAndRemote(),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When the cached function runs while the watermark read is unavailable.
    const first = await readGCache.enable(async () => await getUser("123"));
    const second = await readGCache.enable(async () => await getUser("123"));

    // Then fallback results still return, the stale-risky result is not cached, and an error metric is recorded.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect(readRedis.values.size).toBe(0);
    expect(readMetrics.events).toContainEqual({
      name: "error",
      labels: { useCase: "WatermarkReadFailOpen", keyType: "user_id", layer: CacheLayer.REMOTE, error: "Error", inFallback: false },
    });
  });

  it("fails open and suppresses tracked writes when watermark payloads are malformed", async () => {
    // Given Redis contains a syntactically numeric-looking but invalid Python-incompatible watermark.
    const redis = new FakeRedis();
    redis.values.set(watermarkKey, { value: "0x10", ttlSec: 60, expiresAtMs: Date.now() + 60_000 });
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const metrics = new RecordingMetrics();
    const gcache = new GCache({ redis: { client: redis }, logger, metrics });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "MalformedWatermarkFailOpen",
      id: ([userId]: [string]) => userId,
      trackForInvalidation: true,
      defaultConfig: localAndRemote(),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When the tracked function runs while watermark state cannot be trusted.
    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));

    // Then fallback values return, but neither Redis nor local cache stores potentially stale results.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect([...redis.values.keys()]).toEqual([watermarkKey]);
    expect(logger.warn).toHaveBeenCalledWith("Error getting value from Redis cache", expect.any(Error));
    expect(metrics.events).toContainEqual({
      name: "error",
      labels: { useCase: "MalformedWatermarkFailOpen", keyType: "user_id", layer: CacheLayer.REMOTE, error: "Error", inFallback: false },
    });
  });
});
