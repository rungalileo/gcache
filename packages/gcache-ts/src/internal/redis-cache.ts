import { performance } from "node:perf_hooks";

import { CacheLayer, DEFAULT_WATERMARK_TTL_SEC, type CacheConfigProvider, type CacheRampSampler } from "../config.js";
import { invalidationPrefix, redisClusterHashTag, type GCacheKey } from "../key.js";
import type { GCacheMetricsAdapter } from "../metrics.js";
import { labelsFor } from "../metrics.js";
import { JsonSerializer, type Serializer } from "../serializer.js";
import type { CacheGetResult } from "./cache-result.js";
import { resolveLayerConfigResult } from "./runtime-config.js";

export type Awaitable<T> = T | Promise<T>;
export type RedisStoredValue = string | Buffer;

export interface RedisCommandClient {
  get(key: string): Awaitable<RedisStoredValue | null>;
  del(key: string): Awaitable<number>;
  flushAll?(): Awaitable<unknown>;
  flushall?(): Awaitable<unknown>;
  setEx?(key: string, ttlSec: number, value: RedisStoredValue): Awaitable<unknown>;
  setex?(key: string, ttlSec: number, value: RedisStoredValue): Awaitable<unknown>;
  set?(key: string, value: RedisStoredValue, options: { EX: number }): Awaitable<unknown>;
}

export type RedisClientFactory = () => Awaitable<RedisCommandClient>;

export interface RedisConfig {
  readonly client?: RedisCommandClient;
  readonly createClient?: RedisClientFactory;
  readonly keyPrefix?: string;
  readonly serializer?: Serializer<unknown>;
  readonly watermarkTtlSec?: number;
}

export interface RedisValueEnvelope {
  readonly version: 1;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly encoding: "utf8" | "base64";
  readonly payload: string;
}

interface RedisCacheOptions {
  readonly configProvider: CacheConfigProvider;
  readonly rampSampler: CacheRampSampler;
  readonly redis: RedisConfig;
  readonly metrics: GCacheMetricsAdapter | null;
}

const ENVELOPE_VERSION = 1;
const defaultSerializer = new JsonSerializer<unknown>();

export class RedisCache {
  private readonly configProvider: CacheConfigProvider;
  private readonly rampSampler: CacheRampSampler;
  private readonly keyPrefix: string;
  private readonly defaultSerializer: Serializer<unknown>;
  private readonly watermarkTtlSec: number;
  private readonly createClient: RedisClientFactory | null;
  private readonly metrics: GCacheMetricsAdapter | null;
  private clientPromise: Promise<RedisCommandClient> | null;

  constructor(options: RedisCacheOptions) {
    this.configProvider = options.configProvider;
    this.rampSampler = options.rampSampler;
    this.keyPrefix = options.redis.keyPrefix ?? "";
    this.defaultSerializer = options.redis.serializer ?? defaultSerializer;
    this.watermarkTtlSec = options.redis.watermarkTtlSec ?? DEFAULT_WATERMARK_TTL_SEC;
    this.metrics = options.metrics;

    if (options.redis.client === undefined && options.redis.createClient === undefined) {
      throw new Error("Redis config requires either client or createClient");
    }

    this.createClient = options.redis.createClient ?? null;
    this.clientPromise = options.redis.client === undefined ? null : Promise.resolve(options.redis.client);
  }

  async get<T>(key: GCacheKey): Promise<T | undefined> {
    const result = await this.getResult<T>(key);
    return result.status === "hit" ? result.value : undefined;
  }

  async getResult<T>(key: GCacheKey): Promise<CacheGetResult<T>> {
    const layerConfig = await this.resolveRemoteLayerConfig(key);
    if (layerConfig.status === "disabled") {
      return layerConfig;
    }

    const client = await this.resolveClient();
    const redisKey = this.redisKey(key);
    const watermarkMs = key.trackForInvalidation ? await this.getWatermarkMs(client, key) : null;
    const raw = await client.get(redisKey);
    if (raw === null) {
      return { status: "miss", config: layerConfig.config, ...(watermarkIsActive(watermarkMs) ? { skipCacheWrite: true } : {}) };
    }

    let envelope: RedisValueEnvelope;
    try {
      envelope = this.parseEnvelope(raw);
    } catch {
      await client.del(redisKey);
      return { status: "miss", config: layerConfig.config, ...(watermarkIsActive(watermarkMs) ? { skipCacheWrite: true } : {}) };
    }
    if (envelope.expiresAtMs <= Date.now()) {
      await client.del(redisKey);
      return { status: "miss", config: layerConfig.config, ...(watermarkIsActive(watermarkMs) ? { skipCacheWrite: true } : {}) };
    }
    if (watermarkMs !== null && watermarkMs >= envelope.createdAtMs) {
      await client.del(redisKey);
      return { status: "miss", config: layerConfig.config, ...(watermarkIsActive(watermarkMs) ? { skipCacheWrite: true } : {}) };
    }

    const start = performance.now();
    try {
      const value = (await this.serializerFor(key).load(this.decodePayload(envelope))) as T;
      return { status: "hit", value };
    } finally {
      this.recordMetric((metrics) => metrics.observeSerialization({ ...labelsFor(key, CacheLayer.REMOTE), operation: "load" }, elapsedSeconds(start)));
    }
  }

