import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  GCache,
  GCacheKey,
  GCacheKeyConfig,
  type RedisCommandClient,
  type RedisStoredValue,
} from "../src/index.js";

// TypeScript half of the shared cross-language envelope conformance suite.
//
// Both this file and tests/test_conformance.py read conformance/envelope_vectors.json.
// Neither may hardcode a case: one source of truth is the entire point, because parity used
// to be asserted by hand-mirrored literals in two suites running in separate CI workflows --
// so a divergence was only ever caught by a human reading both. Two escaped that way and
// were found in review rather than by a test.
//
// Driven through the public read path rather than parseEnvelope directly. parseEnvelope is
// private, and more importantly a vector suite that calls it would prove the parser correct
// without proving it is WIRED IN -- the same mistake a Python watermark test made, where
// reverting the call site left every parser test green.

const here = dirname(fileURLToPath(import.meta.url));
// The vectors live INSIDE the Python package (src/gcache/conformance) rather than at the
// repo root, because they ship as package data so a consumer in another repo can read them
// from an installed gcache instead of mirroring them. This path is the only cost of that.
const vectorsPath = join(here, "..", "..", "..", "src", "gcache", "conformance", "envelope_vectors.json");

interface Vector {
  readonly name: string;
  readonly why: string;
  readonly envelope: string;
  readonly expect: "accept" | "reject";
  readonly decoded?: { createdAtMs: number; expiresAtMs: number; payload?: string; payloadBase64?: string };
  // Present only when the clients DELIBERATELY differ: one cannot represent the value
  // faithfully, so rejecting it there is a miss-and-rewrite rather than two clients serving
  // the same bytes as different numbers.
  readonly rejectedBy?: readonly string[];
  readonly acceptedBy?: readonly string[];
  readonly asymmetryIsSafe?: string;
}

interface KeyCase {
  readonly name: string;
  readonly urnPrefix: string;
  readonly keyType: string;
  readonly id: string;
  readonly python: string;
  readonly typescript: string;
  readonly agree: boolean;
  readonly reason?: string;
}

const data = JSON.parse(readFileSync(vectorsPath, "utf8")) as {
  envelopeVersion: number;
  vectors: readonly Vector[];
  keyRendering: { cases: readonly KeyCase[] };
};

class FakeRedis implements RedisCommandClient {
  readonly values = new Map<string, { value: RedisStoredValue; expiresAtMs: number }>();

  async get(key: string): Promise<RedisStoredValue | null> {
    const entry = this.values.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAtMs <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }

  async setEx(key: string, ttlSec: number, value: RedisStoredValue): Promise<void> {
    this.values.set(key, { value, expiresAtMs: Date.now() + ttlSec * 1000 });
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }

  async flushAll(): Promise<void> {
    this.values.clear();
  }

  raw(key: string): string {
    const value = this.values.get(key)?.value;
    if (typeof value !== "string") throw new Error(`missing string value for ${key}`);
    return value;
  }
}

describe("cross-language envelope conformance", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("loads the shared vector file both suites read", () => {
    // A missing or moved file must fail loudly here rather than making the suite vacuously
    // green by iterating an empty list -- which is exactly how a shared-fixture suite dies
    // quietly.
    expect(data.vectors.length).toBeGreaterThanOrEqual(14);
    expect(data.envelopeVersion).toBe(1);
    for (const v of data.vectors) {
      expect(v.expect === "accept" || v.expect === "reject").toBe(true);
      expect(v.why, `${v.name} must record why it exists`).toBeTruthy();
      if (v.expect === "accept") expect(v.decoded, `${v.name} accept case needs a decode`).toBeDefined();
    }
  });

  for (const vector of data.vectors) {
    it(`vector: ${vector.name}`, async () => {
      // Given Redis holds exactly the vector's bytes, written by some other client.
      const redis = new FakeRedis();
      const useCase = `Conformance_${vector.name.replace(/[^A-Za-z0-9]/g, "_")}`;
      const redisKey = new GCacheKey({ keyType: "user_id", id: "vec", useCase }).urn;
      const now = Date.parse("2025-09-08T04:00:00.000Z");
      vi.setSystemTime(now);
      redis.values.set(redisKey, { expiresAtMs: now + 3_600_000, value: vector.envelope });

      const gcache = new GCache({ redis: { client: redis } });
      let fallbackCalls = 0;
      const read = gcache.cached({
        keyType: "user_id",
        useCase,
        id: ([id]: [string]) => id,
        defaultConfig: new GCacheKeyConfig({
          ttlSec: { [CacheLayer.LOCAL]: 0, [CacheLayer.REMOTE]: 3600 },
          ramp: { [CacheLayer.LOCAL]: 0, [CacheLayer.REMOTE]: 100 },
        }),
        serializer: {
          dump: async (value: unknown) => JSON.stringify(value),
          load: async (value: RedisStoredValue) =>
            JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value) as unknown,
        },
      })(async (_id: string) => {
        fallbackCalls += 1;
        return { from: "fallback" };
      });

      // When it is read.
      const value = await gcache.enable(async () => await read("vec"));

      if (vector.expect === "reject" && vector.rejectedBy !== undefined && !vector.rejectedBy.includes("typescript")) {
        // TS is on the accepting side of a deliberate asymmetry. Asserted rather than
        // skipped: a skip would let TS silently start rejecting too, making the recorded
        // asymmetry a lie.
        expect(vector.acceptedBy, `${vector.name}: rejectedBy needs acceptedBy`).toContain("typescript");
        expect(vector.asymmetryIsSafe, `${vector.name}: an asymmetry must justify its direction`).toBeTruthy();
        expect(fallbackCalls, `${vector.name} must be a hit in TS`).toBe(0);
        return;
      }

      if (vector.expect === "reject") {
        // Then it is a MISS -- the fallback ran -- rather than an exception escaping the read
        // path, and rather than a partial or defaulted value. A cache must not be able to
        // fail a request, and it must not serve something it could not fully validate.
        expect(fallbackCalls, `${vector.name} must be a miss`).toBe(1);
        expect(value).toEqual({ from: "fallback" });
        return;
      }

      // Then it is a hit carrying exactly the vector's payload, and the fallback never ran.
      expect(fallbackCalls, `${vector.name} must be a hit`).toBe(0);
      const decoded = vector.decoded!;
      const expectedPayload =
        decoded.payloadBase64 !== undefined
          ? Buffer.from(decoded.payloadBase64, "base64").toString("utf8")
          : decoded.payload!;
      expect(value).toEqual(JSON.parse(expectedPayload));
    });
  }

  it("still renders the key divergences the file records", () => {
    // Not decode vectors -- a record of what each client renders, so a change to either side
    // shows up as a failure here instead of as silently unshared entries. The TS half is
    // executed here; the Python half is the recorded literal its own suite executes.
    for (const c of data.keyRendering.cases) {
      const rendered = new GCacheKey({
        keyType: c.keyType,
        id: c.id,
        useCase: "Conformance_KeyRendering",
        urnPrefix: c.urnPrefix,
      }).prefix;
      expect(rendered, `${c.name}: TS renders ${rendered}, file says ${c.typescript}`).toBe(c.typescript);
      // And the agreement flag must match reality, so the file cannot quietly claim parity
      // it does not have.
      expect((c.python === c.typescript) === c.agree, `${c.name}: agree flag contradicts the renderings`).toBe(true);
      if (!c.agree) expect(c.reason, `${c.name} must explain a divergence`).toBeTruthy();
    }
  });
});
