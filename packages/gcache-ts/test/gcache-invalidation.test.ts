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

class FakeRedis implements RedisCommandClient {
  readonly values = new Map<string, { value: RedisStoredValue; ttlSec: number; expiresAtMs: number }>();
  getCalls = 0;
  setCalls = 0;
  delCalls = 0;
  failSet = false;
  failWatermarkGet = false;

  async get(key: string): Promise<RedisStoredValue | null> {
    this.getCalls += 1;
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

  it("fails open and records errors when watermark writes or reads fail", async () => {
    // Given invalidation watermark writes fail but metrics and logging are enabled.
    const writeRedis = new FakeRedis();
    writeRedis.failSet = true;
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const writeMetrics = new RecordingMetrics();
    const writeGCache = new GCache({ redis: { client: writeRedis }, logger, metrics: writeMetrics });

    // When targeted invalidation cannot write its watermark.
    await writeGCache.invalidate("user_id", "123");

    // Then the API fails open, logs the operational failure, and records invalidation plus error metrics.
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
});
