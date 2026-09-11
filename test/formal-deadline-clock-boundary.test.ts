import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CacheLayer, DialCache, DialCacheKeyConfig, FallbackTimeoutError, type DialCacheMetricsAdapter, type DialCacheRedisClient, type ShadowValidationOutcome } from "../src/index.js";

const local = new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: 1 } });
const remote = new DialCacheKeyConfig({ ttlSec: { [CacheLayer.REMOTE]: 1 } });
const boundary = [{ label: "before", elapsed: 0.5 }, { label: "at", elapsed: 1 }];
const logger = { debug: (): void => {}, error: (): void => {}, warn: (): void => {} };

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

// Quint uses integer ticks. These native tests independently check that a
// fractional host-clock origin does not shorten operation-relative deadlines.
describe("fractional native deadline boundaries", () => {
  it.each(boundary)("source settled $label its full elapsed deadline", async ({ elapsed }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let now = 0.75;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const cache = new DialCache();
    let sources = 0;
    const load = cache.cached(() => { sources++; now += elapsed; return sources; }, {
      keyType: "id", useCase: "fractionalSource", cacheKey: () => "one", defaultConfig: local, fallbackTimeoutMs: 1,
    });
    const call = (): Promise<number> => cache.enable(async () => await load());
    if (elapsed < 1) {
      await expect(call()).resolves.toBe(1);
      await expect(call()).resolves.toBe(1);
      expect(sources).toBe(1);
    } else {
      await expect(call()).rejects.toBeInstanceOf(FallbackTimeoutError);
      await expect(call()).rejects.toBeInstanceOf(FallbackTimeoutError);
      expect(sources).toBe(2);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(boundary)("remote read settled $label its full elapsed deadline", async ({ elapsed }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let now = 0.75;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const write = vi.fn();
    const client: DialCacheRedisClient = {
      read: () => { now += elapsed; return { payload: "7", createdAtMs: Date.now() }; },
      write, invalidate: () => undefined,
    };
    const cache = new DialCache({ redis: { client, readTimeoutMs: 1 }, logger });
    const source = vi.fn(() => 9);
    const value = await cache.enable(async () => await cache.getOrLoad(source, {
      keyType: "id", useCase: "fractionalRead", key: "one", defaultConfig: remote,
    }));
    expect(value).toBe(elapsed < 1 ? 7 : 9);
    expect(source).toHaveBeenCalledTimes(elapsed < 1 ? 0 : 1);
    expect(write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true].flatMap(dark => boundary.map(entry => ({ ...entry, dark, mode: dark ? "dark" : "served" }))))(
    "shadow $mode settled $label its full elapsed deadline", async ({ elapsed, dark }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let now = 0.75;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      let finish!: (outcome: ShadowValidationOutcome) => void;
      const outcome = new Promise<ShadowValidationOutcome>(resolve => { finish = resolve; });
      const noop = (): void => {};
      const metrics: DialCacheMetricsAdapter = {
        request: noop, miss: noop, disabled: noop, error: noop, invalidation: noop,
        observeGet: noop, observeFallback: noop, observeSerialization: noop, observeSize: noop,
        shadowValidation: event => finish(event.outcome),
      };
      const write = vi.fn();
      const client: DialCacheRedisClient = {
        read: () => dark ? { kind: "miss", reason: "value_absent" } : { payload: "7", createdAtMs: Date.now() },
        write, invalidate: () => undefined,
      };
      const cache = new DialCache({ redis: { client }, metrics, logger });
      const source = vi.fn(() => { now += elapsed; return 7; });
      const result = cache.enable(async () => await cache.getOrLoad(source, {
        keyType: "id", useCase: "fractionalShadow", key: "one", fallbackTimeoutMs: 1,
        defaultConfig: new DialCacheKeyConfig({ ttlSec: { [CacheLayer.REMOTE]: 1 }, ramp: { [CacheLayer.REMOTE]: dark ? 0 : 100 }, shadow: { ramp: 100 } }),
      }));
      if (dark && elapsed >= 1) await expect(result).rejects.toBeInstanceOf(FallbackTimeoutError);
      else await expect(result).resolves.toBe(7);
      expect(await outcome).toBe(elapsed < 1 ? dark ? "filled" : "match" : "timeout");
      expect(source).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(dark && elapsed < 1 ? 1 : 0);
      expect(vi.getTimerCount()).toBe(0);
    });
});