  async put<T>(key: GCacheKey, value: T, config?: { readonly ttlSec: number }): Promise<boolean> {
    const ttlSec = config?.ttlSec ?? await this.resolveRemoteTtlSec(key);
    if (ttlSec === null) {
      return true;
    }

    const client = await this.resolveClient();
    if (key.trackForInvalidation && watermarkIsActive(await this.getWatermarkMs(client, key))) {
      return false;
    }

    const now = Date.now();
    const start = performance.now();
    let payload: string | Buffer;
    try {
      payload = await this.serializerFor(key).dump(value);
    } finally {
      this.recordMetric((metrics) => metrics.observeSerialization({ ...labelsFor(key, CacheLayer.REMOTE), operation: "dump" }, elapsedSeconds(start)));
    }
    this.recordMetric((metrics) => metrics.observeSize(labelsFor(key, CacheLayer.REMOTE), payloadSize(payload)));
    const envelope: RedisValueEnvelope = {
      version: ENVELOPE_VERSION,
      createdAtMs: now,
      expiresAtMs: now + ttlSec * 1000,
      encoding: Buffer.isBuffer(payload) ? "base64" : "utf8",
      payload: Buffer.isBuffer(payload) ? payload.toString("base64") : payload,
    };

    await this.setWithTtl(client, this.redisKey(key), JSON.stringify(envelope), ttlSec);
    return true;
  }

  async delete(key: GCacheKey): Promise<boolean> {
    const client = await this.resolveClient();
    return (await client.del(this.redisKey(key))) > 0;
  }

  async invalidate(keyType: string, id: string, futureBufferMs = 0, urnPrefix = "urn"): Promise<void> {
    const client = await this.resolveClient();
    const watermarkMs = Date.now() + futureBufferMs;
    await this.setWithTtl(client, this.redisWatermarkKey(urnPrefix, keyType, id), String(watermarkMs), this.watermarkTtlSec);
  }

  async flushAll(): Promise<void> {
    const client = await this.resolveClient();
    const flushAll = client.flushAll ?? client.flushall;
    if (flushAll === undefined) {
      throw new Error("Redis client does not implement flushAll/flushall");
    }
    await flushAll.call(client);
  }

  redisKey(key: GCacheKey): string {
    return `${this.keyPrefix}${key.urn}`;
  }

  redisWatermarkKey(urnPrefix: string, keyType: string, id: string): string {
    return `${this.keyPrefix}${redisClusterHashTag(invalidationPrefix(urnPrefix, keyType, id))}#watermark`;
  }

  private async getWatermarkMs(client: RedisCommandClient, key: GCacheKey): Promise<number | null> {
    const raw = await client.get(this.redisWatermarkKeyFromKey(key));
    if (raw === null) {
      return null;
    }
    const value = Number(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw);
    if (!Number.isFinite(value)) {
      throw new Error("Invalid GCache Redis watermark");
    }
    return value;
  }

  private redisWatermarkKeyFromKey(key: GCacheKey): string {
    return this.redisWatermarkKey(key.urnPrefix, key.keyType, key.id);
  }

  private async resolveClient(): Promise<RedisCommandClient> {
    if (this.clientPromise === null) {
      if (this.createClient === null) {
        throw new Error("Redis client has not been configured");
      }
      this.clientPromise = Promise.resolve(this.createClient());
    }
    try {
      return await this.clientPromise;
    } catch (error) {
      if (this.createClient !== null) {
        this.clientPromise = null;
      }
      throw error;
    }
  }

  private serializerFor(key: GCacheKey): Serializer<unknown> {
    return key.serializer ?? this.defaultSerializer;
  }

  private decodePayload(envelope: RedisValueEnvelope): string | Buffer {
    return envelope.encoding === "base64" ? Buffer.from(envelope.payload, "base64") : envelope.payload;
  }

  private parseEnvelope(raw: RedisStoredValue): RedisValueEnvelope {
    const parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw) as Partial<RedisValueEnvelope>;
    if (
      parsed.version !== ENVELOPE_VERSION ||
      typeof parsed.createdAtMs !== "number" ||
      typeof parsed.expiresAtMs !== "number" ||
      (parsed.encoding !== "utf8" && parsed.encoding !== "base64") ||
      typeof parsed.payload !== "string"
    ) {
      throw new Error("Invalid GCache Redis envelope");
    }
    return parsed as RedisValueEnvelope;
  }

  private async setWithTtl(
    client: RedisCommandClient,
    key: string,
    value: RedisStoredValue,
    ttlSec: number,
  ): Promise<void> {
    if (client.setEx !== undefined) {
      await client.setEx(key, ttlSec, value);
      return;
    }
    if (client.setex !== undefined) {
      await client.setex(key, ttlSec, value);
      return;
    }
    if (client.set !== undefined) {
      await client.set(key, value, { EX: ttlSec });
      return;
    }
    throw new Error("Redis client does not implement setEx/setex/set");
  }

  private async resolveRemoteLayerConfig(key: GCacheKey) {
    return await resolveLayerConfigResult({
      configProvider: this.configProvider,
      key,
      layer: CacheLayer.REMOTE,
      rampSampler: this.rampSampler,
    });
  }

  private async resolveRemoteTtlSec(key: GCacheKey): Promise<number | null> {
    const layerConfig = await this.resolveRemoteLayerConfig(key);
    return layerConfig.status === "enabled" ? layerConfig.config.ttlSec : null;
  }

  private recordMetric(record: (metrics: GCacheMetricsAdapter) => void): void {
    if (this.metrics === null) {
      return;
    }
    try {
      record(this.metrics);
    } catch {
      // Metrics adapters must not affect cache correctness or application fallbacks.
    }
  }
}

function payloadSize(payload: string | Buffer): number {
  return Buffer.isBuffer(payload) ? payload.byteLength : Buffer.byteLength(payload);
}

function elapsedSeconds(startMs: number): number {
  return Math.max((performance.now() - startMs) / 1000, 0);
}

function watermarkIsActive(watermarkMs: number | null): boolean {
  return watermarkMs !== null && watermarkMs >= Date.now();
}
