import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  GCache,
  GCacheKey,
  GCacheKeyConfig,
  JsonSerializer,
  UseCaseIsAlreadyRegisteredError,
  UseCaseNameIsReservedError,
} from "../src/index.js";

describe("GCache local-only MVP", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("keeps caching disabled by default", async () => {
    // Given a cached function with a valid default local configuration.
    const gcache = new GCache();
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "GetUserDefaultDisabled",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When the function is called outside an enabled context.
    const first = await getUser("123");
    const second = await getUser("123");

    // Then the fallback executes every time.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect(calls).toBe(2);
  });

  it("supports metrics-disabled local caching and no-op invalidation without Redis", async () => {
    // Given metrics may be explicitly disabled and Redis may be absent.
    const gcache = new GCache({ metrics: false });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "MetricsDisabledNoRedis",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When local caching is used and targeted invalidation is requested without a Redis layer.
    const first = await gcache.enable(async () => await getUser("123"));
    await gcache.invalidate("user_id", "123");
    const second = await gcache.enable(async () => await getUser("123"));

    // Then no metrics adapter or Redis layer is required for the local path to work.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
  });

  it("caches values inside an enabled context", async () => {
    // Given a cached function called with the same cache key.
    const gcache = new GCache();
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "GetUserEnabled",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When the function is called twice inside gcache.enable().
    const [first, second] = await gcache.enable(async () => [await getUser("123"), await getUser("123")]);

    // Then the fallback only executes once and the second call returns the cached value.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(calls).toBe(1);
  });

  it("restores the previous enabled value after nested disable scopes", async () => {
    // Given caching is enabled in an outer scope.
    const gcache = new GCache();
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "GetUserNestedDisable",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When a nested disabled scope calls the cached function.
    const result = await gcache.enable(async () => {
      const first = await getUser("123");
      const disabled = await gcache.disable(async () => await getUser("123"));
      const after = await getUser("123");
      return { first, disabled, after };
    });

    // Then the disabled scope bypasses cache and the outer scope resumes using the cached value.
    expect(result.first).toEqual({ userId: "123", calls: 1 });
    expect(result.disabled).toEqual({ userId: "123", calls: 2 });
    expect(result.after).toEqual({ userId: "123", calls: 1 });
    expect(calls).toBe(2);
  });

  it("does not leak enabled context across parallel async flows", async () => {
    // Given one flow enables caching while another flow does not.
    const gcache = new GCache();
    let calls = 0;
    const getValue = gcache.cached({
      keyType: "tenant_id",
      useCase: "ParallelContextIsolation",
      id: ([tenantId]: [string]) => tenantId,
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (tenantId: string) => ({ tenantId, calls: ++calls }));

    // When both flows run concurrently.
    const [enabledFlow, disabledFlow] = await Promise.all([
      gcache.enable(async () => [await getValue("enabled"), await getValue("enabled")] as const),
      (async () => [await getValue("disabled"), await getValue("disabled")] as const)(),
    ]);

    // Then enabled state is isolated to the enabled async flow.
    expect(enabledFlow[0]).toEqual(enabledFlow[1]);
    expect(enabledFlow[0]?.tenantId).toBe("enabled");
    expect(disabledFlow[0]?.tenantId).toBe("disabled");
    expect(disabledFlow[1]?.tenantId).toBe("disabled");
    expect(disabledFlow[0]?.calls).not.toBe(disabledFlow[1]?.calls);
    expect(calls).toBe(3);
  });

  it("preserves enabled context through Promise.all within a scope", async () => {
    // Given an enabled context with concurrent cache lookups for the same key.
    const gcache = new GCache();
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "PromiseAllContext",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When one call populates cache before Promise.all repeats the same lookup.
    const first = await gcache.enable(async () => await getUser("123"));
    const parallel = await gcache.enable(async () => await Promise.all([getUser("123"), getUser("123")]));

    // Then all calls in the enabled async scopes can read the cached value.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(parallel).toEqual([
      { userId: "123", calls: 1 },
      { userId: "123", calls: 1 },
    ]);
    expect(calls).toBe(1);
  });

  it("keeps delimiter-containing ids and args in distinct local cache keys", async () => {
    // Given two calls would collide if key components were concatenated without escaping.
    const gcache = new GCache();
    let calls = 0;
    const search = gcache.cached({
      keyType: "user_id",
      useCase: "DelimiterSafeLocalKeys",
      id: ([userId]: [string, string | undefined]) => userId,
      args: ([, filter]: [string, string | undefined]) => ({ filter }),
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string, filter?: string) => ({ userId, filter, calls: ++calls }));

    // When an id containing a query delimiter is followed by a structurally different key.
    const [first, second, firstAgain, secondAgain] = await gcache.enable(async () => [
      await search("123?filter=active", undefined),
      await search("123", "active"),
      await search("123?filter=active", undefined),
      await search("123", "active"),
    ]);

    // Then each logical key gets its own cached value instead of sharing a colliding URN.
    expect(first).toEqual({ userId: "123?filter=active", filter: undefined, calls: 1 });
    expect(second).toEqual({ userId: "123", filter: "active", calls: 2 });
    expect(firstAgain).toEqual(first);
    expect(secondAgain).toEqual(second);
    expect(calls).toBe(2);
  });

  it("uses sorted explicit args as part of the cache key", async () => {
    // Given a cached function with explicit key args in non-sorted declaration order.
    const gcache = new GCache();
    let calls = 0;
    const search = gcache.cached({
      keyType: "user_id",
      useCase: "SearchPosts",
      id: ([userId]: [string, number, string]) => userId,
      args: ([, page, filter]) => ({ page, filter }),
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string, page: number, filter: string) => ({ userId, page, filter, calls: ++calls }));

    // When calls vary by explicit args.
    const results = await gcache.enable(async () => [
      await search("123", 1, "active"),
      await search("123", 1, "active"),
      await search("123", 2, "active"),
      await search("123", 1, "archived"),
    ]);

    // Then only identical explicit args share the same cached value.
    expect(results).toEqual([
      { userId: "123", page: 1, filter: "active", calls: 1 },
      { userId: "123", page: 1, filter: "active", calls: 1 },
      { userId: "123", page: 2, filter: "active", calls: 2 },
      { userId: "123", page: 1, filter: "archived", calls: 3 },
    ]);
    expect(calls).toBe(3);
  });

  it("expires local cache entries after their ttl", async () => {
    // Given a cached function with a one second local TTL.
    vi.useFakeTimers();
    const gcache = new GCache();
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "LocalTtlExpiration",
      id: ([userId]: [string]) => userId,
      defaultConfig: new GCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 1 },
        ramp: { [CacheLayer.LOCAL]: 100 },
      }),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When the same key is called before and after TTL expiration.
    const first = await gcache.enable(async () => await getUser("123"));
    vi.advanceTimersByTime(999);
    const beforeTtl = await gcache.enable(async () => await getUser("123"));
    vi.advanceTimersByTime(2);
    const afterTtl = await gcache.enable(async () => await getUser("123"));

    // Then the cached value is reused before TTL and refreshed after TTL.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(beforeTtl).toEqual({ userId: "123", calls: 1 });
    expect(afterTtl).toEqual({ userId: "123", calls: 2 });
    expect(calls).toBe(2);
  });

  it("fails open when key construction fails", async () => {
    // Given a cached function whose key builder throws.
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const gcache = new GCache({ logger });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "KeyConstructionFailure",
      id: () => {
        throw new Error("bad id");
      },
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async () => ({ calls: ++calls }));

    // When the cached function is called in an enabled scope.
    const first = await gcache.enable(async () => await getUser());
    const second = await gcache.enable(async () => await getUser());

    // Then the fallback still succeeds and no value is cached.
    expect(first).toEqual({ calls: 1 });
    expect(second).toEqual({ calls: 2 });
    expect(logger.error).toHaveBeenCalledWith("Could not construct GCache key", expect.any(Error));
  });

  it("restores async context after scope failures", async () => {
    // Given nested cache scopes can throw application errors.
    const gcache = new GCache();
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "ScopeFailureRestore",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When an enabled scope and an inner disabled scope fail.
    await expect(
      gcache.enable(async () => {
        expect(gcache.isEnabled()).toBe(true);
        await expect(
          gcache.disable(async () => {
            expect(gcache.isEnabled()).toBe(false);
            throw new Error("inner failed");
          }),
        ).rejects.toThrow("inner failed");
        expect(gcache.isEnabled()).toBe(true);
        throw new Error("outer failed");
      }),
    ).rejects.toThrow("outer failed");

    // Then the context is restored outside the failed scopes and default-disabled behavior remains intact.
    expect(gcache.isEnabled()).toBe(false);
    const first = await getUser("123");
    const second = await getUser("123");
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
  });

  it("fails open when local cache writes fail", async () => {
    // Given the local cache write path throws unexpectedly after fallback succeeds.
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const gcache = new GCache({ logger });
    const localCache = (gcache as unknown as {
      readonly localCache: {
        put: (key: GCacheKey, value: unknown, config?: { readonly ttlSec: number }) => Promise<void>;
      };
    }).localCache;
    vi.spyOn(localCache, "put").mockRejectedValueOnce(new Error("local write failed"));
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "LocalWriteFailOpen",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When the first local write fails and later calls retry normal cache behavior.
    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));
    const third = await gcache.enable(async () => await getUser("123"));

    // Then the write failure does not escape, and subsequent calls can still populate/read local cache.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect(third).toEqual({ userId: "123", calls: 2 });
    expect(logger.warn).toHaveBeenCalledWith("Error putting value in local cache", expect.any(Error));
  });

  it("falls through when local cache config is missing", async () => {
    // Given a cached function without any key config.
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const gcache = new GCache({ logger });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "MissingConfigFailure",
      id: ([userId]: [string]) => userId,
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When the cached function is called in an enabled scope.
    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));

    // Then the local layer is disabled and fallback still succeeds without treating missing config as an error.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("supports delete and flushAll for local entries", async () => {
    // Given two cached values in the local cache.
    const gcache = new GCache();
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "DeleteAndFlush",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string) => ({ userId, calls: ++calls }));
    await gcache.enable(async () => {
      await getUser("123");
      await getUser("456");
    });

    // When one key is deleted and then the cache is flushed.
    const deleted = await gcache.delete(new GCacheKey({ keyType: "user_id", id: "123", useCase: "DeleteAndFlush" }));
    const afterDelete = await gcache.enable(async () => [await getUser("123"), await getUser("456")]);
    await gcache.flushAll();
    const afterFlush = await gcache.enable(async () => [await getUser("123"), await getUser("456")]);

    // Then only the deleted key refreshes before flush and all keys refresh after flush.
    expect(deleted).toBe(true);
    expect(afterDelete).toEqual([
      { userId: "123", calls: 3 },
      { userId: "456", calls: 2 },
    ]);
    expect(afterFlush).toEqual([
      { userId: "123", calls: 4 },
      { userId: "456", calls: 5 },
    ]);
  });

  it("rejects duplicate and reserved use cases", () => {
    // Given a GCache instance with one registered use case.
    const gcache = new GCache();
    gcache.cached({
      keyType: "user_id",
      useCase: "UniqueUseCase",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string) => userId);

    // When another function registers the same use case or the reserved watermark use case.
    const duplicate = () =>
      gcache.cached({
        keyType: "user_id",
        useCase: "UniqueUseCase",
        id: ([userId]: [string]) => userId,
        defaultConfig: GCacheKeyConfig.enabled(60),
      })(async (userId: string) => userId);
    const reserved = () =>
      gcache.cached({
        keyType: "user_id",
        useCase: "watermark",
        id: ([userId]: [string]) => userId,
        defaultConfig: GCacheKeyConfig.enabled(60),
      })(async (userId: string) => userId);

    // Then GCache rejects both registrations.
    expect(duplicate).toThrow(UseCaseIsAlreadyRegisteredError);
    expect(reserved).toThrow(UseCaseNameIsReservedError);
  });

  it("supports withEnabled and withDisabled aliases", async () => {
    // Given a cached function and the readability aliases.
    const gcache = new GCache();
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "AliasScopes",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When withEnabled and withDisabled are nested.
    const result = await gcache.withEnabled(async () => {
      const first = await getUser("123");
      const disabled = await gcache.withDisabled(async () => await getUser("123"));
      const after = await getUser("123");
      return { first, disabled, after };
    });

    // Then they behave like enable and disable.
    expect(result).toEqual({
      first: { userId: "123", calls: 1 },
      disabled: { userId: "123", calls: 2 },
      after: { userId: "123", calls: 1 },
    });
  });

  it("treats non-positive local ttl as disabled local config", async () => {
    // Given a cached function with an invalid local TTL.
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const gcache = new GCache({ logger });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "InvalidLocalTtl",
      id: ([userId]: [string]) => userId,
      defaultConfig: new GCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 0 },
        ramp: { [CacheLayer.LOCAL]: 100 },
      }),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When the function is called in an enabled scope.
    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));

    // Then the local cache is bypassed and the fallback still succeeds.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("evicts the oldest local entry when max size is exceeded", async () => {
    // Given a local cache with room for one entry.
    const gcache = new GCache({ localMaxSize: 1 });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "LocalMaxSizeEviction",
      id: ([userId]: [string]) => userId,
      defaultConfig: GCacheKeyConfig.enabled(60),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When two different keys are cached.
    await gcache.enable(async () => {
      await getUser("123");
      await getUser("456");
    });
    const newestStillCached = await gcache.enable(async () => await getUser("456"));
    const oldestRefreshed = await gcache.enable(async () => await getUser("123"));
    const newestRefreshedAfterSecondEviction = await gcache.enable(async () => await getUser("456"));

    // Then the newest key is initially cached, the oldest key refreshes, and max-size eviction continues to apply.
    expect(newestStillCached).toEqual({ userId: "456", calls: 2 });
    expect(oldestRefreshed).toEqual({ userId: "123", calls: 3 });
    expect(newestRefreshedAfterSecondEviction).toEqual({ userId: "456", calls: 4 });
  });

  it("round-trips values through the JSON serializer", async () => {
    // Given the default JSON serializer.
    const serializer = new JsonSerializer<{ id: string; enabled: boolean }>();

    // When a value is dumped and loaded from both string and Buffer payloads.
    const dumped = await serializer.dump({ id: "123", enabled: true });
    const loadedFromString = await serializer.load(dumped);
    const loadedFromBuffer = await serializer.load(Buffer.from(dumped));

    // Then the serializer preserves the JSON-safe value.
    expect(loadedFromString).toEqual({ id: "123", enabled: true });
    expect(loadedFromBuffer).toEqual({ id: "123", enabled: true });
  });

  it("builds stable human-readable URNs for simple components", () => {
    // Given cache args that are not already sorted.
    const key = new GCacheKey({
      keyType: "user_id",
      id: "123",
      useCase: "GetPosts",
      args: [
        ["filter", "active"],
        ["page", "2"],
      ],
    });

    // When the key is rendered.
    const rendered = key.toString();

    // Then it keeps the structured key format used for debugging and grouping.
    expect(rendered).toBe("urn:user_id:123?filter=active&page=2#GetPosts");
  });

  it("keeps delimiter-containing URN components and args distinct", () => {
    // Given keys whose raw components would collide without escaping delimiter characters.
    const prefixWithDelimiter = new GCacheKey({ keyType: "user_id", id: "123", useCase: "GetPosts", urnPrefix: "urn:gcache" });
    const argValueWithDelimiter = new GCacheKey({
      keyType: "user_id",
      id: "123",
      useCase: "GetPosts",
      args: [["filter", "active&page=2"]],
    });
    const splitArgs = new GCacheKey({
      keyType: "user_id",
      id: "123",
      useCase: "GetPosts",
      args: [
        ["filter", "active"],
        ["page", "2"],
      ],
    });
    const argValueWithFragment = new GCacheKey({ keyType: "user_id", id: "123", useCase: "GetPosts", args: [["filter", "active#Other"]] });
    const useCaseWithFragment = new GCacheKey({ keyType: "user_id", id: "123", useCase: "Other", args: [["filter", "active"]] });

    // When the keys are rendered.
    // Then delimiter-bearing components are encoded, while simple components remain readable.
    expect(prefixWithDelimiter.toString()).toBe("urn%3Agcache:user_id:123#GetPosts");
    expect(argValueWithDelimiter.toString()).not.toBe(splitArgs.toString());
    expect(argValueWithDelimiter.toString()).toContain("filter=active%26page%3D2");
    expect(argValueWithFragment.toString()).not.toBe(useCaseWithFragment.toString());
    expect(argValueWithFragment.toString()).toContain("filter=active%23Other#GetPosts");
  });
});
