import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import type { RedisCachePayload } from "../redis-client.js";

/**
 * Payload envelope for Redis values, stored inside the frame's opaque payload
 * region. Byte 0 of a binary payload written by this version or later:
 *
 * - 0x00: escape prefix. The remaining bytes are raw serializer output whose
 *   own first byte would collide with this envelope; readers strip the prefix
 *   and never attempt decompression.
 * - 0x01: zstd frame of a UTF-8 string payload.
 * - 0x02: zstd frame of a binary payload.
 *
 * Raw output is escaped on every write, including with compression disabled,
 * so decoding stays exact for entries written at or above this version.
 * Entries written by older releases have no envelope: a legacy binary payload
 * whose first bytes mimic the envelope (0x01/0x02 followed by a zstd-parsable
 * stream, or 0x00 followed by another envelope byte) is misread until it
 * expires. See docs/upgrading.md for this residual and the key-versioning
 * migration for serializers whose output can begin with these bytes.
 */
export const MARKER_ESCAPED_RAW = 0x00;
export const MARKER_ZSTD_UTF8 = 0x01;
export const MARKER_ZSTD_BINARY = 0x02;

export const DEFAULT_COMPRESSION_THRESHOLD_BYTES = 4096;
export const DEFAULT_ZSTD_LEVEL = 3;

/**
 * Ceiling on a single decompressed payload, matching Redis's own 512 MiB
 * value limit. The write side refuses to compress larger serialized values,
 * so nothing writable becomes unreadable; the read side enforces the same
 * bound through zstd's maxOutputLength so a tiny stored frame can never force
 * a multi-gigabyte synchronous allocation on the event loop.
 */
export const MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;

/** Write-side compression policy for serialized Redis payloads. */
export interface CompressionConfig {
  /**
   * Payloads of at least this many serialized bytes are compressed. Must be a
   * positive safe integer. Defaults to 4096.
   */
  readonly thresholdBytes?: number;
  /** zstd compression level between 1 and 22. Defaults to 3. */
  readonly level?: number;
}

export type CompressionWriteOutcome = "compressed" | "below_threshold" | "not_smaller" | "write_over_limit";
export type CompressionReadOutcome = "passthrough" | "decompressed" | "fallback_raw" | "read_over_limit";

export interface CompressPayloadResult {
  readonly payload: RedisCachePayload;
  readonly outcome: CompressionWriteOutcome;
  readonly originalBytes: number;
  readonly storedBytes: number;
}

export interface DecompressPayloadResult {
  readonly payload: RedisCachePayload;
  readonly outcome: CompressionReadOutcome;
}

/**
 * Resolve the write-side compression policy. Null means compression is
 * disabled; escaping still applies to writes and reads still decompress, so
 * disabling never strands existing entries.
 */
export function resolveCompressionConfig(
  config: CompressionConfig | false | undefined,
): Required<CompressionConfig> | null {
  if (config === false) {
    return null;
  }
  // Reject untyped "off" sentinels loudly: null (or any non-object) would
  // otherwise fall through to the enabled defaults, silently inverting intent.
  if (config !== undefined && (config === null || typeof config !== "object")) {
    throw new TypeError("RedisConfig.compression must be an options object, false, or undefined");
  }

  const thresholdBytes = config?.thresholdBytes ?? DEFAULT_COMPRESSION_THRESHOLD_BYTES;
  if (!Number.isSafeInteger(thresholdBytes) || thresholdBytes <= 0) {
    throw new TypeError("RedisConfig.compression.thresholdBytes must be a positive safe integer");
  }
  const level = config?.level ?? DEFAULT_ZSTD_LEVEL;
  if (!Number.isSafeInteger(level) || level < 1 || level > 22) {
    throw new TypeError("RedisConfig.compression.level must be an integer between 1 and 22");
  }
  // Fail at construction on runtimes without node:zlib zstd (Node < 22.15)
  // instead of degrading every large write into a warn-logged put failure.
  // Disabled compression stays constructible there: escaping needs no zlib and
  // marked reads already degrade to misses through the fallback path.
  if (typeof zstdCompressSync !== "function" || typeof zstdDecompressSync !== "function") {
    throw new TypeError(
      "RedisConfig.compression requires zstd support in node:zlib (Node >= 22.15.0 or >= 23.8.0); set compression: false on older runtimes",
    );
  }
  return { thresholdBytes, level };
}

/**
 * Prefix raw binary output whose first byte would collide with the payload
 * envelope. Applies to every write, including with compression disabled,
 * because reads interpret the envelope unconditionally.
 */
