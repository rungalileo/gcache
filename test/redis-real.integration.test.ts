import { createHash } from "node:crypto";
import { readGeneratedInvalidationVectors } from "../formal/generate-invalidation-vectors.mjs";
import { readFileSync } from "node:fs";

import * as valkeyGlide from "@valkey/valkey-glide";
import { commandOptions, createClient } from "redis";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  type DecodedRedisFrame,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  type DialCacheMetricsAdapter,
  type DialCacheRedisClient,
  isRedisReadMiss,
  type RedisReadResult,
  type Serializer,
} from "../src/index.js";
import { MARKER_ESCAPED_RAW, MARKER_ZSTD_UTF8 } from "../src/internal/compression.js";
import {
  MAX_SUPPORTED_DURATION_MS,
  MAX_TRACKED_REDIS_VALUE_TTL_MS,
} from "../src/internal/duration.js";
import { markerCollidingSerializer, type Row } from "./marker-colliding-serializer.js";
import {
  INVALIDATE_CACHE_SCRIPT,
  MIN_WATERMARK_TTL_MS,
} from "../src/internal/redis-scripts.js";
import { createNodeRedisDialCacheClient } from "../src/node-redis.js";
import { createValkeyGlideDialCacheClient } from "../src/valkey-glide.js";

const engines = [
  { name: "Redis 6.2", image: "redis:6.2-alpine" },
  { name: "Valkey 8", image: "valkey/valkey:8-alpine" },
] as const;

const adapterKinds = [
  { kind: "nodeRedis", name: "node-redis" },
  { kind: "valkeyGlide", name: "Valkey GLIDE" },
] as const;
type AdapterKind = (typeof adapterKinds)[number]["kind"];
const WATERMARK_TTL_MARGIN_MS = 60_000;
const INVALIDATE_CACHE_SHA1 = createHash("sha1").update(INVALIDATE_CACHE_SCRIPT).digest("hex");

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** Narrow an adapter read to its decoded frame, failing loudly on any miss. */
function expectFrame(result: RedisReadResult): DecodedRedisFrame {
  if (isRedisReadMiss(result)) {
    throw new Error(`expected a decoded frame but read a miss: ${JSON.stringify(result)}`);
  }
  return result;
}

const remoteOnly = new DialCacheKeyConfig({
  ttlSec: { [CacheLayer.REMOTE]: 60 },
  ramp: { [CacheLayer.REMOTE]: 100 },
});

const createTestClient = (url: string) => createClient({ url });
type NodeRedisTestClient = ReturnType<typeof createTestClient>;

interface RawRedisScriptClient {
  invalidate(watermarkKey: string, futureBufferMs: number, invalidatedAtMs: number): Promise<number>;
}

interface RedisAdapterHarness {
  readonly adapter: DialCacheRedisClient;
  /** Exercise invalidation Lua argument validation directly. */
  readonly raw: RawRedisScriptClient;
  dispose(): void;
}

function createNodeRedisHarness(client: NodeRedisTestClient): RedisAdapterHarness {
  return {
    adapter: createNodeRedisDialCacheClient(client),
    raw: {
      invalidate: async (watermarkKey, futureBufferMs, invalidatedAtMs) => {
        const reply = await client.sendCommand([
          "EVAL",
          INVALIDATE_CACHE_SCRIPT,
          "1",
          watermarkKey,
          String(futureBufferMs),
          String(invalidatedAtMs),
        ]);
        if (typeof reply !== "number") {
          throw new Error("Unexpected non-integer reply from DialCache test script");
        }
        return reply;
      },
    },
    dispose: () => undefined,
  };
}

function createValkeyGlideHarness(client: valkeyGlide.GlideClient): RedisAdapterHarness {
  const adapter = createValkeyGlideDialCacheClient(client, valkeyGlide);
  const invalidationScript = new valkeyGlide.Script(INVALIDATE_CACHE_SCRIPT);
  const invoke = async (
    script: valkeyGlide.Script,
    keys: Array<string>,
    args: Array<string | Buffer>,
  ): Promise<number> => {
    const reply = await client.invokeScript(script, {
      keys,
      args,
      decoder: valkeyGlide.Decoder.Bytes,
    });
    if (typeof reply !== "number") {
      throw new Error("Unexpected non-integer reply from DialCache test script");
    }
    return reply;
  };

  return {
    adapter,
    raw: {
      invalidate: async (watermarkKey, futureBufferMs, invalidatedAtMs) =>
        await invoke(
          invalidationScript,
          [watermarkKey],
          [String(futureBufferMs), String(invalidatedAtMs)],
        ),
    },
    dispose() {
      invalidationScript.release();
    },
  };
}

function encodeFrame(payload: string | Buffer, encoding: number, createdAtMs = Date.now(), version = 1): Buffer {
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(createdAtMs));
  return Buffer.concat([Buffer.from([version]), timestamp, Buffer.from([encoding]), Buffer.from(payload)]);
}

