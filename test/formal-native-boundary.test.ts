import { describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  JsonSerializer,
  type DialCacheMetricsAdapter,
  type ShadowValidationOutcome,
} from "../src/index.js";
import { encodeFrame, FakeRedis } from "./fake-redis.js";

// Host value conventions supplement Quint's JSON-projected observations. These
// tests invoke public shadow validation so they check the actual default
// comparator selection as well as its diagnostic consequence.
const comparisons: Array<{ name: string; cached: unknown; source: unknown; equal: boolean }> = [
  { name: "absent versus null", cached: undefined, source: null, equal: false },
  { name: "absent equality", cached: undefined, source: undefined, equal: true },
  { name: "null equality", cached: null, source: null, equal: true },
  { name: "false versus zero", cached: false, source: 0, equal: false },
  { name: "NaN equality", cached: Number.NaN, source: Number.NaN, equal: true },
  { name: "signed zero", cached: 0, source: -0, equal: false },
  { name: "nested property order", cached: { a: 1, b: [null, undefined] }, source: { b: [null, undefined], a: 1 }, equal: true },
  { name: "missing versus absent property", cached: { a: undefined }, source: {}, equal: false },
  { name: "binary byte equality", cached: Buffer.from([1, 2]), source: Buffer.from([1, 2]), equal: true },
  { name: "binary versus numeric array", cached: Buffer.from([1, 2]), source: [1, 2], equal: false },
];

function cloneNativeValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(cloneNativeValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, element]) => [key, cloneNativeValue(element)]));
  }
  return value;
}

describe("native behavior boundaries", () => {
  it.each(comparisons)("default shadow comparator preserves $name", async ({ cached, source, equal }) => {
    const redis = new FakeRedis();
    const outcomes: ShadowValidationOutcome[] = [];
    const noop = (): void => undefined;
    const metrics: DialCacheMetricsAdapter = {
      request: noop, miss: noop, disabled: noop, error: noop, invalidation: noop,
      observeGet: noop, observeFallback: noop, observeSerialization: noop, observeSize: noop,
      shadowValidation: ({ outcome }) => { outcomes.push(outcome); },
    };
    const key = new DialCacheKey({ keyType: "item", id: "same", useCase: "nativeComparator" });
    const valueKey = `${key.urn}:dialcache-frame-v1`;
    const frame = encodeFrame("stable codec token", Date.now(), 0);
    redis.setRaw(valueKey, frame);
    const cache = new DialCache({ redis: { client: redis }, metrics });
    let decodes = 0;
    const load = vi.fn(async () => source);
    const result = await cache.enable(async () => await cache.getOrLoad(load, {
      keyType: "item", useCase: "nativeComparator", key: "same",
      defaultConfig: new DialCacheKeyConfig({ ttlSec: { [CacheLayer.REMOTE]: 60 }, shadow: { ramp: 100 } }),
      serializer: {
        dump: () => "stable codec token",
        load: () => { decodes++; return cloneNativeValue(cached); },
      },
    }));

    expect(result).toStrictEqual(cached);
    await vi.waitFor(() => expect(outcomes).toHaveLength(1), { timeout: 1_000, interval: 1 });
    expect(outcomes).toEqual([equal ? "match" : "mismatch"]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(decodes).toBe(2);
    expect(redis.getCalls).toBe(equal ? 1 : 2);
    expect(redis.setCalls).toBe(0);
    expect(redis.raw(valueKey)).toEqual(frame);
  });

  it("default JSON codec preserves scalar pairs and literal surrogate escapes", async () => {
    const codec = new JsonSerializer<unknown>();
    for (const binary of [false, true]) {
      for (const [raw, expected] of [
        ['"\\ud83d\\ude00"', "😀"],
        ['"before\\uD83D\\uDE00after"', "before😀after"],
        ['"\\\\ud800"', "\\ud800"],
        ['{"\\ud83d\\ude00":"scalar"}', { "😀": "scalar" }],
      ] as const) {
        expect(await codec.load(binary ? Buffer.from(raw) : raw)).toEqual(expected);
      }
    }
  });

  it("default JSON codec distinguishes absent null and the literal sentinel string", async () => {
    const codec = new JsonSerializer<unknown>();
    const sentinel = "__dialcache_json_undefined_v1__";
    for (const [value, encoded] of [
      [undefined, sentinel], [null, "null"], [sentinel, JSON.stringify(sentinel)],
    ] as const) {
      expect(await codec.dump(value)).toBe(encoded);
      expect(await codec.load(encoded)).toBe(value);
      expect(await codec.load(Buffer.from(encoded))).toBe(value);
    }
  });

  it("native JSON accepts lone escaped surrogates outside the shared scalar domain", async () => {
    const codec = new JsonSerializer<string>();
    // Go deliberately rejects these JSON values because its strings cannot
    // represent lone UTF-16 code units; accepting them is a TS binding rule.
    expect(await codec.load('"\\ud800"')).toBe("\ud800");
    expect(await codec.load(Buffer.from('"\\udfff"'))).toBe("\udfff");
  });
});