export function escapeRawPayload(payload: RedisCachePayload): RedisCachePayload {
  if (!Buffer.isBuffer(payload)) {
    return payload;
  }
  const first = payload[0];
  if (first === undefined || first > MARKER_ZSTD_BINARY) {
    return payload;
  }
  const escaped = Buffer.allocUnsafe(payload.length + 1);
  escaped[0] = MARKER_ESCAPED_RAW;
  payload.copy(escaped, 1);
  return escaped;
}

function rawResult(
  payload: RedisCachePayload,
  outcome: CompressionWriteOutcome,
  originalBytes: number,
): CompressPayloadResult {
  const escaped = escapeRawPayload(payload);
  const storedBytes = Buffer.isBuffer(escaped) ? escaped.length : originalBytes;
  return { payload: escaped, outcome, originalBytes, storedBytes };
}

/**
 * Compress a serialized payload when it meets the configured threshold and
 * compression actually shrinks it, marker byte included. Payloads stored raw
 * are byte-identical to their serialized form except for the escape prefix on
 * binary output beginning with an envelope byte.
 */
export function compressPayload(
  payload: RedisCachePayload,
  config: Required<CompressionConfig>,
  maxDecompressedBytes = MAX_DECOMPRESSED_BYTES,
): CompressPayloadResult {
  const isBinary = Buffer.isBuffer(payload);
  const originalBytes = isBinary ? payload.length : Buffer.byteLength(payload, "utf8");
  if (originalBytes < config.thresholdBytes) {
    return rawResult(payload, "below_threshold", originalBytes);
  }
  // Values the read-side cap would reject must never be stored compressed;
  // stored raw they are subject to Redis's own value limit instead.
  if (originalBytes > maxDecompressedBytes) {
    return rawResult(payload, "write_over_limit", originalBytes);
  }

  const compressed = zstdCompressSync(isBinary ? payload : Buffer.from(payload, "utf8"), {
    params: { [zlibConstants.ZSTD_c_compressionLevel]: config.level },
  });
  const raw = rawResult(payload, "not_smaller", originalBytes);
  const markedBytes = 1 + compressed.length;
  if (markedBytes >= raw.storedBytes) {
    return raw;
  }

  const marked = Buffer.allocUnsafe(markedBytes);
  marked[0] = isBinary ? MARKER_ZSTD_BINARY : MARKER_ZSTD_UTF8;
  compressed.copy(marked, 1);
  return { payload: marked, outcome: "compressed", originalBytes, storedBytes: markedBytes };
}

/**
 * Reverse of compressPayload, applied unconditionally on reads so disabling
 * compression never orphans previously written entries.
 *
 * Escaped payloads (0x00 followed by an envelope byte) have the prefix
 * stripped and are never decompressed. A marked payload that zstd rejects, or
 * whose decompressed size would exceed the cap, is returned unchanged; the
 * caller's load then fails and the existing miss path repopulates the entry.
 * zstd acceptance of a non-DialCache payload is possible only for legacy
 * entries written before escaping existed (see docs/upgrading.md). Never
 * mutates the input and holds no state, keeping repeated loads of a retained
 * payload independent.
 */
export function decompressPayload(
  payload: RedisCachePayload,
  maxDecompressedBytes = MAX_DECOMPRESSED_BYTES,
): DecompressPayloadResult {
  if (!Buffer.isBuffer(payload)) {
    return { payload, outcome: "passthrough" };
  }
  const marker = payload[0];
  if (marker === MARKER_ESCAPED_RAW) {
    const next = payload[1];
    // Only strip a prefix the escape could have produced: every escaped
    // payload has an envelope byte at offset 1. Legacy binary output that
    // merely begins with 0x00 keeps passing through untouched.
    return next !== undefined && next <= MARKER_ZSTD_BINARY
      ? { payload: payload.subarray(1), outcome: "passthrough" }
      : { payload, outcome: "passthrough" };
  }
  if (marker !== MARKER_ZSTD_UTF8 && marker !== MARKER_ZSTD_BINARY) {
    return { payload, outcome: "passthrough" };
  }

  let decompressed: Buffer;
  try {
    decompressed = zstdDecompressSync(payload.subarray(1), { maxOutputLength: maxDecompressedBytes });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { payload, outcome: code === "ERR_BUFFER_TOO_LARGE" ? "read_over_limit" : "fallback_raw" };
  }
  return {
    payload: marker === MARKER_ZSTD_UTF8 ? decompressed.toString("utf8") : decompressed,
    outcome: "decompressed",
  };
}
