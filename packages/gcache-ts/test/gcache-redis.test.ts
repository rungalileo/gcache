import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  GCache,
  GCacheKey,
  GCacheKeyConfig,
  type RedisCommandClient,
  type RedisStoredValue,
  type RedisValueEnvelope,
  type Serializer,
} from "../src/index.js";

class FakeRedis implements RedisCommandClient {
  readonly values = new Map<string, { value: RedisStoredValue; expiresAtMs: number }>();
  getCalls = 0;
  setCalls = 0;
  delCalls = 0;
  flushAllCalls = 0;
  failGet = false;
  failSet = false;
  failDel = false;
  failFlushAll = false;

  async get(key: string): Promise<RedisStoredValue | null> {
    this.getCalls += 1;
    if (this.failGet) {
      throw new Error("redis get failed");
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
    this.values.set(key, { value, expiresAtMs: Date.now() + ttlSec * 1000 });
  }

  async del(key: string): Promise<number> {
    this.delCalls += 1;
    if (this.failDel) {
      throw new Error("redis del failed");
    }
    return this.values.delete(key) ? 1 : 0;
  }

  async flushAll(): Promise<void> {
    this.flushAllCalls += 1;
    if (this.failFlushAll) {
      throw new Error("redis flushAll failed");
    }
    this.values.clear();
  }

  raw(key: string): string {
    const value = this.values.get(key)?.value;
    if (typeof value !== "string") {
      throw new Error(`missing string value for ${key}`);
    }
    return value;
  }
}

const keyFor = (id: string, useCase: string): GCacheKey => new GCacheKey({ keyType: "user_id", id, useCase });

describe("GCache Redis TTL layer", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("reads local miss from Redis and populates the local layer", async () => {
    // Given one process has already written a value into the shared Redis cache.
    const redis = new FakeRedis();
    const writer = new GCache({ redis: { client: redis } });
    let writerCalls = 0;
    const writeUser = writer.cached({
      keyType: "user_id",
      useCase: "RedisLocalPopulate",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string) => ({ userId, calls: ++writerCalls }));
    await writer.enable(async () => await writeUser("123"));

    const reader = new GCache({ redis: { client: redis } });
    let readerCalls = 0;
    const readUser = reader.cached({
      keyType: "user_id",
      useCase: "RedisLocalPopulate",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string) => ({ userId, calls: ++readerCalls }));
    redis.getCalls = 0;

    // When a second process reads the same key twice.
    const first = await reader.enable(async () => await readUser("123"));
    redis.failGet = true;
    const second = await reader.enable(async () => await readUser("123"));

    // Then the first read comes from Redis and the second read comes from the populated local cache.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(readerCalls).toBe(0);
    expect(redis.getCalls).toBe(1);
  });

  it("does not populate local cache when the local layer was disabled for the read", async () => {
    // Given one process has already written a value into the shared Redis cache.
    const redis = new FakeRedis();
    const writer = new GCache({ redis: { client: redis } });
    const writeUser = writer.cached({
      keyType: "user_id",
      useCase: "RedisNoDisabledLocalPopulate",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string) => ({ userId, source: "redis" }));
    await writer.enable(async () => await writeUser("123"));

    // And the reader sees local cache disabled for the first read, then enabled afterward.
    let providerCalls = 0;
    const remoteOnlyConfig = new GCacheKeyConfig({
      ttlSec: { [CacheLayer.REMOTE]: 60 },
      ramp: { [CacheLayer.REMOTE]: 100 },
    });
    const cacheConfigProvider = vi.fn(async () => (++providerCalls <= 2 ? remoteOnlyConfig : GCacheKeyConfig.enabled(60)));
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const reader = new GCache({ redis: { client: redis }, cacheConfigProvider, logger });
    let readerCalls = 0;
    const readUser = reader.cached({
      keyType: "user_id",
      useCase: "RedisNoDisabledLocalPopulate",
      id: ([userId]: [string]) => userId,
    })(async (userId: string) => ({ userId, source: `fallback-${++readerCalls}` }));
    redis.getCalls = 0;

    // When the first read hits Redis while local is disabled and the next read cannot reach Redis.
    const first = await reader.enable(async () => await readUser("123"));
    redis.failGet = true;
    const second = await reader.enable(async () => await readUser("123"));

    // Then the Redis value was not silently written into local after a disabled local read.
    expect(first).toEqual({ userId: "123", source: "redis" });
    expect(second).toEqual({ userId: "123", source: "fallback-1" });
    expect(readerCalls).toBe(1);
    expect(redis.getCalls).toBe(2);
  });

  it("writes Redis misses with a timestamped versioned envelope", async () => {
    // Given an enabled Redis-backed cache with deterministic time.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T17:00:00.000Z"));
    const redis = new FakeRedis();
    const gcache = new GCache({ redis: { client: redis, keyPrefix: "gcache:" } });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "RedisEnvelopeWrite",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(30),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When Redis misses and the fallback succeeds.
    const value = await gcache.enable(async () => await getUser("123"));
    const redisKey = `gcache:${keyFor("123", "RedisEnvelopeWrite").urn}`;
    const envelope = JSON.parse(redis.raw(redisKey)) as RedisValueEnvelope;

    // Then GCache stores the fallback result in a TS-specific Redis envelope with TTL metadata.
    expect(value).toEqual({ userId: "123", calls: 1 });
    expect(envelope).toMatchObject({
      version: 1,
      createdAtMs: Date.parse("2026-05-12T17:00:00.000Z"),
      expiresAtMs: Date.parse("2026-05-12T17:00:30.000Z"),
      encoding: "utf8",
    });
    expect(JSON.parse(envelope.payload)).toEqual({ userId: "123", calls: 1 });
  });

  it("retries a lazy Redis client factory after a transient rejection", async () => {
    // Given the first lazy Redis connection attempt fails but a later attempt can succeed.
    const redis = new FakeRedis();
    let factoryCalls = 0;
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const gcache = new GCache({
      redis: {
        createClient: async () => {
          factoryCalls += 1;
          if (factoryCalls === 1) {
            throw new Error("redis boot failed");
          }
          return redis;
        },
      },
      logger,
    });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "RedisClientFactoryRetry",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When the first call fails open and the second call retries Redis.
    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));

    // Then the rejected client promise does not poison the GCache instance forever.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(factoryCalls).toBe(2);
    expect(redis.setCalls).toBe(1);
  });

  it("uses a lazy Redis client factory once", async () => {
    // Given Redis is configured with a client factory instead of an eager client.
    const redis = new FakeRedis();
    let factoryCalls = 0;
    const gcache = new GCache({
      redis: {
        createClient: async () => {
          factoryCalls += 1;
          return redis;
        },
      },
    });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "RedisClientFactory",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When multiple cache operations need Redis.
    await gcache.enable(async () => {
      await getUser("123");
      await getUser("456");
    });

    // Then the factory is lazy and reused for subsequent Redis commands.
    expect(factoryCalls).toBe(1);
    expect(redis.setCalls).toBe(2);
  });

  it("fails open when Redis operations fail before fallback", async () => {
    // Given Redis is unavailable and local caching is not configured for this key.
    const redis = new FakeRedis();
    redis.failGet = true;
    redis.failSet = true;
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const gcache = new GCache({ redis: { client: redis }, logger });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "RedisFailOpen",
      id: ([userId]: [string]) => userId,
      defaultConfig: new GCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 0, [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.LOCAL]: 100, [CacheLayer.REMOTE]: 100 },
      }),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When the cached function is called while cache reads and writes fail.
    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));

    // Then application fallback results are still returned and no Redis error escapes.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect(logger.warn).toHaveBeenCalledWith("Error getting value from Redis cache", expect.any(Error));
    expect(logger.warn).toHaveBeenCalledWith("Error putting value in Redis cache", expect.any(Error));
  });

  it("round-trips Redis values through a custom serializer", async () => {
    // Given a custom serializer is configured for a cached function.
    const redis = new FakeRedis();
    const serializer: Serializer<{ id: string; source: string }> = {
      dump: vi.fn(async (value) => Buffer.from(`${value.id}|${value.source}`, "utf8")),
      load: vi.fn(async (value) => {
        const [id, source] = Buffer.isBuffer(value) ? value.toString("utf8").split("|") : value.split("|");
        return { id: id ?? "", source: source ?? "" };
      }),
    };
    const writer = new GCache({ redis: { client: redis } });
    const readFromWriter = writer.cached({
      keyType: "user_id",
      useCase: "RedisCustomSerializer",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
      serializer,
    })(async (userId: string) => ({ id: userId, source: "fallback" }));
    await writer.enable(async () => await readFromWriter("123"));

    const reader = new GCache({ redis: { client: redis } });
    let readerCalls = 0;
    const readFromRedis = reader.cached({
      keyType: "user_id",
      useCase: "RedisCustomSerializer",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
      serializer,
    })(async (userId: string) => ({ id: userId, source: `fallback-${++readerCalls}` }));

    // When another process reads the value from Redis.
    const value = await reader.enable(async () => await readFromRedis("123"));
    const envelope = JSON.parse(redis.raw(keyFor("123", "RedisCustomSerializer").urn)) as RedisValueEnvelope;

    // Then the custom serializer handles the Redis payload instead of JSON serialization.
    expect(value).toEqual({ id: "123", source: "fallback" });
    expect(readerCalls).toBe(0);
    expect(envelope.encoding).toBe("base64");
    expect(serializer.dump).toHaveBeenCalledOnce();
    expect(serializer.load).toHaveBeenCalledOnce();
  });

  it("fails open when Redis serializer dump fails", async () => {
    // Given Redis serialization fails after the fallback returns but local cache is still configured.
    const redis = new FakeRedis();
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const serializer: Serializer<{ userId: string; calls: number }> = {
      dump: vi.fn(async () => {
        throw new Error("dump failed");
      }),
      load: vi.fn(async () => ({ userId: "never", calls: 0 })),
    };
    const gcache = new GCache({ redis: { client: redis }, logger });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "RedisSerializerDumpFailure",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
      serializer,
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When Redis write serialization fails on the first miss and the same key is read again.
    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));

    // Then application results still return, Redis is not written, and local cache can still serve the second read.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(redis.setCalls).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith("Error putting value in Redis cache", expect.any(Error));
  });

  it("refreshes Redis values when serializer load fails", async () => {
    // Given Redis contains an envelope whose payload cannot be decoded by the configured serializer.
    const redis = new FakeRedis();
    const redisKey = keyFor("123", "RedisSerializerLoadFailure").urn;
    redis.values.set(redisKey, {
      expiresAtMs: Date.now() + 60_000,
      value: JSON.stringify({
        version: 1,
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
        encoding: "utf8",
        payload: JSON.stringify({ userId: "123", source: "stale" }),
      } satisfies RedisValueEnvelope),
    });
    let failNextLoad = true;
    const serializer: Serializer<{ userId: string; source: string }> = {
      dump: vi.fn(async (value) => JSON.stringify(value)),
      load: vi.fn(async (value) => {
        if (failNextLoad) {
          failNextLoad = false;
          throw new Error("load failed");
        }
        return JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value) as { userId: string; source: string };
      }),
    };
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const gcache = new GCache({ redis: { client: redis }, logger });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "RedisSerializerLoadFailure",
      id: ([userId]: [string]) => userId,
      defaultConfig: new GCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 0, [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.LOCAL]: 100, [CacheLayer.REMOTE]: 100 },
      }),
      serializer,
    })(async (userId: string) => ({ userId, source: `fallback-${++calls}` }));

    // When the first Redis hit cannot deserialize and a later read sees the refreshed value.
    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));

    // Then the decode failure fails open through fallback, records the cache read error, and overwrites Redis.
    expect(first).toEqual({ userId: "123", source: "fallback-1" });
    expect(second).toEqual({ userId: "123", source: "fallback-1" });
    expect(calls).toBe(1);
    expect(serializer.load).toHaveBeenCalledTimes(2);
    expect(serializer.dump).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith("Error getting value from Redis cache", expect.any(Error));
  });

  it("refreshes stale or malformed Redis envelopes by falling through to fallback", async () => {
    // Given Redis contains an expired envelope for one key and a malformed envelope for another.
    const redis = new FakeRedis();
    const staleKey = keyFor("stale", "RedisBadEnvelope").urn;
    const badKey = keyFor("bad", "RedisBadEnvelope").urn;
    const nonFiniteKey = keyFor("nonfinite", "RedisBadEnvelope").urn;
    redis.values.set(staleKey, {
      expiresAtMs: Date.now() + 60_000,
      value: JSON.stringify({
        version: 1,
        createdAtMs: Date.now() - 2_000,
        expiresAtMs: Date.now() - 1_000,
        encoding: "utf8",
        payload: JSON.stringify({ stale: true }),
      } satisfies RedisValueEnvelope),
    });
    redis.values.set(badKey, {
      expiresAtMs: Date.now() + 60_000,
      value: JSON.stringify({ version: 2, payload: "not valid for v1" }),
    });
    redis.values.set(nonFiniteKey, {
      expiresAtMs: Date.now() + 60_000,
      value: String.raw`{"version":1,"createdAtMs":1e309,"expiresAtMs":1e309,"encoding":"utf8","payload":"{\"bad\":true}"}`,
    });
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const gcache = new GCache({ redis: { client: redis }, logger });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "RedisBadEnvelope",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When both keys are read through the Redis chain.
    const stale = await gcache.enable(async () => await getUser("stale"));
    const malformed = await gcache.enable(async () => await getUser("bad"));
    const nonFinite = await gcache.enable(async () => await getUser("nonfinite"));

    // Then expired and malformed entries are deleted, fail open, and fallback results are cached again.
    expect(stale).toEqual({ userId: "stale", calls: 1 });
    expect(malformed).toEqual({ userId: "bad", calls: 2 });
    expect(nonFinite).toEqual({ userId: "nonfinite", calls: 3 });
    expect(redis.values.get(staleKey)).toBeDefined();
    expect(redis.values.get(badKey)).toBeDefined();
    expect(redis.values.get(nonFiniteKey)).toBeDefined();
    expect(logger.warn).not.toHaveBeenCalledWith("Error getting value from Redis cache", expect.any(Error));
  });

  it("falls through when remote config is missing and propagates Redis maintenance errors", async () => {
    // Given Redis is configured but the key has no remote TTL and maintenance commands fail.
    const redis = new FakeRedis();
    redis.failDel = true;
    redis.failFlushAll = true;
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const metrics = {
      request: vi.fn(),
      miss: vi.fn(),
      disabled: vi.fn(),
      error: vi.fn(),
      invalidation: vi.fn(),
      observeGet: vi.fn(),
      observeFallback: vi.fn(),
      observeSerialization: vi.fn(),
      observeSize: vi.fn(),
    };
    const gcache = new GCache({ redis: { client: redis }, logger, metrics });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "RedisMissingRemoteTtl",
      id: ([userId]: [string]) => userId,
      defaultConfig: new GCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 0 },
        ramp: { [CacheLayer.LOCAL]: 100 },
      }),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When cache reads/writes and explicit maintenance operations cannot use Redis safely.
    const value = await gcache.enable(async () => await getUser("123"));
    await expect(gcache.delete(keyFor("123", "RedisMissingRemoteTtl"))).rejects.toThrow("redis del failed");
    await expect(gcache.flushAll()).rejects.toThrow("redis flushAll failed");

    // Then missing remote config disables Redis reads/writes, while maintenance failures are logged and surfaced.
    expect(value).toEqual({ userId: "123", calls: 1 });
    expect(redis.getCalls).toBe(0);
    expect(redis.setCalls).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith("Error deleting value from Redis cache", expect.any(Error));
    expect(logger.warn).toHaveBeenCalledWith("Error flushing Redis cache", expect.any(Error));
    expect(metrics.error).toHaveBeenCalledWith({
      useCase: "RedisMissingRemoteTtl",
      keyType: "user_id",
      layer: CacheLayer.REMOTE,
      error: "Error",
      inFallback: false,
    });
    expect(metrics.error).toHaveBeenCalledWith({
      useCase: "flushAll",
      keyType: "all",
      layer: CacheLayer.REMOTE,
      error: "Error",
      inFallback: false,
    });
  });

  it("supports Redis setex, set with EX, lowercase flushall, and missing-command failures", async () => {
    // Given lightweight Redis-compatible clients expose different command spellings.
    const setexValues = new Map<string, RedisStoredValue>();
    const setexClient: RedisCommandClient = {
      get: async (key) => setexValues.get(key) ?? null,
      setex: async (key, _ttlSec, value) => {
        setexValues.set(key, value);
      },
      del: async (key) => (setexValues.delete(key) ? 1 : 0),
      flushall: async () => setexValues.clear(),
    };
    const setValues = new Map<string, RedisStoredValue>();
    const setClient: RedisCommandClient = {
      get: async (key) => setValues.get(key) ?? null,
      set: async (key, value, options) => {
        expect(options).toEqual({ EX: 60 });
        setValues.set(key, value);
      },
      del: async (key) => (setValues.delete(key) ? 1 : 0),
      flushAll: async () => setValues.clear(),
    };
    const missingSetClient = {
      get: async () => null,
      del: async () => 0,
      flushAll: async () => undefined,
    } satisfies RedisCommandClient;
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // When values are written through each command shape.
    for (const [client, useCase] of [
      [setexClient, "RedisSetexCommand"],
      [setClient, "RedisSetCommand"],
      [missingSetClient, "RedisMissingSetCommand"],
    ] as const) {
      const gcache = new GCache({ redis: { client }, logger });
      const getValue = gcache.cached({
        keyType: "user_id",
        useCase,
        id: ([userId]: [string]) => userId,
        defaultConfig: GCacheKeyConfig.enabled(60),
      })(async (userId: string) => ({ userId }));
      await gcache.enable(async () => await getValue("123"));
      await gcache.flushAll();
    }

    // Then compatible command spellings work and an incomplete client fails open on writes.
    expect(setexValues.size).toBe(0);
    expect(setValues.size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith("Error putting value in Redis cache", expect.any(Error));
  });

  it("propagates when Redis flushAll commands are unavailable", async () => {
    // Given a Redis-like client supports normal cache reads/writes but no full-flush command spelling.
    const values = new Map<string, RedisStoredValue>();
    const client = {
      get: async (key: string) => values.get(key) ?? null,
      setEx: async (key: string, _ttlSec: number, value: RedisStoredValue) => {
        values.set(key, value);
      },
      del: async (key: string) => (values.delete(key) ? 1 : 0),
    } satisfies RedisCommandClient;
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const gcache = new GCache({ redis: { client }, logger });
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "RedisMissingFlushCommand",
      id: ([userId]: [string]) => userId,
      defaultConfig: new GCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 0, [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.LOCAL]: 100, [CacheLayer.REMOTE]: 100 },
      }),
    })(async (userId: string) => ({ userId }));

    // When flushAll is requested after Redis has been used.
    await gcache.enable(async () => await getUser("123"));
    await expect(gcache.flushAll()).rejects.toThrow("Redis client does not implement flushAll/flushall");

    // Then the missing maintenance command is logged and surfaced to callers.
    expect(values.size).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith("Error flushing Redis cache", expect.any(Error));
  });

  it("rejects Redis config without a client or client factory", () => {
    // Given a Redis config that cannot create commands.
    const construct = () => new GCache({ redis: {} });

    // When the cache is constructed, then the invalid Redis configuration is rejected.
    expect(construct).toThrow("Redis config requires either client or createClient");
  });

  it("deletes and flushes entries across local and Redis layers", async () => {
    // Given two cached values exist in both local and Redis layers.
    const redis = new FakeRedis();
    const gcache = new GCache({ redis: { client: redis } });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "RedisDeleteAndFlush",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string) => ({ userId, calls: ++calls }));
    await gcache.enable(async () => {
      await getUser("123");
      await getUser("456");
    });

    // When one key is deleted and then all cache layers are flushed.
    const deleted = await gcache.delete(keyFor("123", "RedisDeleteAndFlush"));
    const afterDelete = await gcache.enable(async () => [await getUser("123"), await getUser("456")]);
    await gcache.flushAll();
    const afterFlush = await gcache.enable(async () => [await getUser("123"), await getUser("456")]);

    // Then delete reaches both layers and flushAll clears both layers.
    expect(deleted).toBe(true);
    expect(afterDelete).toEqual([
      { userId: "123", calls: 3 },
      { userId: "456", calls: 2 },
    ]);
    expect(afterFlush).toEqual([
      { userId: "123", calls: 4 },
      { userId: "456", calls: 5 },
    ]);
    expect(redis.delCalls).toBeGreaterThanOrEqual(1);
    expect(redis.flushAllCalls).toBe(1);
  });
});