describe.each(engines)("DialCache Redis protocol on $name", ({ image }) => {
  let container: StartedTestContainer | undefined;
  // This connection controls and inspects server state; cache operations use the selected adapter harness.
  let admin: NodeRedisTestClient | undefined;
  let glide: valkeyGlide.GlideClient | undefined;
  let harnesses: Record<AdapterKind, RedisAdapterHarness> | undefined;

  beforeAll(async () => {
    container = await new GenericContainer(image)
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    const host = container.getHost();
    const port = container.getMappedPort(6379);
    admin = createTestClient(`redis://${host}:${port}`);
    admin.on("error", () => undefined);
    await admin.connect();
    glide = await valkeyGlide.GlideClient.createClient({ addresses: [{ host, port }] });
    harnesses = {
      nodeRedis: createNodeRedisHarness(admin),
      valkeyGlide: createValkeyGlideHarness(glide),
    };
  });

  afterAll(async () => {
    for (const harness of Object.values(harnesses ?? {})) {
      harness.dispose();
    }
    glide?.close();
    await admin?.quit();
    await container?.stop();
  });

  // Fixture setup, the actual protocol transition, and observation share one
  // atomic script. Redis 6.2 still advances TTL time inside Lua, so bound expiry
  // drift by measured server time, never a fixed CI/network tolerance.
  // Only the setup/observation wrapper is test-owned; the transition is the
  // same exported Lua used by both production adapters.
  type InvalidationVectorState =
    | { kind: "absent"; ttlMs: -2 }
    | { kind: "string"; value: string; ttlMs: number }
    | { kind: "list"; values: string[]; ttlMs: number };
  const invalidationVectors = JSON.parse(readFileSync(new URL("../formal/invalidation-vectors.json", import.meta.url), "utf8")) as {
    schemaVersion: number;
    vectors: Array<{
      name: string; existing: InvalidationVectorState;
      futureBufferMs: string; invalidatedAtMs: string;
      expected: { error?: boolean; state: InvalidationVectorState };
    }>;
  };
  const generatedInvalidationVectors = readGeneratedInvalidationVectors();
  for (const vector of [...invalidationVectors.vectors, ...generatedInvalidationVectors.vectors]) {
    it(`portable invalidation: ${vector.name}`, async () => {
      if (admin === undefined) throw new Error("Redis test client did not start");
      expect(invalidationVectors.schemaVersion).toBe(2);
      const script = `
redis.replicate_commands()
local function now_ms()
  local now = redis.call("TIME")
  return tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
end
local started_at = now_ms()
redis.call("DEL", KEYS[1])
if ARGV[3] == "string" then redis.call("SET", KEYS[1], ARGV[4]) end
if ARGV[3] == "list" then
  for _, value in ipairs(cjson.decode(ARGV[4])) do redis.call("RPUSH", KEYS[1], value) end
end
if tonumber(ARGV[5]) > 0 then redis.call("PEXPIRE", KEYS[1], ARGV[5]) end
local result = (function()
${INVALIDATE_CACHE_SCRIPT}
end)()
local status = result == 1 and "ok" or (type(result) == "table" and result.err and "error" or "unexpected_reply")
local kind = redis.call("TYPE", KEYS[1]).ok
local content = {}
if kind == "string" then content = redis.call("GET", KEYS[1]) end
if kind == "list" then content = redis.call("LRANGE", KEYS[1], 0, -1) end
if kind == "none" then kind = "absent" end
local ttl_ms = redis.call("PTTL", KEYS[1])
return {status, kind, content, ttl_ms, now_ms() - started_at}
`;
      const initial = vector.existing;
      const expected = vector.expected.state;
      const observed = await admin.eval(script, {
        keys: ["{portable-invalidation}#watermark"],
        arguments: [vector.futureBufferMs, vector.invalidatedAtMs, initial.kind,
          initial.kind === "string" ? initial.value : initial.kind === "list" ? JSON.stringify(initial.values) : "",
          String(initial.ttlMs)],
      });
      expect(observed).toEqual([vector.expected.error ? "error" : "ok", expected.kind,
        expected.kind === "string" ? expected.value : expected.kind === "list" ? expected.values : [],
        expect.any(Number), expect.any(Number)]);
      const [, , , ttlMs, elapsedMs] = observed as [string, string, string | string[], number, number];
      expect(elapsedMs).toBeGreaterThanOrEqual(0);
      if (expected.ttlMs < 0) {
        expect(ttlMs).toBe(expected.ttlMs);
      } else {
        expect(ttlMs).toBeGreaterThanOrEqual(Math.max(0, expected.ttlMs - elapsedMs));
        expect(ttlMs).toBeLessThanOrEqual(expected.ttlMs);
      }
    });
  }

  describe.each(adapterKinds)("with $name", ({ kind }) => {
    let client: RedisAdapterHarness | undefined;

    beforeEach(async () => {
      if (admin === undefined || harnesses === undefined) {
        throw new Error("Redis test clients did not start");
      }
      await admin.flushAll();
      client = harnesses[kind];
    });

    it("round-trips untracked UTF-8, binary, and inline-loader values", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient: DialCacheRedisClient = client.adapter;
      const dialcache = new DialCache({ namespace: "real", redis: { client: scriptClient, readTimeoutMs: 10_000 } });
      let jsonCalls = 0;
      let binaryCalls = 0;
      const getJson = dialcache.cached(async (id: string) => ({ id, calls: ++jsonCalls }), {
        keyType: "item_id",
        useCase: "RealJson",
        cacheKey: (id) => id,
        defaultConfig: remoteOnly,
      });
      const binarySerializer: Serializer<string> = {
        dump: async (value) => Buffer.from(value, "utf8"),
        load: async (value) => (Buffer.isBuffer(value) ? value.toString("utf8") : value),
      };
      const getBinary = dialcache.cached(async (id: string) => `binary:${id}:${++binaryCalls}`, {
        keyType: "item_id",
        useCase: "RealBinary",
        cacheKey: (id) => id,
        defaultConfig: remoteOnly,
        serializer: binarySerializer,
      });
      let inlineCalls = 0;
      const inlineOptions = {
        keyType: "item_id",
        useCase: "RealInline",
        key: "inline",
        defaultConfig: remoteOnly,
      } as const;

      const firstJson = await dialcache.enable(async () => await getJson("json"));
      const secondJson = await dialcache.enable(async () => await getJson("json"));
      const firstBinary = await dialcache.enable(async () => await getBinary("buffer"));
      const secondBinary = await dialcache.enable(async () => await getBinary("buffer"));
      const firstInline = await dialcache.enable(async () =>
        await dialcache.getOrLoad(async () => ({ source: "inline", calls: ++inlineCalls }), inlineOptions),
      );
      const secondInline = await dialcache.enable(async () =>
        await dialcache.getOrLoad(async () => ({ source: "unexpected", calls: ++inlineCalls }), inlineOptions),
      );

      expect(firstJson).toEqual({ id: "json", calls: 1 });
      expect(secondJson).toEqual(firstJson);
      expect(firstBinary).toBe("binary:buffer:1");
      expect(secondBinary).toBe(firstBinary);
      expect(firstInline).toEqual({ source: "inline", calls: 1 });
      expect(secondInline).toEqual(firstInline);
      expect(jsonCalls).toBe(1);
      expect(binaryCalls).toBe(1);
      expect(inlineCalls).toBe(1);
    });

    it("stores the exact application timestamp in tracked frame v1", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const valueKey = "client-clock:{item:exact}:value";
      const watermarkKey = "client-clock:{item:exact}:watermark";
      const createdAtMs = 1_700_000_000_123;
      const now = vi.spyOn(Date, "now").mockReturnValue(createdAtMs);
      try {
        await expect(client.adapter.write({
          valueKey,
          cacheTtlMs: 60_000,
          value: "tracked",
        })).resolves.toBeUndefined();
      } finally {
        now.mockRestore();
      }

      const stored = await admin.get(commandOptions({ returnBuffers: true }), valueKey);
      expect(stored?.[0]).toBe(1);
      expect(stored?.readBigUInt64BE(1)).toBe(BigInt(createdAtMs));
      await expect(client.adapter.read({ valueKey, watermarkKey })).resolves.toEqual({
        payload: "tracked",
        createdAtMs,
      });
    });

    it.each([false, true])(
      "retains a logically stale value through its maximum age and recovers it after source rejection (tracked=%s)",
      async (trackForInvalidation) => {
        if (client === undefined || admin === undefined) {
          throw new Error("Redis test clients did not start");
        }
        const namespace = `real-stale-${kind}-${trackForInvalidation ? "tracked" : "untracked"}`;
        const useCase = "RealStaleOnError";
        const id = "123";
        const key = new DialCacheKey({
          namespace,
          keyType: "item_id",
          id,
          useCase,
          trackForInvalidation,
        });
        const valueKey = `${key.urn}:dialcache-frame-v1`;
        const sourceValue = { id, version: 1 };
        const sourceError = new Error("source unavailable");
        const source = vi.fn<() => Promise<typeof sourceValue>>()
          .mockResolvedValueOnce(sourceValue)
          .mockRejectedValueOnce(sourceError);
        const redisRead = vi.fn(client.adapter.read.bind(client.adapter));
        const redisClient: DialCacheRedisClient = {
          read: redisRead,
          write: client.adapter.write.bind(client.adapter),
          invalidate: client.adapter.invalidate.bind(client.adapter),
        };
        const dialcache = new DialCache({
          namespace,
          redis: { client: redisClient, readTimeoutMs: 10_000 },
          shouldAttemptStaleRecovery: () => true,
        });
        const getItem = dialcache.cached(source, {
          keyType: "item_id",
          useCase,
          cacheKey: () => id,
          trackForInvalidation,
          defaultConfig: new DialCacheKeyConfig({
            ttlSec: { [CacheLayer.REMOTE]: 1 },
            ramp: { [CacheLayer.REMOTE]: 100 },
            staleOnErrorMaxAgeSec: 60,
          }),
        });

        await expect(dialcache.enable(async () => await getItem())).resolves.toEqual(sourceValue);
        const retainedTtlMs = await admin.pTTL(valueKey);
        expect(retainedTtlMs).toBeGreaterThan(55_000);
        expect(retainedTtlMs).toBeLessThanOrEqual(60_000);

        await admin.set(
          valueKey,
          encodeFrame(JSON.stringify(sourceValue), 0, Date.now() - 2_000),
          { PX: 60_000 },
        );
        const ttlBeforeRecovery = await admin.pTTL(valueKey);

        await expect(dialcache.enable(async () => await getItem())).resolves.toEqual(sourceValue);

        expect(source).toHaveBeenCalledTimes(2);
        expect(redisRead).toHaveBeenCalledTimes(2);
        expect(await admin.pTTL(valueKey)).toBeLessThanOrEqual(ttlBeforeRecovery);
      },
    );

    it("does not recover a tracked stale value fenced by invalidation", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const namespace = `real-stale-invalidated-${kind}`;
      const useCase = "RealStaleOnErrorInvalidated";
      const id = "123";
      const key = new DialCacheKey({
        namespace,
        keyType: "item_id",
        id,
        useCase,
        trackForInvalidation: true,
      });
      const valueKey = `${key.urn}:dialcache-frame-v1`;
      const sourceValue = { id, version: 1 };
      const sourceError = new Error("source unavailable");
      const source = vi.fn<() => Promise<typeof sourceValue>>()
        .mockResolvedValueOnce(sourceValue)
        .mockRejectedValueOnce(sourceError);
      const redisRead = vi.fn(client.adapter.read.bind(client.adapter));
      const redisClient: DialCacheRedisClient = {
        read: redisRead,
        write: client.adapter.write.bind(client.adapter),
        invalidate: client.adapter.invalidate.bind(client.adapter),
      };
      const dialcache = new DialCache({
        namespace,
        redis: { client: redisClient, readTimeoutMs: 10_000 },
        shouldAttemptStaleRecovery: () => true,
      });
      const getItem = dialcache.cached(source, {
        keyType: "item_id",
        useCase,
        cacheKey: () => id,
        trackForInvalidation: true,
        defaultConfig: new DialCacheKeyConfig({
          ttlSec: { [CacheLayer.REMOTE]: 1 },
          ramp: { [CacheLayer.REMOTE]: 100 },
          staleOnErrorMaxAgeSec: 60,
        }),
      });

      await expect(dialcache.enable(async () => await getItem())).resolves.toEqual(sourceValue);
      await admin.set(
        valueKey,
        encodeFrame(JSON.stringify(sourceValue), 0, Date.now() - 2_000),
        { PX: 60_000 },
      );
      await dialcache.invalidateRemote("item_id", id);

      await expect(dialcache.enable(async () => await getItem())).rejects.toBe(sourceError);
      expect(source).toHaveBeenCalledTimes(2);
      expect(redisRead).toHaveBeenCalledTimes(2);
    });

    it("serves the retained tracked snapshot when invalidation arrives during the source attempt", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const namespace = `real-stale-invalidation-race-${kind}`;
      const useCase = "RealStaleOnErrorInvalidationRace";
      const id = "123";
      const key = new DialCacheKey({
        namespace,
        keyType: "item_id",
        id,
        useCase,
        trackForInvalidation: true,
      });
      const valueKey = `${key.urn}:dialcache-frame-v1`;
      const sourceValue = { id, version: 1 };
      const sourceError = new Error("source unavailable");
      const sourceStarted = deferred<void>();
      const releaseSource = deferred<void>();
      const source = vi.fn(async (): Promise<typeof sourceValue> => {
        sourceStarted.resolve(undefined);
        await releaseSource.promise;
        throw sourceError;
      });
      const redisRead = vi.fn(client.adapter.read.bind(client.adapter));
      const redisClient: DialCacheRedisClient = {
        read: redisRead,
        write: client.adapter.write.bind(client.adapter),
        invalidate: client.adapter.invalidate.bind(client.adapter),
      };
      const dialcache = new DialCache({
        namespace,
        redis: { client: redisClient, readTimeoutMs: 10_000 },
        shouldAttemptStaleRecovery: () => true,
      });
      const getItem = dialcache.cached(source, {
        keyType: "item_id",
        useCase,
        cacheKey: () => id,
        trackForInvalidation: true,
        defaultConfig: new DialCacheKeyConfig({
          ttlSec: { [CacheLayer.REMOTE]: 1 },
          ramp: { [CacheLayer.REMOTE]: 100 },
          staleOnErrorMaxAgeSec: 60,
        }),
      });
      await admin.set(
        valueKey,
        encodeFrame(JSON.stringify(sourceValue), 0, Date.now() - 2_000),
        { PX: 60_000 },
      );

      const pending = dialcache.enable(async () => await getItem());
      await sourceStarted.promise;
      await dialcache.invalidateRemote("item_id", id);
      releaseSource.resolve(undefined);

      await expect(pending).resolves.toEqual(sourceValue);
      expect(source).toHaveBeenCalledOnce();
      expect(redisRead).toHaveBeenCalledOnce();
    });

    it("conditionally skips and then admits a tracked refill from the observed watermark", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const namespace = "real-conditional-refill";
      const useCase = "RealConditionalRefill";
      const valueKey = `{${namespace}:item_id:refill}#${useCase}:dialcache-frame-v1`;
      const watermarkKey = `{${namespace}:item_id:refill}#watermark`;
      const candidateAtMs = 1_700_000_000_100;
      const staleFrame = encodeFrame(JSON.stringify({ id: "refill", source: "stale" }), 0, candidateAtMs - 10);
      await admin.set(valueKey, staleFrame, { PX: 60_000 });
      await admin.set(watermarkKey, String(candidateAtMs), { PX: 60_000 });

      const write = vi.fn(client.adapter.write);
      const redisClient: DialCacheRedisClient = { ...client.adapter, write };
      const dialcache = new DialCache({
        namespace,
        redis: { client: redisClient, readTimeoutMs: 10_000 },
      });
      let calls = 0;
      const getPayload = dialcache.cached(async () => ({ id: "refill", calls: ++calls }), {
        keyType: "item_id",
        useCase,
        cacheKey: () => "refill",
        trackForInvalidation: true,
        defaultConfig: remoteOnly,
      });
      const now = vi.spyOn(Date, "now").mockReturnValue(candidateAtMs);
      try {
        const fenced = await dialcache.enable(async () => await getPayload());
        expect(fenced).toEqual({ id: "refill", calls: 1 });
        expect(write).not.toHaveBeenCalled();
        expect(await admin.get(commandOptions({ returnBuffers: true }), valueKey)).toEqual(staleFrame);

        now.mockReturnValue(candidateAtMs + 1);
        const written = await dialcache.enable(async () => await getPayload());
        const cached = await dialcache.enable(async () => await getPayload());

        expect(written).toEqual({ id: "refill", calls: 2 });
        expect(cached).toEqual(written);
        expect(calls).toBe(2);
        expect(write).toHaveBeenCalledOnce();
        expect(write).toHaveBeenCalledWith(expect.objectContaining({
          valueKey,
          createdAtMs: candidateAtMs + 1,
        }));
        const stored = await admin.get(commandOptions({ returnBuffers: true }), valueKey);
        expect(stored?.readBigUInt64BE(1)).toBe(BigInt(candidateAtMs + 1));
      } finally {
        now.mockRestore();
      }
    });

    it("compresses values above the threshold and stores small values byte-identical", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient: DialCacheRedisClient = client.adapter;
      const dialcache = new DialCache({ namespace: "real", redis: { client: scriptClient, readTimeoutMs: 10_000 } });
      let largeCalls = 0;
      const getLarge = dialcache.cached(
        async (id: string) => ({ id, calls: ++largeCalls, blob: "dialcache payload ".repeat(1_024) }),
        {
          keyType: "item_id",
          useCase: "RealCompressionLarge",
          cacheKey: (id) => id,
          defaultConfig: remoteOnly,
        },
      );
      let smallCalls = 0;
      const getSmall = dialcache.cached(async (id: string) => ({ id, calls: ++smallCalls }), {
        keyType: "item_id",
        useCase: "RealCompressionSmall",
        cacheKey: (id) => id,
        defaultConfig: remoteOnly,
      });

      const firstLarge = await dialcache.enable(async () => await getLarge("big"));
      const secondLarge = await dialcache.enable(async () => await getLarge("big"));
      const firstSmall = await dialcache.enable(async () => await getSmall("tiny"));

      // The remote-only config forces the second read through Redis, so equality proves decompression.
      expect(secondLarge).toEqual(firstLarge);
      expect(largeCalls).toBe(1);

      const largeKey = `${new DialCacheKey({ namespace: "real", keyType: "item_id", id: "big", useCase: "RealCompressionLarge" }).urn}:dialcache-frame-v1`;
      const storedLarge = await admin.get(commandOptions({ returnBuffers: true }), largeKey);
      expect(storedLarge).not.toBeNull();
      expect(storedLarge?.[0]).toBe(1);
      expect(storedLarge?.[9]).toBe(1);
      expect(storedLarge?.[10]).toBe(MARKER_ZSTD_UTF8);
      expect(storedLarge?.length).toBeLessThan(10 + Buffer.byteLength(JSON.stringify(firstLarge)));

      const smallKey = `${new DialCacheKey({ namespace: "real", keyType: "item_id", id: "tiny", useCase: "RealCompressionSmall" }).urn}:dialcache-frame-v1`;
      const storedSmall = await admin.get(commandOptions({ returnBuffers: true }), smallKey);
      expect(storedSmall?.[9]).toBe(0);
      expect(storedSmall?.subarray(10).toString("utf8")).toBe(JSON.stringify(firstSmall));
    });

    it("round-trips compressed payloads through tracked writes and invalidation", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      // This pins the combination of compression and tracked reads: the
      // complete zstd frame remains fenceable by the watermark.
      const scriptClient: DialCacheRedisClient = client.adapter;
      const namespace = "real-compression-tracked";
      const dialcache = new DialCache({ namespace, redis: { client: scriptClient, readTimeoutMs: 10_000 } });
      let calls = 0;
      const getLarge = dialcache.cached(
        async (id: string) => ({ id, calls: ++calls, blob: "tracked dialcache payload ".repeat(1_024) }),
        {
          keyType: "item_id",
          useCase: "RealCompressionTracked",
          cacheKey: (id) => id,
          trackForInvalidation: true,
          defaultConfig: remoteOnly,
        },
      );

      const first = await dialcache.enable(async () => await getLarge("big"));
      const second = await dialcache.enable(async () => await getLarge("big"));
      expect(second).toEqual(first);
      expect(calls).toBe(1);

      const valueKey = `{${namespace}:item_id:big}#RealCompressionTracked:dialcache-frame-v1`;
      const stored = await admin.get(commandOptions({ returnBuffers: true }), valueKey);
      expect(stored?.[0]).toBe(1);
      expect(stored?.[9]).toBe(1);
      expect(stored?.[10]).toBe(MARKER_ZSTD_UTF8);

      await dialcache.invalidateRemote("item_id", "big");
      // Leave the zero-buffer watermark clearly in the past so the refill's
      // client timestamp lands after it.
      await new Promise((resolve) => setTimeout(resolve, 25));
      const refreshed = await dialcache.enable(async () => await getLarge("big"));
      expect(refreshed).toEqual({ ...first, calls: 2 });

      // The refill must be a published, servable zstd frame: a third read
      // serves it from Redis without reloading, and the stored bytes carry the
      // complete frame with its compression envelope intact.
      const third = await dialcache.enable(async () => await getLarge("big"));
      expect(third).toEqual(refreshed);
      expect(calls).toBe(2);
      const restored = await admin.get(commandOptions({ returnBuffers: true }), valueKey);
      expect(restored?.[0]).toBe(1);
      expect(restored?.[9]).toBe(1);
      expect(restored?.[10]).toBe(MARKER_ZSTD_UTF8);
    });

    it("escapes envelope-colliding binary serializer output on the wire and round-trips it", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient: DialCacheRedisClient = client.adapter;
      const dialcache = new DialCache({ namespace: "real", redis: { client: scriptClient, readTimeoutMs: 10_000 } });
      let calls = 0;
      const getRow = dialcache.cached(
        async (id: string): Promise<Row> => {
          calls += 1;
          return { id };
        },
        {
          keyType: "item_id",
          useCase: "RealCompressionEscape",
          cacheKey: (id) => id,
          defaultConfig: remoteOnly,
          serializer: markerCollidingSerializer,
        },
      );

      const first = await dialcache.enable(async () => await getRow("esc"));
      const second = await dialcache.enable(async () => await getRow("esc"));
      expect(first).toEqual({ id: "esc" });
      expect(second).toEqual({ id: "esc" });
      expect(calls).toBe(1);

      const escapeKey = `${new DialCacheKey({ namespace: "real", keyType: "item_id", id: "esc", useCase: "RealCompressionEscape" }).urn}:dialcache-frame-v1`;
      const stored = await admin.get(commandOptions({ returnBuffers: true }), escapeKey);
      expect(stored?.[9]).toBe(1);
      expect(stored?.[10]).toBe(MARKER_ESCAPED_RAW);
      expect(stored?.[11]).toBe(MARKER_ZSTD_UTF8);
    });

    it("stores arbitrary binary payloads without base64 expansion", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const payloads = [
        Buffer.alloc(0),
        Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
        Buffer.alloc(2 * 1024 * 1024, 0xa5),
      ];

      for (const [index, payload] of payloads.entries()) {
        const valueKey = `binary-raw:{item:${index}}:value`;
        await expect(
          scriptClient.write({ valueKey, cacheTtlMs: 60_000, value: payload }),
        ).resolves.toBeUndefined();

        const roundTrip = expectFrame(await scriptClient.read({ valueKey }));
        const stored = await admin.get(commandOptions({ returnBuffers: true }), valueKey);

        expect(Buffer.isBuffer(roundTrip.payload)).toBe(true);
        expect(roundTrip.payload).toEqual(payload);
        expect(roundTrip.createdAtMs).toBeGreaterThan(0);
        expect(stored).not.toBeNull();
        expect(stored?.length).toBe(10 + payload.length);
        expect(stored?.[0]).toBe(1);
        expect(stored?.[9]).toBe(1);
        expect(stored?.subarray(10)).toEqual(payload);
      }

      const trackedValueKey = "binary-raw:{item:tracked}:value";
      const watermarkKey = "binary-raw:{item:tracked}:watermark";
      const trackedPayload = Buffer.from([0, 0xff, 0xc3, 0x28, 0x80]);
      await expect(
        scriptClient.write({
          valueKey: trackedValueKey,
          cacheTtlMs: 60_000,
          value: trackedPayload,
        }),
      ).resolves.toBeUndefined();
      const trackedRead = expectFrame(await scriptClient.read({ valueKey: trackedValueKey, watermarkKey }));
      expect(trackedRead.payload).toEqual(trackedPayload);
      expect(trackedRead.createdAtMs).toBeGreaterThan(0);
    });

    it("shadow-validates the deserialized tracked value without repairing a mismatch", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const cachedPayload = Buffer.from([0, 0xff, 0xc3, 0x28, 0x80]);
      const mismatchPayload = Buffer.from([0, 0xff, 0xc3, 0x28, 0x81]);
      const namespace = "real-shadow";
      const useCase = "RealShadowPayload";
      const valueKey = `{${namespace}:item_id:binary}#${useCase}:dialcache-frame-v1`;
      const watermarkKey = `{${namespace}:item_id:binary}#watermark`;
      const storedFrame = encodeFrame(cachedPayload, 1);
      await admin.set(valueKey, storedFrame, { PX: 60_000 });
      await admin.set(watermarkKey, "0", { PX: 60_000 });

      const read = vi.fn(client.adapter.read);
      const write = vi.fn(client.adapter.write);
      const invalidate = vi.fn(client.adapter.invalidate);
      const redisClient: DialCacheRedisClient = { ...client.adapter, read, write, invalidate };
      const matched = deferred<void>();
      const mismatched = deferred<void>();
      const metrics: DialCacheMetricsAdapter = {
        request: vi.fn(),
        miss: vi.fn(),
        disabled: vi.fn(),
        error: vi.fn(),
        invalidation: vi.fn(),
        coalesced: vi.fn(),
        shadowValidation: vi.fn(({ outcome }) => {
          if (outcome === "match") {
            matched.resolve();
          } else if (outcome === "mismatch") {
            mismatched.resolve();
          }
        }),
        observeShadowValueAge: vi.fn(),
        observeGet: vi.fn(),
        observeFallback: vi.fn(),
        observeSerialization: vi.fn(),
        observeSize: vi.fn(),
      };
      const serializer: Serializer<Buffer> = {
        dump: vi.fn((value) => value),
        load: vi.fn((value) => {
          if (!Buffer.isBuffer(value)) {
            throw new Error("Expected the binary Redis payload");
          }
          return Buffer.from(value);
        }),
      };
      const shadowRemoteOnly = new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.REMOTE]: 100 },
        shadow: { ramp: 100 },
      });
      const dialcache = new DialCache({
        namespace,
        redis: { client: redisClient, readTimeoutMs: 10_000 },
        metrics,
      });
      let sourcePayload: Buffer = Buffer.from(cachedPayload);
      let sourceMutation: "none" | "watermark" | "payload" | "missing" = "none";
      let mutatedFrame: Buffer | null = null;
      let sourceCalls = 0;
      const getPayload = dialcache.cached(
        async (): Promise<Buffer> => {
          sourceCalls += 1;
          if (sourceMutation === "watermark") {
            await admin!.set(watermarkKey, String(Date.now() + 60_000), { PX: 60_000 });
          } else if (sourceMutation === "payload") {
            mutatedFrame = encodeFrame(sourcePayload, 1);
            await admin!.set(valueKey, mutatedFrame, { PX: 60_000 });
          } else if (sourceMutation === "missing") {
            await admin!.del(valueKey);
          }
          return sourcePayload;
        },
        {
          keyType: "item_id",
          useCase,
          cacheKey: () => "binary",
          trackForInvalidation: true,
          defaultConfig: shadowRemoteOnly,
          serializer,
        },
      );

      const matchingHit = await dialcache.enable(async () => await getPayload());
      expect(matchingHit).toEqual(cachedPayload);
      await matched.promise;
      expect(read).toHaveBeenCalledTimes(1);

      sourcePayload = mismatchPayload;
      const mismatchingHit = await dialcache.enable(async () => await getPayload());
      expect(mismatchingHit).toEqual(cachedPayload);
      await mismatched.promise;

      sourceMutation = "watermark";
      const invalidatedHit = await dialcache.enable(async () => await getPayload());
      expect(invalidatedHit).toEqual(cachedPayload);
      await vi.waitFor(() => {
        expect(metrics.shadowValidation).toHaveBeenCalledTimes(3);
      });

      await admin.set(valueKey, storedFrame, { PX: 60_000 });
      await admin.set(watermarkKey, "0", { PX: 60_000 });
      sourceMutation = "payload";
      const supersededHit = await dialcache.enable(async () => await getPayload());
      expect(supersededHit).toEqual(cachedPayload);
      await vi.waitFor(() => {
        expect(metrics.shadowValidation).toHaveBeenCalledTimes(4);
      });
      expect(mutatedFrame).not.toBeNull();
      expect(await admin.get(commandOptions({ returnBuffers: true }), valueKey)).toEqual(mutatedFrame);

      await admin.set(valueKey, storedFrame, { PX: 60_000 });
      await admin.set(watermarkKey, "0", { PX: 60_000 });
      sourceMutation = "missing";
      const missingHit = await dialcache.enable(async () => await getPayload());
      expect(missingHit).toEqual(cachedPayload);
      await vi.waitFor(() => {
        expect(metrics.shadowValidation).toHaveBeenCalledTimes(5);
      });

      expect(sourceCalls).toBe(5);
      expect(serializer.load).toHaveBeenCalledTimes(10);
      expect(serializer.dump).not.toHaveBeenCalled();
      expect(metrics.shadowValidation).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        outcome: "match",
      });
      expect(metrics.shadowValidation).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        outcome: "mismatch",
      });
      expect(metrics.shadowValidation).toHaveBeenNthCalledWith(3, {
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        outcome: "superseded",
      });
      expect(metrics.shadowValidation).toHaveBeenNthCalledWith(4, {
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        outcome: "superseded",
      });
      expect(metrics.shadowValidation).toHaveBeenNthCalledWith(5, {
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        outcome: "superseded",
      });
      // The stored frame has createdAtMs=1, so both verdicts see
      // a huge positive age; superseded outcomes record none.
      expect(metrics.observeShadowValueAge).toHaveBeenCalledTimes(2);
      expect(metrics.observeShadowValueAge).toHaveBeenNthCalledWith(
        1,
        { cacheNamespace: namespace, useCase, keyType: "item_id", outcome: "match" },
        expect.any(Number),
      );
      expect(metrics.observeShadowValueAge).toHaveBeenNthCalledWith(
        2,
        { cacheNamespace: namespace, useCase, keyType: "item_id", outcome: "mismatch" },
        expect.any(Number),
      );
      expect(read).toHaveBeenCalledTimes(9);
      expect(read.mock.calls.every(([request]) =>
        request.valueKey === valueKey && request.watermarkKey === watermarkKey
      )).toBe(true);
      expect(write).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      expect(await admin.get(commandOptions({ returnBuffers: true }), valueKey)).toBeNull();
    });

    it.each([
      { name: "tracked", tracked: true },
      { name: "untracked", tracked: false },
    ])("shadow-reads $name Redis without serving or repairing a warm hit when the remote ramp is zero", async ({
      name,
      tracked,
    }) => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const namespace = `real-dark-shadow-${name}`;
      const useCase = `RealDarkShadowPayload${name}`;
      const rawPrefix = `${namespace}:item_id:dark`;
      const valueKey = tracked
        ? `{${rawPrefix}}#${useCase}:dialcache-frame-v1`
        : `${rawPrefix}#${useCase}:dialcache-frame-v1`;
      const watermarkKey = `{${namespace}:item_id:dark}#watermark`;
      const cachedValue = { id: "dark", version: 1 };
      const sourceValue = { id: "dark", version: 2 };
      const storedFrame = encodeFrame(JSON.stringify(cachedValue), 0);
      await admin.set(valueKey, storedFrame, { PX: 60_000 });
      if (tracked) {
        await admin.set(watermarkKey, "0", { PX: 60_000 });
      }

      const read = vi.fn(client.adapter.read);
      const write = vi.fn(client.adapter.write);
      const invalidate = vi.fn(client.adapter.invalidate);
      const redisClient: DialCacheRedisClient = { ...client.adapter, read, write, invalidate };
      const mismatched = deferred<void>();
      const metrics: DialCacheMetricsAdapter = {
        request: vi.fn(),
        miss: vi.fn(),
        disabled: vi.fn(),
        error: vi.fn(),
        invalidation: vi.fn(),
        coalesced: vi.fn(),
        shadowValidation: vi.fn(({ outcome }) => {
          if (outcome === "mismatch") {
            mismatched.resolve();
          }
        }),
        observeGet: vi.fn(),
        observeFallback: vi.fn(),
        observeSerialization: vi.fn(),
        observeSize: vi.fn(),
      };
      const dialcache = new DialCache({
        namespace,
        redis: { client: redisClient, readTimeoutMs: 10_000 },
        metrics,
      });
      const source = vi.fn(async () => sourceValue);
      const getPayload = dialcache.cached(source, {
        keyType: "item_id",
        useCase,
        cacheKey: () => "dark",
        trackForInvalidation: tracked,
        defaultConfig: new DialCacheKeyConfig({
          ttlSec: { [CacheLayer.REMOTE]: 60 },
          ramp: { [CacheLayer.REMOTE]: 0 },
          shadow: { ramp: 100 },
        }),
      });

      const result = await dialcache.enable(async () => await getPayload());
      expect(result).toBe(sourceValue);
      await mismatched.promise;

      expect(source).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledTimes(2);
      expect(read.mock.calls.every(([request]) =>
        request.valueKey === valueKey
        && (tracked
          ? request.watermarkKey === watermarkKey
          : !Object.hasOwn(request, "watermarkKey"))
      )).toBe(true);
      expect(metrics.shadowValidation).toHaveBeenCalledOnce();
      expect(metrics.shadowValidation).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        outcome: "mismatch",
      });
      expect(metrics.disabled).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: CacheLayer.REMOTE,
        reason: "ramped_down",
      });
      expect(metrics.request).toHaveBeenCalledTimes(2);
      expect(metrics.request).toHaveBeenNthCalledWith(1, {
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: "remote_shadow",
      });
      expect(metrics.request).toHaveBeenNthCalledWith(2, {
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: "remote_shadow",
      });
      expect(metrics.miss).not.toHaveBeenCalled();
      expect(metrics.error).not.toHaveBeenCalled();
      expect(metrics.observeGet).toHaveBeenCalledTimes(2);
      expect(metrics.observeGet).toHaveBeenNthCalledWith(1, {
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: "remote_shadow",
      }, expect.any(Number));
      expect(metrics.observeGet).toHaveBeenNthCalledWith(2, {
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: "remote_shadow",
      }, expect.any(Number));
      expect(metrics.observeSerialization).toHaveBeenCalledOnce();
      expect(metrics.observeSerialization).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: "remote_shadow",
        operation: "load",
      }, expect.any(Number));
      expect(metrics.observeSize).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      expect(await admin.get(commandOptions({ returnBuffers: true }), valueKey)).toEqual(storedFrame);
    });

    it.each([
      { name: "tracked", tracked: true },
      { name: "untracked", tracked: false },
    ])("fills a clean $name shadow miss asynchronously and serves it after Redis ramps up", async ({
      name,
      tracked,
    }) => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const namespace = `real-dark-shadow-fill-${name}`;
      const useCase = `RealDarkShadowFill${name}`;
      const rawPrefix = `${namespace}:item_id:cold`;
      const valueKey = tracked
        ? `{${rawPrefix}}#${useCase}:dialcache-frame-v1`
        : `${rawPrefix}#${useCase}:dialcache-frame-v1`;
      const watermarkKey = `{${namespace}:item_id:cold}#watermark`;
      const sourceValue = { id: "cold", version: 1 };
      const writeStarted = deferred<void>();
      const allowWrite = deferred<void>();
      const filled = deferred<void>();
      let serveFromRedis = false;

      const read = vi.fn(client.adapter.read);
      const write = vi.fn(async (request: Parameters<DialCacheRedisClient["write"]>[0]) => {
        writeStarted.resolve();
        await allowWrite.promise;
        return await client!.adapter.write(request);
      });
      const invalidate = vi.fn(client.adapter.invalidate);
      const redisClient: DialCacheRedisClient = { ...client.adapter, read, write, invalidate };
      const metrics: DialCacheMetricsAdapter = {
        request: vi.fn(),
        miss: vi.fn(),
        disabled: vi.fn(),
        error: vi.fn(),
        invalidation: vi.fn(),
        coalesced: vi.fn(),
        shadowValidation: vi.fn(({ outcome }) => {
          if (outcome === "filled") {
            filled.resolve();
          }
        }),
        observeGet: vi.fn(),
        observeFallback: vi.fn(),
        observeSerialization: vi.fn(),
        observeSize: vi.fn(),
      };
      const dialcache = new DialCache({
        namespace,
        redis: { client: redisClient, readTimeoutMs: 10_000 },
        metrics,
        cacheConfigProvider: async () => new DialCacheKeyConfig({
          ttlSec: { [CacheLayer.REMOTE]: 60 },
          ramp: { [CacheLayer.REMOTE]: serveFromRedis ? 100 : 0 },
          shadow: { ramp: serveFromRedis ? 0 : 100 },
        }),
      });
      const source = vi.fn(async () => sourceValue);
      const getPayload = dialcache.cached(source, {
        keyType: "item_id",
        useCase,
        cacheKey: () => "cold",
        trackForInvalidation: tracked,
      });

      const result = await dialcache.enable(async () => await getPayload());
      expect(result).toBe(sourceValue);
      expect(source).toHaveBeenCalledOnce();
      await writeStarted.promise;
      expect(await admin.exists(valueKey)).toBe(0);

      allowWrite.resolve();
      await filled.promise;

      expect(write).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledWith({
        valueKey,
        cacheTtlMs: 60_000,
        value: JSON.stringify(sourceValue),
      });
      expect(expectFrame(await client.adapter.read({
        valueKey,
        ...(tracked ? { watermarkKey } : {}),
      })).payload).toBe(JSON.stringify(sourceValue));
      expect(await admin.pTTL(valueKey)).toBeGreaterThan(55_000);
      expect(await admin.pTTL(valueKey)).toBeLessThanOrEqual(60_000);
      expect(await admin.exists(watermarkKey)).toBe(0);
      expect(metrics.shadowValidation).toHaveBeenCalledOnce();
      expect(metrics.shadowValidation).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        outcome: "filled",
      });
      expect(metrics.request).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: "remote_shadow",
      });
      expect(metrics.miss).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: "remote_shadow",
        reason: "value_absent",
      });
      expect(metrics.observeSerialization).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: "remote_shadow",
        operation: "dump",
      }, expect.any(Number));
      expect(metrics.observeSize).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: "remote_shadow",
      }, Buffer.byteLength(JSON.stringify(sourceValue)));

      serveFromRedis = true;
      const served = await dialcache.enable(async () => await getPayload());

      expect(served).toEqual(sourceValue);
      expect(source).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledOnce();
      expect(invalidate).not.toHaveBeenCalled();
    });

    it("skips a shadow fill behind a future watermark", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const namespace = "real-dark-shadow-fenced";
      const useCase = "RealDarkShadowFenced";
      const valueKey = `{${namespace}:item_id:fenced}#${useCase}:dialcache-frame-v1`;
      const watermarkKey = `{${namespace}:item_id:fenced}#watermark`;
      const candidateAtMs = 1_700_000_000_100;

      const read = vi.fn(client.adapter.read);
      const write = vi.fn(client.adapter.write);
      const invalidate = vi.fn(client.adapter.invalidate);
      const redisClient: DialCacheRedisClient = { ...client.adapter, read, write, invalidate };
      const fenced = deferred<void>();
      const metrics: DialCacheMetricsAdapter = {
        request: vi.fn(),
        miss: vi.fn(),
        disabled: vi.fn(),
        error: vi.fn(),
        invalidation: vi.fn(),
        coalesced: vi.fn(),
        shadowValidation: vi.fn(({ outcome }) => {
          if (outcome === "fill_fenced") {
            fenced.resolve();
          }
        }),
        observeGet: vi.fn(),
        observeFallback: vi.fn(),
        observeSerialization: vi.fn(),
        observeSize: vi.fn(),
      };
      const dialcache = new DialCache({
        namespace,
        redis: { client: redisClient, readTimeoutMs: 10_000 },
        metrics,
      });
      const sourceValue = { id: "fenced", version: 1 };
      const source = vi.fn(async () => sourceValue);
      const getPayload = dialcache.cached(source, {
        keyType: "item_id",
        useCase,
        cacheKey: () => "fenced",
        trackForInvalidation: true,
        defaultConfig: new DialCacheKeyConfig({
          ttlSec: { [CacheLayer.REMOTE]: 60 },
          ramp: { [CacheLayer.REMOTE]: 0 },
          shadow: { ramp: 100 },
        }),
      });

      const now = vi.spyOn(Date, "now").mockReturnValue(candidateAtMs);
      try {
        await client.adapter.invalidate({ watermarkKey, futureBufferMs: 0 });
        expect(await admin.get(watermarkKey)).toBe(String(candidateAtMs));

        const result = await dialcache.enable(async () => await getPayload());
        expect(result).toBe(sourceValue);
        await fenced.promise;
      } finally {
        now.mockRestore();
      }

      expect(source).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledOnce();
      expect(write).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      expect(await admin.exists(valueKey)).toBe(0);
      expect(await client.adapter.read({ valueKey, watermarkKey })).toEqual({
        kind: "miss",
        reason: "value_absent",
        observedWatermarkMs: candidateAtMs,
      });
      expect(await admin.get(watermarkKey)).toBe(String(candidateAtMs));
      expect(metrics.shadowValidation).toHaveBeenCalledOnce();
      expect(metrics.shadowValidation).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        outcome: "fill_fenced",
      });
    });

    it("keeps native writes working and reloads invalidation after SCRIPT FLUSH", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const valueKey = "script-recovery:{item:untracked}:value";

      await admin.scriptFlush();
      await expect(
        scriptClient.write({ valueKey, cacheTtlMs: 60_000, value: "untracked" }),
      ).resolves.toBeUndefined();
      expect(expectFrame(await scriptClient.read({ valueKey })).payload).toBe("untracked");

      const trackedValueKey = "script-recovery:{item:tracked}:value";
      const watermarkKey = "script-recovery:{item:tracked}:watermark";
      await admin.scriptFlush();
      await expect(
        scriptClient.write({
          valueKey: trackedValueKey,
          cacheTtlMs: 60_000,
          value: "tracked",
        }),
      ).resolves.toBeUndefined();
      expect(expectFrame(await scriptClient.read({ valueKey: trackedValueKey, watermarkKey })).payload).toBe("tracked");
      await admin.scriptFlush();
      await expect(
        scriptClient.invalidate({
          watermarkKey,
          futureBufferMs: 0,
        }),
      ).resolves.toBeUndefined();
      expect(await admin.scriptExists(INVALIDATE_CACHE_SHA1)).toEqual([true]);
      const watermark = Number(await admin.get(watermarkKey));
      expect(await scriptClient.read({ valueKey: trackedValueKey, watermarkKey })).toEqual({
        kind: "miss",
        reason: "watermark_fenced",
        observedWatermarkMs: watermark,
      });
    });

    it("classifies native absent, malformed, and watermark-fenced read states", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const valueKey = "read-paths:{item:read}:value";
      const watermarkKey = "read-paths:{item:read}:watermark";

      expect(await scriptClient.read({ valueKey })).toEqual({ kind: "miss", reason: "value_absent" });

      await admin.set(valueKey, Buffer.alloc(9));
      expect(await scriptClient.read({ valueKey })).toEqual({ kind: "miss", reason: "unclassified" });

      await admin.set(valueKey, encodeFrame("wrong-version", 0, 1_000, 2));
      expect(await scriptClient.read({ valueKey })).toEqual({ kind: "miss", reason: "unclassified" });

      await admin.del(valueKey);
      await admin.set(watermarkKey, "1000");
      expect(await scriptClient.read({ valueKey, watermarkKey })).toEqual({
        kind: "miss",
        reason: "value_absent",
        observedWatermarkMs: 1_000,
      });

      await admin.del(watermarkKey);
      await admin.set(valueKey, encodeFrame("tracked", 0, 1_000));
      expect(expectFrame(await scriptClient.read({ valueKey, watermarkKey })).payload).toBe("tracked");

      await admin.set(watermarkKey, "not-a-watermark");
      expect(await scriptClient.read({ valueKey, watermarkKey })).toEqual({ kind: "miss", reason: "unclassified" });

      await admin.set(watermarkKey, "9".repeat(400));
      expect(await scriptClient.read({ valueKey, watermarkKey })).toEqual({ kind: "miss", reason: "unclassified" });

      await admin.set(watermarkKey, "1000");
      expect(await scriptClient.read({ valueKey, watermarkKey })).toEqual({
        kind: "miss",
        reason: "watermark_fenced",
        observedWatermarkMs: 1_000,
      });

      await admin.set(watermarkKey, "999.5");
      expect(await scriptClient.read({ valueKey, watermarkKey })).toEqual({ kind: "miss", reason: "unclassified" });

      await admin.set(watermarkKey, String(Number.MAX_SAFE_INTEGER + 1));
      expect(await scriptClient.read({ valueKey, watermarkKey })).toEqual({ kind: "miss", reason: "unclassified" });
    });

    it("records a stale tracked frame as a remote miss without a read error", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;

      const namespace = "stale-miss-metrics";
      const useCase = "TrackedStaleMissMetrics";
      const id = "stale";
      const staleValueKey = `{${namespace}:item_id:${id}}#${useCase}:dialcache-frame-v1`;
      const staleWatermarkKey = `{${namespace}:item_id:${id}}#watermark`;
      await admin.set(staleValueKey, encodeFrame("stale", 0, 1_000));
      await admin.set(staleWatermarkKey, "1000");

      const metrics = {
        request: vi.fn(),
        miss: vi.fn(),
        disabled: vi.fn(),
        error: vi.fn(),
        invalidation: vi.fn(),
        coalesced: vi.fn(),
        observeGet: vi.fn(),
        observeFallback: vi.fn(),
        observeSerialization: vi.fn(),
        observeSize: vi.fn(),
      } satisfies DialCacheMetricsAdapter;
      const dialcache = new DialCache({
        namespace,
        redis: { client: scriptClient, readTimeoutMs: 10_000 },
        metrics,
      });
      const fallback = vi.fn(async () => ({ source: "fallback" }));
      const getValue = dialcache.cached(fallback, {
        keyType: "item_id",
        useCase,
        cacheKey: () => id,
        trackForInvalidation: true,
        defaultConfig: remoteOnly,
      });
      const labels = {
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: CacheLayer.REMOTE,
      } as const;
      await expect(dialcache.enable(async () => await getValue())).resolves.toEqual({ source: "fallback" });

      expect(fallback).toHaveBeenCalledOnce();
      expect(metrics.request).toHaveBeenCalledOnce();
      expect(metrics.request).toHaveBeenCalledWith(labels);
      expect(metrics.miss).toHaveBeenCalledOnce();
      expect(metrics.miss).toHaveBeenCalledWith({ ...labels, reason: "watermark_fenced" });
      expect(metrics.observeGet).toHaveBeenCalledOnce();
      expect(metrics.observeGet).toHaveBeenCalledWith(labels, expect.any(Number));
      expect(metrics.observeFallback).toHaveBeenCalledOnce();
      expect(metrics.observeFallback).toHaveBeenCalledWith(labels, expect.any(Number));
      expect(metrics.error).not.toHaveBeenCalled();
    });

    it("uses native wrong-type read semantics and repairs wrong-type keys", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const valueKey = "wrong-type:{item:read}:value";
      const watermarkKey = "wrong-type:{item:read}:watermark";

      await admin.hSet(valueKey, "field", "value");
      await admin.set(watermarkKey, "0");
      await expect(scriptClient.read({ valueKey })).rejects.toThrow(/WRONGTYPE/);
      await expect(scriptClient.read({ valueKey, watermarkKey })).resolves.toEqual({
        kind: "miss",
        reason: "value_absent",
        observedWatermarkMs: 0,
      });

      await admin.del([valueKey, watermarkKey]);
      await admin.set(valueKey, encodeFrame("cached", 0, 1_000));
      await admin.hSet(watermarkKey, "field", "value");
      await expect(scriptClient.read({ valueKey, watermarkKey })).resolves.toEqual({
        payload: "cached",
        createdAtMs: 1_000,
      });
      const invalidatedAtMs = 1_700_000_000_000;
      const now = vi.spyOn(Date, "now").mockReturnValue(invalidatedAtMs);
      try {
        await expect(scriptClient.invalidate({
          watermarkKey,
          futureBufferMs: 100,
        })).resolves.toBeUndefined();
      } finally {
        now.mockRestore();
      }
      expect(await admin.type(watermarkKey)).toBe("string");
      expect(await admin.get(watermarkKey)).toBe(String(invalidatedAtMs + 100));
      expect(await admin.pTTL(watermarkKey)).toBeGreaterThan(MIN_WATERMARK_TTL_MS - 1_000);
      expect(await admin.pTTL(watermarkKey)).toBeLessThanOrEqual(MIN_WATERMARK_TTL_MS);
      expect(await scriptClient.read({ valueKey, watermarkKey })).toEqual({
        kind: "miss",
        reason: "watermark_fenced",
        observedWatermarkMs: invalidatedAtMs + 100,
      });

      const namespace = "wrong-type-repair";
      const repairValueKey = `{${namespace}:item_id:repair}#WrongTypeRepair:dialcache-frame-v1`;
      const repairWatermarkKey = `{${namespace}:item_id:repair}#watermark`;
      await admin.hSet(repairValueKey, "field", "value");
      await admin.set(repairWatermarkKey, "0");

      let sourceCalls = 0;
      const dialcache = new DialCache({
        namespace,
        redis: { client: scriptClient, readTimeoutMs: 10_000 },
      });
      const getValue = dialcache.cached(async (id: string) => ({ id, calls: ++sourceCalls }), {
        keyType: "item_id",
        useCase: "WrongTypeRepair",
        cacheKey: (id) => id,
        trackForInvalidation: true,
        defaultConfig: remoteOnly,
      });

      const repaired = await dialcache.enable(async () => await getValue("repair"));
      const cached = await dialcache.enable(async () => await getValue("repair"));

      expect(repaired).toEqual({ id: "repair", calls: 1 });
      expect(cached).toEqual(repaired);
      expect(sourceCalls).toBe(1);
      expect(await admin.type(repairValueKey)).toBe("string");
    });

    it("treats a wrong-type tracked watermark as absent without coupling writes", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const namespace = "wrong-type-watermark";
      const useCase = "WrongTypeWatermark";
      const id = "broken";
      const valueKey = `{${namespace}:item_id:${id}}#${useCase}:dialcache-frame-v1`;
      const watermarkKey = `{${namespace}:item_id:${id}}#watermark`;
      await admin.hSet(watermarkKey, "field", "value");

      const metrics = {
        request: vi.fn(),
        miss: vi.fn(),
        disabled: vi.fn(),
        error: vi.fn(),
        invalidation: vi.fn(),
        coalesced: vi.fn(),
        observeGet: vi.fn(),
        observeFallback: vi.fn(),
        observeSerialization: vi.fn(),
        observeSize: vi.fn(),
      } satisfies DialCacheMetricsAdapter;
      const dialcache = new DialCache({
        namespace,
        redis: { client: client.adapter, readTimeoutMs: 10_000 },
        logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
        metrics,
      });
      let sourceCalls = 0;
      const getValue = dialcache.cached(async () => ({ source: "fallback", calls: ++sourceCalls }), {
        keyType: "item_id",
        useCase,
        cacheKey: () => id,
        trackForInvalidation: true,
        defaultConfig: remoteOnly,
      });
      await expect(dialcache.enable(async () => await getValue())).resolves.toEqual({
        source: "fallback",
        calls: 1,
      });
      await expect(dialcache.enable(async () => await getValue())).resolves.toEqual({
        source: "fallback",
        calls: 1,
      });

      expect(sourceCalls).toBe(1);
      expect(metrics.request).toHaveBeenCalledTimes(2);
      expect(metrics.miss).toHaveBeenCalledOnce();
      expect(metrics.error).not.toHaveBeenCalled();
      expect(await admin.type(watermarkKey)).toBe("hash");
      // Writes do not touch the wrong-type watermark and still replace the
      // value with a complete frame. Native MGET represents the watermark as
      // nil, so the next tracked read applies the same zero baseline as an
      // absent watermark.
      const stored = await admin.get(commandOptions({ returnBuffers: true }), valueKey);
      expect(stored?.[0]).toBe(1);
      expect(expectFrame(await client.adapter.read({ valueKey })).payload).toBe(
        JSON.stringify({ source: "fallback", calls: 1 }),
      );
      expect(expectFrame(await client.adapter.read({ valueKey, watermarkKey })).payload).toBe(
        JSON.stringify({ source: "fallback", calls: 1 }),
      );
    });

    it("rejects invalid raw script arguments before mutating Redis", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const valueKey = "invalid-args:{item:invalid}:value";
      const watermarkKey = "invalid-args:{item:invalid}:watermark";
      const notANumber = "not-a-number" as unknown as number;
      const validTimestampMs = 1_700_000_000_000;

      // The adapters validate native SET TTLs before issuing any command.
      for (const badTtl of [0, notANumber, Number.NaN, Number.POSITIVE_INFINITY, MAX_SUPPORTED_DURATION_MS + 1]) {
        await expect(
          client.adapter.write({ valueKey, cacheTtlMs: badTtl, value: "value" }),
        ).rejects.toThrow(RangeError);
      }
      await expect(client.raw.invalidate(watermarkKey, -1, validTimestampMs)).rejects.toThrow(
        "invalid DialCache future buffer",
      );
      await expect(client.raw.invalidate(watermarkKey, 1.5, validTimestampMs)).rejects.toThrow(
        "invalid DialCache future buffer",
      );
      await expect(client.raw.invalidate(watermarkKey, notANumber, validTimestampMs)).rejects.toThrow(
        "invalid DialCache future buffer",
      );
      await expect(client.raw.invalidate(watermarkKey, Number.NaN, validTimestampMs)).rejects.toThrow(
        "invalid DialCache future buffer",
      );
      await expect(
        client.raw.invalidate(watermarkKey, Number.POSITIVE_INFINITY, validTimestampMs),
      ).rejects.toThrow(
        "invalid DialCache future buffer",
      );
      await expect(
        client.raw.invalidate(watermarkKey, Number.NEGATIVE_INFINITY, validTimestampMs),
      ).rejects.toThrow(
        "invalid DialCache future buffer",
      );
      await expect(
        client.raw.invalidate(watermarkKey, MAX_SUPPORTED_DURATION_MS + 1, validTimestampMs),
      ).rejects.toThrow("invalid DialCache future buffer");
      await expect(
        client.raw.invalidate(watermarkKey, Number.MAX_SAFE_INTEGER, validTimestampMs),
      ).rejects.toThrow("invalid DialCache future buffer");
      for (const invalidTimestampMs of [
        -1,
        1.5,
        notANumber,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        await expect(
          client.raw.invalidate(watermarkKey, 0, invalidTimestampMs),
        ).rejects.toThrow("invalid DialCache invalidatedAtMs");
      }
      await expect(
        client.raw.invalidate(watermarkKey, 1, Number.MAX_SAFE_INTEGER),
      ).rejects.toThrow("invalid DialCache invalidatedAtMs");

      expect(await admin.exists([valueKey, watermarkKey])).toBe(0);
    });

    it("accepts maximum raw protocol durations and keeps derived TTLs in range", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const valueKey = "maximum-args:{item:untracked}:value";
      await expect(
        client.adapter.write({ valueKey, cacheTtlMs: MAX_SUPPORTED_DURATION_MS, value: "value" }),
      ).resolves.toBeUndefined();
      expect(await admin.pTTL(valueKey)).toBeGreaterThan(
        MAX_SUPPORTED_DURATION_MS - 1_000,
      );
      expect(await admin.pTTL(valueKey)).toBeLessThanOrEqual(
        MAX_SUPPORTED_DURATION_MS,
      );

      const invalidationKey = "maximum-args:{item:invalidation}:watermark";
      const invalidatedAtMs = 1_700_000_000_000;
      expect(
        await client.raw.invalidate(
          invalidationKey,
          MAX_SUPPORTED_DURATION_MS,
          invalidatedAtMs,
        ),
      ).toBe(1);
      expect(Number(await admin.get(invalidationKey))).toBe(
        invalidatedAtMs + MAX_SUPPORTED_DURATION_MS,
      );
      expect(await admin.pTTL(invalidationKey)).toBeGreaterThan(
        MAX_SUPPORTED_DURATION_MS + MAX_TRACKED_REDIS_VALUE_TTL_MS + WATERMARK_TTL_MARGIN_MS - 1_000,
      );
      expect(await admin.pTTL(invalidationKey)).toBeLessThanOrEqual(
        MAX_SUPPORTED_DURATION_MS + MAX_TRACKED_REDIS_VALUE_TTL_MS + WATERMARK_TTL_MARGIN_MS,
      );

      const maximumTimestampKey = "maximum-args:{item:timestamp}:watermark";
      expect(
        await client.raw.invalidate(maximumTimestampKey, 0, Number.MAX_SAFE_INTEGER),
      ).toBe(1);
      expect(await admin.get(maximumTimestampKey)).toBe(String(Number.MAX_SAFE_INTEGER));
    });

    it("rounds fractional native write TTLs upward", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const valueKey = "fractional-args:{item:fractional}:value";
      await expect(
        client.adapter.write({ valueKey, cacheTtlMs: 1_000.1, value: "value" }),
      ).resolves.toBeUndefined();
      expect(await admin.pTTL(valueKey)).toBeGreaterThan(900);
      expect(await admin.pTTL(valueKey)).toBeLessThanOrEqual(1_001);
    });

    it("keeps native reads working after SCRIPT FLUSH", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient: DialCacheRedisClient = client.adapter;
      const dialcache = new DialCache({ namespace: "tracked", redis: { client: scriptClient, readTimeoutMs: 10_000 } });
      let version = 1;
      let calls = 0;
      const getUser = dialcache.cached(async (id: string) => ({ id, version, calls: ++calls }), {
        keyType: "user_id",
        useCase: "RealTracked",
        cacheKey: (id) => id,
        trackForInvalidation: true,
        defaultConfig: remoteOnly,
      });

      const first = await dialcache.enable(async () => await getUser("123"));
      version = 2;
      const cached = await dialcache.enable(async () => await getUser("123"));
      await dialcache.invalidateRemote("user_id", "123");
      // The refill's client timestamp must advance past the zero-buffer
      // watermark for the next tracked read to serve it.
      await new Promise((resolve) => setTimeout(resolve, 25));
      const refreshed = await dialcache.enable(async () => await getUser("123"));
      await admin.scriptFlush();
      const afterScriptFlush = await dialcache.enable(async () => await getUser("123"));

      expect(first).toEqual({ id: "123", version: 1, calls: 1 });
      expect(cached).toEqual(first);
      expect(refreshed).toEqual({ id: "123", version: 2, calls: 2 });
      expect(afterScriptFlush).toEqual(refreshed);
    });

    it("fails open without caching malformed watermark state", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const logger = { debug: () => undefined, warn: () => undefined, error: () => undefined };
      const dialcache = new DialCache({ namespace: "malformed", redis: { client: scriptClient, readTimeoutMs: 10_000 }, logger });
      let calls = 0;
      const getUser = dialcache.cached(async (id: string) => ({ id, calls: ++calls }), {
        keyType: "user_id",
        useCase: "MalformedWatermark",
        cacheKey: (id) => id,
        trackForInvalidation: true,
        defaultConfig: remoteOnly,
      });
      await admin.set("{malformed:user_id:bad}#watermark", "0x10");

      const first = await dialcache.enable(async () => await getUser("bad"));
      const second = await dialcache.enable(async () => await getUser("bad"));

      expect(first).toEqual({ id: "bad", calls: 1 });
      expect(second).toEqual({ id: "bad", calls: 2 });
    });

    it("writes complete frames without inspecting malformed watermarks", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const valueKey = "malformed-write:{item:malformed}:value";
      const watermarkKey = "malformed-write:{item:malformed}:watermark";

      for (const malformed of ["not-a-watermark", "9".repeat(400)]) {
        await admin.set(watermarkKey, malformed, { PX: 60_000 });
        await expect(scriptClient.write({
          valueKey,
          cacheTtlMs: 60_000,
          value: "replacement",
        })).resolves.toBeUndefined();
        expect(await scriptClient.read({ valueKey, watermarkKey })).toEqual({ kind: "miss", reason: "unclassified" });
        expect(expectFrame(await scriptClient.read({ valueKey })).payload).toBe("replacement");
        const stored = await admin.get(commandOptions({ returnBuffers: true }), valueKey);
        expect(stored?.[0]).toBe(1);
        await admin.del(valueKey);
      }
    });

    it("labels malformed payload encoding through the production adapter", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const adapter = client.adapter;
      const write = vi.fn(adapter.write);
      const redisClient: DialCacheRedisClient = { ...adapter, write };
      const metrics: DialCacheMetricsAdapter = {
        request: vi.fn(),
        miss: vi.fn(),
        disabled: vi.fn(),
        error: vi.fn(),
        invalidation: vi.fn(),
        coalesced: vi.fn(),
        observeGet: vi.fn(),
        observeFallback: vi.fn(),
        observeSerialization: vi.fn(),
        observeSize: vi.fn(),
      };
      const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const namespace = "bad-encoding";
      const valueKey = `{${namespace}:user_id:bad}#RealMalformedEncoding:dialcache-frame-v1`;
      const watermarkKey = `{${namespace}:user_id:bad}#watermark`;
      await admin.set(valueKey, encodeFrame("malformed", 2), { PX: 60_000 });
      await admin.set(watermarkKey, "0", { PX: 60_000 });

      const dialcache = new DialCache({ namespace, redis: { client: redisClient, readTimeoutMs: 10_000 }, logger, metrics });
      let calls = 0;
      const getUser = dialcache.cached(async (id: string) => ({ id, calls: ++calls }), {
        keyType: "user_id",
        useCase: "RealMalformedEncoding",
        cacheKey: (id) => id,
        trackForInvalidation: true,
        defaultConfig: remoteOnly,
      });

      const value = await dialcache.enable(async () => await getUser("bad"));

      expect(value).toEqual({ id: "bad", calls: 1 });
      expect(write).not.toHaveBeenCalled();
      expect(metrics.error).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase: "RealMalformedEncoding",
        keyType: "user_id",
        layer: CacheLayer.REMOTE,
        error: "cache_read",
        inFallback: false,
      });
      expect(logger.warn).toHaveBeenCalledWith(
        "Error getting value from Redis cache",
        expect.objectContaining({ name: "DialCacheRedisPayloadEncodingError" }),
      );
    });

    it("creates missing and repairs malformed invalidation watermarks", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const missingKey = "invalidate-paths:{item:missing}:watermark";
      const invalidatedAtMs = 1_700_000_000_000;
      const now = vi.spyOn(Date, "now").mockReturnValue(invalidatedAtMs);
      try {
        await scriptClient.invalidate({ watermarkKey: missingKey, futureBufferMs: 100 });

        const created = Number(await admin.get(missingKey));
        expect(created).toBe(invalidatedAtMs + 100);
        expect(await admin.pTTL(missingKey)).toBeGreaterThan(MIN_WATERMARK_TTL_MS - 1_000);
        expect(await admin.pTTL(missingKey)).toBeLessThanOrEqual(MIN_WATERMARK_TTL_MS);

        for (const [suffix, malformed] of [
          ["syntax", "not-a-watermark"],
          ["fractional", "1700000030000.5"],
          ["unsafe", String(Number.MAX_SAFE_INTEGER + 1)],
          ["overflow", "9".repeat(400)],
        ] as const) {
          const watermarkKey = `invalidate-paths:{item:${suffix}}:watermark`;
          await admin.set(watermarkKey, malformed, { PX: 1_000 });
          await scriptClient.invalidate({ watermarkKey, futureBufferMs: 0 });
          expect(Number(await admin.get(watermarkKey))).toBe(invalidatedAtMs);
          expect(await admin.pTTL(watermarkKey)).toBeGreaterThan(MIN_WATERMARK_TTL_MS - 1_000);
          expect(await admin.pTTL(watermarkKey)).toBeLessThanOrEqual(MIN_WATERMARK_TTL_MS);
        }
      } finally {
        now.mockRestore();
      }
    });

    it("keeps persistent invalidation watermarks persistent", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const watermarkKey = "invalidate-persistent:{item:persistent}:watermark";
      await admin.set(watermarkKey, "1");

      await scriptClient.invalidate({ watermarkKey, futureBufferMs: 0 });

      expect(Number(await admin.get(watermarkKey))).toBeGreaterThan(1);
      expect(await admin.pTTL(watermarkKey)).toBe(-1);
    });

    it("does not create or rewrite watermarks on writes", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const missingValueKey = "write-missing:{item:missing}:value";
      const missingWatermarkKey = "write-missing:{item:missing}:watermark";
      await scriptClient.write({ valueKey: missingValueKey, cacheTtlMs: 2_000, value: "cached" });
      expect(await admin.exists(missingWatermarkKey)).toBe(0);
      expect(expectFrame(await scriptClient.read({
        valueKey: missingValueKey,
        watermarkKey: missingWatermarkKey,
      })).payload).toBe("cached");

      const persistentValueKey = "write-persistent:{item:persistent}:value";
      const persistentWatermarkKey = "write-persistent:{item:persistent}:watermark";
      await admin.set(persistentWatermarkKey, "2");

      await expect(
        scriptClient.write({
          valueKey: persistentValueKey,
          cacheTtlMs: 2_000,
          value: "cached",
        }),
      ).resolves.toBeUndefined();
      expect(await admin.get(persistentWatermarkKey)).toBe("2");
      expect(await admin.pTTL(persistentWatermarkKey)).toBe(-1);
    });

    it("fences complete writes during the buffer without extending the watermark", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const valueKey = "protocol:{item:ttl}:value";
      const watermarkKey = "protocol:{item:ttl}:watermark";
      const writeRequest = {
        valueKey,
        cacheTtlMs: 2_000,
        value: "cached",
      };
      const invalidatedAtMs = 1_700_000_000_000;
      const now = vi.spyOn(Date, "now").mockReturnValue(invalidatedAtMs);
      try {
        await scriptClient.write(writeRequest);
        expect(await admin.exists(watermarkKey)).toBe(0);
        expect(expectFrame(await scriptClient.read({ valueKey, watermarkKey })).payload).toBe("cached");

        await scriptClient.invalidate({ watermarkKey, futureBufferMs: 100 });
        expect(await scriptClient.read({ valueKey, watermarkKey })).toEqual({
          kind: "miss",
          reason: "watermark_fenced",
          observedWatermarkMs: invalidatedAtMs + 100,
        });
        const watermarkBeforeWrite = await admin.get(watermarkKey);
        const watermarkTtlBeforeWrite = await admin.pTTL(watermarkKey);
        await scriptClient.write({ ...writeRequest, value: "behind-watermark" });
        expect(expectFrame(await scriptClient.read({ valueKey })).payload).toBe("behind-watermark");
        expect(await scriptClient.read({ valueKey, watermarkKey })).toEqual({
          kind: "miss",
          reason: "watermark_fenced",
          observedWatermarkMs: invalidatedAtMs + 100,
        });
        expect(await admin.get(watermarkKey)).toBe(watermarkBeforeWrite);
        const watermarkTtlAfterWrite = await admin.pTTL(watermarkKey);
        expect(watermarkTtlAfterWrite).toBeGreaterThan(watermarkTtlBeforeWrite - 1_000);
        expect(watermarkTtlAfterWrite).toBeLessThanOrEqual(watermarkTtlBeforeWrite);
        const ttlBeforeRead = watermarkTtlAfterWrite;
        await scriptClient.read({ valueKey, watermarkKey });
        expect(await admin.pTTL(watermarkKey)).toBeLessThanOrEqual(ttlBeforeRead);

        now.mockReturnValue(invalidatedAtMs + 101);
        await scriptClient.write({ ...writeRequest, value: "fresh" });
        expect(expectFrame(await scriptClient.read({ valueKey, watermarkKey })).payload).toBe("fresh");
      } finally {
        now.mockRestore();
      }
    });

    it("documents that losing a watermark removes its read-time invalidation fence", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const valueKey = "watermark-loss:{item:tracked}:value";
      const watermarkKey = "watermark-loss:{item:tracked}:watermark";
      await scriptClient.write({ valueKey, cacheTtlMs: 60_000, value: "stale" });

      await scriptClient.invalidate({ watermarkKey, futureBufferMs: 60_000 });
      const watermark = Number(await admin.get(watermarkKey));
      expect(await scriptClient.read({ valueKey, watermarkKey })).toEqual({
        kind: "miss",
        reason: "watermark_fenced",
        observedWatermarkMs: watermark,
      });

      await admin.del(watermarkKey);

      expect(await admin.exists(watermarkKey)).toBe(0);
      expect(expectFrame(await scriptClient.read({ valueKey, watermarkKey })).payload).toBe("stale");
    });

  });

  it("preserves a watermark when GET fails for a reason other than WRONGTYPE", async () => {
    if (admin === undefined) {
      throw new Error("Redis test clients did not start");
    }
    const username = "dialcache-invalidation-no-get";
    const password = "dialcache-invalidation-test-password";
    const watermarkKey = "invalidation-acl:{item:protected}:watermark";
    const existingWatermark = "1800000000000";
    await admin.set(watermarkKey, existingWatermark, { PX: 60_000 });
    await admin.sendCommand([
      "ACL",
      "SETUSER",
      username,
      "reset",
      "on",
      `>${password}`,
      "~*",
      "+eval",
      "+set",
      "+pttl",
      "-get",
    ]);
    const restricted = admin.duplicate({ username, password });
    restricted.on("error", () => undefined);
    try {
      await restricted.connect();
      await expect(restricted.eval(INVALIDATE_CACHE_SCRIPT, {
        keys: [watermarkKey],
        arguments: ["0", "1700000000000"],
      })).rejects.toThrow(/ACL|can't run this command|no permissions/);
      expect(await admin.get(watermarkKey)).toBe(existingWatermark);
    } finally {
      await restricted.quit().catch(() => undefined);
      await admin.sendCommand(["ACL", "DELUSER", username]);
    }
  });

  it("uses one wire format across node-redis and Valkey GLIDE", async () => {
    if (admin === undefined || harnesses === undefined) {
      throw new Error("Redis test clients did not start");
    }
    await admin.flushAll();
    const nodeRedis = harnesses.nodeRedis.adapter;
    const valkeyGlide = harnesses.valkeyGlide.adapter;
    const binary = Buffer.from([0, 0xff, 0xc3, 0x28, 0x80]);

    await nodeRedis.write({ valueKey: "interop:node-to-glide", cacheTtlMs: 60_000, value: binary });
    expect(expectFrame(await valkeyGlide.read({ valueKey: "interop:node-to-glide" })).payload).toEqual(binary);

    await valkeyGlide.write({ valueKey: "interop:glide-to-node", cacheTtlMs: 60_000, value: "hello" });
    expect(expectFrame(await nodeRedis.read({ valueKey: "interop:glide-to-node" })).payload).toBe("hello");

    const nodeTrackedValueKey = "interop:{node-tracked}:value";
    const nodeTrackedWatermarkKey = "interop:{node-tracked}:watermark";
    await nodeRedis.write({
      valueKey: nodeTrackedValueKey,
      cacheTtlMs: 60_000,
      value: binary,
    });
    expect(expectFrame(await valkeyGlide.read({
      valueKey: nodeTrackedValueKey,
      watermarkKey: nodeTrackedWatermarkKey,
    })).payload).toEqual(binary);

    const glideTrackedValueKey = "interop:{glide-tracked}:value";
    const glideTrackedWatermarkKey = "interop:{glide-tracked}:watermark";
    await valkeyGlide.write({
      valueKey: glideTrackedValueKey,
      cacheTtlMs: 60_000,
      value: "tracked",
    });
    expect(expectFrame(await nodeRedis.read({
      valueKey: glideTrackedValueKey,
      watermarkKey: glideTrackedWatermarkKey,
    })).payload).toBe("tracked");
  });
});
