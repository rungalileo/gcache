/**
 * Public frame protocol surface for adapter authors and out-of-band tooling.
 *
 * These exports encode and decode complete frames, validate mutation replies,
 * guard the write-TTL acceptance domain, and carry the invalidation Lua source
 * the bundled adapters dispatch. The invalidation script accepts
 * `[futureBufferMs, invalidatedAtMs]`; both are nonnegative safe integers, and
 * the application-clock timestamp must remain stable through one logical
 * dispatch and its recovery. The
 * payload region past the header is opaque at this layer: entries written by
 * DialCache releases with payload compression may begin with a compression
 * envelope byte (0x00 escape, 0x01/0x02 zstd; see docs/redis.md, Compression),
 * which DialCache core interprets above the adapter. Adapters must never
 * decompress or otherwise rewrite payload bytes.
 */
export { ceilSupportedCacheTtlMs } from "./internal/duration.js";
export type { CacheMissReason } from "./metrics.js";
export { INVALIDATE_CACHE_SCRIPT } from "./internal/redis-scripts.js";
export {
  decodeRedisReadResult,
  decodeTrackedRedisReadResult,
  encodeRedisFrame,
} from "./internal/redis-payload.js";
export { isRedisReadMiss } from "./redis-client.js";
export type {
  DecodedRedisFrame,
  RedisReadMiss,
  RedisReadResult,
} from "./redis-client.js";
export {
  validateRedisScriptInvalidationReply,
  validateRedisSetReply,
} from "./internal/redis-script-reply.js";
