import { Registry } from "prom-client";
import { describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  GCache,
  GCacheKeyConfig,
  type CacheMetricLabels,
  type DisabledMetricLabels,
  type ErrorMetricLabels,
  type GCacheMetricsAdapter,
  type InvalidationMetricLabels,
  type RedisCommandClient,
  type RedisStoredValue,
  type SerializationMetricLabels,
} from "../src/index.js";

class FakeRedis implements RedisCommandClient {
  readonly values = new Map<string, RedisStoredValue>();
  failGet = false;

  async get(key: string): Promise<RedisStoredValue | null> {
    if (this.failGet) {
      throw new Error("redis unavailable");
    }
    return this.values.get(key) ?? null;
  }

  async setEx(key: string, _ttlSec: number, value: RedisStoredValue): Promise<void> {
    this.values.set(key, value);
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
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

const localOnly = (ttlSec = 60) =>
  new GCacheKeyConfig({
    ttlSec: { [CacheLayer.LOCAL]: ttlSec },
    ramp: { [CacheLayer.LOCAL]: 100 },
  });

const remoteOnly = () =>
  new GCacheKeyConfig({
    ttlSec: { [CacheLayer.REMOTE]: 60 },
    ramp: { [CacheLayer.REMOTE]: 100 },
  });

describe("GCache observability metrics", () => {
  it("reuses existing Prometheus collectors when multiple caches share a registry", async () => {
    // Given two GCache instances use the same custom Prometheus registry and metric names.
    const registry = new Registry();
    const firstCache = new GCache({ metricsRegistry: registry });
    const secondCache = new GCache({ metricsRegistry: registry });
    const first = firstCache.cached({
      keyType: "user_id",
      useCase: "DuplicateMetricRegistrationFirst",
      id: ([userId]: [string]) => userId,
      defaultConfig: localOnly(),
    })(async (userId: string) => ({ userId }));
    const second = secondCache.cached({
      keyType: "user_id",
      useCase: "DuplicateMetricRegistrationSecond",
      id: ([userId]: [string]) => userId,
      defaultConfig: localOnly(),
    })(async (userId: string) => ({ userId }));

    // When both caches emit request metrics.
    await firstCache.enable(async () => await first("123"));
    await secondCache.enable(async () => await second("456"));

    // Then construction does not throw duplicate-registration errors and both samples land in one collector.
    await expect(sumMetric(registry, "gcache_request_counter")).resolves.toBe(2);
    await expect(registry.getSingleMetricAsString("gcache_request_counter")).resolves.toContain(
      "gcache_request_counter",
    );
  });

  it("supports an injected metrics adapter without requiring Prometheus", async () => {
    // Given a custom in-memory metrics adapter.
    const metrics = new RecordingMetrics();
    const gcache = new GCache({ metrics });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "CustomMetricsAdapter",
      id: ([userId]: [string]) => userId,
      defaultConfig: localOnly(),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When a local miss is followed by a local hit.
    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));

    // Then the adapter receives behavioral request/miss/timer events for the local layer.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(events(metrics, "request", { useCase: "CustomMetricsAdapter", layer: CacheLayer.LOCAL })).toHaveLength(2);
    expect(events(metrics, "miss", { useCase: "CustomMetricsAdapter", layer: CacheLayer.LOCAL })).toHaveLength(1);
    expect(events(metrics, "fallback", { useCase: "CustomMetricsAdapter", layer: CacheLayer.LOCAL })).toHaveLength(1);
    expect(events(metrics, "get", { useCase: "CustomMetricsAdapter", layer: CacheLayer.LOCAL })).toHaveLength(2);
  });

  it("fails open when an injected metrics adapter throws", async () => {
    // Given a custom metrics adapter throws for every metric call.
    const throwingMetrics: GCacheMetricsAdapter = {
      request: () => { throw new Error("metrics unavailable"); },
      miss: () => { throw new Error("metrics unavailable"); },
      disabled: () => { throw new Error("metrics unavailable"); },
      error: () => { throw new Error("metrics unavailable"); },
      invalidation: () => { throw new Error("metrics unavailable"); },
      observeGet: () => { throw new Error("metrics unavailable"); },
      observeFallback: () => { throw new Error("metrics unavailable"); },
      observeSerialization: () => { throw new Error("metrics unavailable"); },
      observeSize: () => { throw new Error("metrics unavailable"); },
    };
    const gcache = new GCache({ metrics: throwingMetrics });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "ThrowingMetricsFailOpen",
      id: ([userId]: [string]) => userId,
      defaultConfig: localOnly(),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When metrics emission fails around a cache miss and hit.
    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));

    // Then metrics failures do not break application fallback or cache behavior.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
  });

  it("classifies disabled cache skips by reason", async () => {
    // Given one cache call is outside context and other enabled calls have disabled layer config.
    const metrics = new RecordingMetrics();
    const gcache = new GCache({ metrics });
    const contextDisabled = gcache.cached({
      keyType: "user_id",
      useCase: "DisabledByContext",
      id: ([userId]: [string]) => userId,
      defaultConfig: localOnly(),
    })(async (userId: string) => userId);
    const missingConfig = gcache.cached({
      keyType: "user_id",
      useCase: "DisabledByMissingConfig",
      id: ([userId]: [string]) => userId,
    })(async (userId: string) => userId);
    const invalidTtl = gcache.cached({
      keyType: "user_id",
      useCase: "DisabledByInvalidTtl",
      id: ([userId]: [string]) => userId,
      defaultConfig: localOnly(0),
    })(async (userId: string) => userId);
    const rampedDown = gcache.cached({
      keyType: "user_id",
      useCase: "DisabledByRamp",
      id: ([userId]: [string]) => userId,
      defaultConfig: new GCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 60 },
        ramp: { [CacheLayer.LOCAL]: 0 },
      }),
    })(async (userId: string) => userId);

    // When each path is called.
    await contextDisabled("123");
    await gcache.enable(async () => {
      await missingConfig("123");
      await invalidTtl("123");
      await rampedDown("123");
    });

    // Then disabled metrics preserve the operational reason labels.
    expect(events(metrics, "disabled", { useCase: "DisabledByContext", layer: "noop", reason: "context" })).toHaveLength(1);
    expect(
      events(metrics, "disabled", { useCase: "DisabledByMissingConfig", layer: CacheLayer.LOCAL, reason: "missing_config" }),
    ).toHaveLength(1);
    expect(events(metrics, "disabled", { useCase: "DisabledByInvalidTtl", layer: CacheLayer.LOCAL, reason: "invalid_ttl" })).toHaveLength(1);
    expect(events(metrics, "disabled", { useCase: "DisabledByRamp", layer: CacheLayer.LOCAL, reason: "ramped_down" })).toHaveLength(1);
  });

  it("labels cache errors separately from fallback errors", async () => {
    // Given one Redis-backed cache has a cache read failure and another has a fallback failure.
    const metrics = new RecordingMetrics();
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const failingRedis = new FakeRedis();
    failingRedis.failGet = true;
    const cacheFailure = new GCache({ redis: { client: failingRedis }, metrics, logger });
    const readThroughFailure = cacheFailure.cached({
      keyType: "user_id",
      useCase: "CacheErrorClassification",
      id: ([userId]: [string]) => userId,
      defaultConfig: remoteOnly(),
    })(async (userId: string) => ({ userId }));
    const fallbackCache = new GCache({ redis: { client: new FakeRedis() }, metrics, logger });
    const fallbackFailure = fallbackCache.cached({
      keyType: "user_id",
      useCase: "FallbackErrorClassification",
      id: ([userId]: [string]) => userId,
      defaultConfig: remoteOnly(),
    })(async () => {
      throw new TypeError("database failed");
    });

    // When the cache error fails open and the fallback error escapes.
    await cacheFailure.enable(async () => await readThroughFailure("123"));
    await expect(fallbackCache.enable(async () => await fallbackFailure("123"))).rejects.toThrow("database failed");

    // Then error labels identify whether the failure came from cache plumbing or from the fallback.
    expect(
      events(metrics, "error", {
        useCase: "CacheErrorClassification",
        layer: CacheLayer.REMOTE,
        error: "Error",
        inFallback: false,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "FallbackErrorClassification",
        layer: CacheLayer.REMOTE,
        error: "TypeError",
        inFallback: true,
      }),
    ).toHaveLength(1);
  });

  it("exports Prometheus counters and histograms for requests, misses, fallbacks, gets, serialization, and size", async () => {
    // Given a custom Prometheus registry and a Redis-backed cached function.
    const registry = new Registry();
    const redis = new FakeRedis();
    const gcache = new GCache({ redis: { client: redis }, metricsRegistry: registry, metricsPrefix: "test_" });
    let calls = 0;
    const getUser = gcache.cached({
      keyType: "user_id",
      useCase: "PrometheusMetricExport",
      id: ([userId]: [string]) => userId,
      defaultConfig: remoteOnly(),
    })(async (userId: string) => ({ userId, calls: ++calls }));

    // When the first read misses Redis and the second read hits Redis.
    const first = await gcache.enable(async () => await getUser("123"));
    const second = await gcache.enable(async () => await getUser("123"));

    // Then Prometheus contains Python-aligned metric families with the expected label values.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    await expect(sumMetric(registry, "test_gcache_request_counter", { use_case: "PrometheusMetricExport", layer: "remote" })).resolves.toBe(2);
    await expect(sumMetric(registry, "test_gcache_miss_counter", { use_case: "PrometheusMetricExport", layer: "remote" })).resolves.toBe(1);
    await expect(sumMetric(registry, "test_gcache_get_timer", { use_case: "PrometheusMetricExport", layer: "remote" })).resolves.toBeGreaterThan(0);
    await expect(sumMetric(registry, "test_gcache_fallback_timer", { use_case: "PrometheusMetricExport", layer: "remote" })).resolves.toBeGreaterThan(0);
    await expect(
      sumMetric(registry, "test_gcache_serialization_timer", { use_case: "PrometheusMetricExport", layer: "remote" }),
    ).resolves.toBeGreaterThan(0);
    await expect(sumMetric(registry, "test_gcache_size_histogram", { use_case: "PrometheusMetricExport", layer: "remote" })).resolves.toBeGreaterThan(0);
  });
});

function events(
  metrics: RecordingMetrics,
  name: string,
  labels: Record<string, string | boolean>,
): Array<{ readonly name: string; readonly labels: Record<string, unknown>; readonly value?: number }> {
  return metrics.events.filter(
    (event) => event.name === name && Object.entries(labels).every(([key, value]) => event.labels[key] === value),
  );
}

async function sumMetric(
  registry: Registry,
  name: string,
  labels: Record<string, string> = {},
): Promise<number> {
  const metrics = (await registry.getMetricsAsJSON()) as Array<{
    readonly name: string;
    readonly values: Array<{ readonly value: number; readonly labels: Record<string, string | number> }>;
  }>;
  const metric = metrics.find((candidate) => candidate.name === name);
  return (
    metric?.values
      .filter((sample) => Object.entries(labels).every(([key, value]) => sample.labels[key] === value))
      .reduce((total, sample) => total + sample.value, 0) ?? 0
  );
}
