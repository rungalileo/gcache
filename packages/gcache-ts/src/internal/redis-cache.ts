import { performance } from "node:perf_hooks";

import { CacheLayer, type CacheConfigProvider, type CacheRampSampler } from "../config.js";
import type { GCacheKey } from "../key.js";
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
  private readonly createClient: RedisClientFactory | null;
  private readonly metrics: GCacheMetricsAdapter | null;
  private clientPromise: Promise<RedisCommandClient> | null;

  constructor(options: RedisCacheOptions) {
    this.configProvider = options.configProvider;
    this.rampSampler = options.rampSampler;
    this.keyPrefix = options.redis.keyPrefix ?? "";
    this.defaultSerializer = options.redis.serializer ?? defaultSerializer;
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
    const raw = await client.get(this.redisKey(key));
    if (raw === null) {
      return { status: "miss" };
    }

    const envelope = this.parseEnvelope(raw);
    if (envelope.expiresAtMs <= Date.now()) {
      await client.del(this.redisKey(key));
      return { status: "miss" };
    }

    const start = performance.now();
    try {
      const value = (await this.serializerFor(key).load(this.decodePayload(envelope))) as T;
      return { status: "hit", value };
    } finally {
      this.metrics?.observeSerialization({ ...labelsFor(key, CacheLayer.REMOTE), operation: "load" }, elapsedSeconds(start));
    }
  }

  async put<T>(key: GCacheKey, value: T): Promise<void> {
    const layerConfig = await this.resolveRemoteLayerConfig(key);
    if (layerConfig.status === "disabled") {
      return;
    }

    const client = await this.resolveClient();
    const now = Date.now();
    const start = performance.now();
    let payload: string | Buffer;
    try {
      payload = await this.serializerFor(key).dump(value);
    } finally {
      this.metrics?.observeSerialization({ ...labelsFor(key, CacheLayer.REMOTE), operation: "dump" }, elapsedSeconds(start));
    }
    this.metrics?.observeSize(labelsFor(key, CacheLayer.REMOTE), payloadSize(payload));
    const envelope: RedisValueEnvelope = {
      version: ENVELOPE_VERSION,
      createdAtMs: now,
      expiresAtMs: now + layerConfig.config.ttlSec * 1000,
      encoding: Buffer.isBuffer(payload) ? "base64" : "utf8",
      payload: Buffer.isBuffer(payload) ? payload.toString("base64") : payload,
    };

    await this.setWithTtl(client, this.redisKey(key), JSON.stringify(envelope), layerConfig.config.ttlSec);
  }

  async delete(key: GCacheKey): Promise<boolean> {
    const client = await this.resolveClient();
    return (await client.del(this.redisKey(key))) > 0;
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

  private async resolveClient(): Promise<RedisCommandClient> {
    if (this.clientPromise === null) {
      if (this.createClient === null) {
        throw new Error("Redis client has not been configured");
      }
      this.clientPromise = Promise.resolve(this.createClient());
    }
    return await this.clientPromise;
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
}

function payloadSize(payload: string | Buffer): number {
  return Buffer.isBuffer(payload) ? payload.byteLength : Buffer.byteLength(payload);
}

function elapsedSeconds(startMs: number): number {
  return Math.max((performance.now() - startMs) / 1000, 0);
}
