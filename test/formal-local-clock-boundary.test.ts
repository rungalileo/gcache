import { performance } from "node:perf_hooks";

import { expect, it, vi } from "vitest";

import { CacheLayer, DialCache, DialCacheKeyConfig } from "../src/index.js";

it("local insertion expiry uses whole monotonic milliseconds at fractional starts", async () => {
  let nowMs = 0.7;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  try {
    const cache = new DialCache();
    let sources = 0;
    const load = cache.cached(async () => ++sources, {
      keyType: "clock",
      useCase: "wholeMillisecondLocalExpiry",
      cacheKey: () => "one",
      defaultConfig: new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: 1 } }),
    });
    const call = async (): Promise<number> => await cache.enable(async () => await load());

    expect(await call()).toBe(1);
    nowMs = 999.9;
    expect(await call()).toBe(1);
    expect(sources).toBe(1);

    // Local expiry compares floor(now) - floor(insertion), so this is the
    // boundary even though less than 1000ms of precise time has elapsed.
    nowMs = 1000;
    expect(await call()).toBe(2);
    expect(sources).toBe(2);
  } finally {
    clock.mockRestore();
  }
});

it("default instances share the local millisecond expiry grid", async () => {
  let nowMs = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  try {
    const first = new DialCache();
    nowMs = 0.4;
    const second = new DialCache();
    const calls = [first, second].map(cache => {
      let sources = 0;
      const load = cache.cached(async () => ++sources, {
        keyType: "clock",
        useCase: "sharedLocalClockGrid",
        cacheKey: () => "one",
        defaultConfig: new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: 1 } }),
      });
      return async (): Promise<number> => await cache.enable(async () => await load());
    });

    nowMs = 0.7;
    for (const call of calls) expect(await call()).toBe(1);
    nowMs = 999.9;
    for (const call of calls) expect(await call()).toBe(1);
    nowMs = 1000;
    for (const call of calls) expect(await call()).toBe(2);
  } finally {
    clock.mockRestore();
  }
});
