import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { recoveryReadWitnesses, recoveryReadWitnessRules } from "./formal/recovery-read-witnesses.js";

// Actual Quint input/observation excerpts; private state is deliberately absent.
// These tests challenge classification, not a language implementation, and must
// never receive positive behavioral or mutation-detection credit.
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/recovery-read-witnesses.json", import.meta.url), "utf8")) as Array<{
  regression: string;
  trace: { states: Array<{ input: unknown; s: { o: Record<string, unknown>; io: Record<string, unknown>; markers: unknown[]; compression: string[] } }> };
}>;
const directory = mkdtempSync(join(tmpdir(), "dialcache-recovery-read-witness-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
function classify(trace: unknown): Set<string> {
  const path = join(directory, "trace.itf.json");
  writeFileSync(path, JSON.stringify(trace));
  return recoveryReadWitnesses([path]);
}
function traceFor(name: string) {
  const rule = recoveryReadWitnessRules.find(rule => rule.name === name)!;
  return structuredClone(fixtures.find(fixture => fixture.regression === rule.regression)!.trace);
}

describe("recovery/read witness attribution boundaries", () => {
  for (const rule of recoveryReadWitnessRules) {
    it(`requires the public consequence for ${rule.name}`, () => {
      const trace = traceFor(rule.name);
      expect(classify(trace).has(rule.name)).toBe(true);
      const final = trace.states.at(-1)!.s;
      final.o = {};
      final.io = {};
      final.markers = [];
      final.compression = [];
      expect(classify(trace).has(rule.name)).toBe(false);
    });
  }
  it("does not credit unchanged cutoff when ordinary value work extends marker expiry", () => {
    const name = "ordinary-value-work-preserves-marker-cutoff-and-expiry";
    const trace = traceFor(name);
    trace.states.at(-1)!.s.markers = [
      { cutoffMs: { "#bigint": "0" }, ttlMs: { "#bigint": "7200000" } },
      { cutoffMs: { "#bigint": "0" }, ttlMs: { "#bigint": "7199999" } },
      { cutoffMs: { "#bigint": "0" }, ttlMs: { "#bigint": "7200000" } },
    ];
    expect(classify(trace).has(name)).toBe(false);
  });
  it("requires the original indexed source error after corrupt recovery", () => {
    const name = "corrupt-compressed-recovery-keeps-original-error";
    const trace = traceFor(name);
    trace.states.at(-1)!.s.io.sourceErrors = [{ "#bigint": "2" }];
    expect(classify(trace).has(name)).toBe(false);
  });
  it("does not credit request-only recovery if the other request reuses a local value", () => {
    const name = "tracked-compressed-recovery-is-request-only";
    const trace = traceFor(name);
    trace.states.at(-1)!.s.o.calls = [1, 1, 1].map(value => ({ "#bigint": String(value) }));
    trace.states.at(-1)!.s.o.reads = { "#bigint": "1" };
    expect(classify(trace).has(name)).toBe(false);
  });
  it("requires decompression telemetry as well as a successful cached result", () => {
    const name = "fresh-compressed-hit-reports-decompression";
    const trace = traceFor(name);
    trace.states.at(-1)!.s.compression = [];
    expect(classify(trace).has(name)).toBe(false);
  });
  it("does not credit captured-fence behavior when the intervening invalidation suppresses the write", () => {
    const name = "later-invalidation-keeps-captured-miss-fence-new-read-fences-write";
    const trace = traceFor(name);
    trace.states.at(-1)!.s.o.writes = { "#bigint": "0" };
    trace.states.at(-1)!.s.o.dumps = { "#bigint": "0" };
    expect(classify(trace).has(name)).toBe(false);
  });
  it("does not credit a pre-decode maximum check when decoding has already run", () => {
    const name = "maximum-before-decode-preserves-original-error-without-load";
    const trace = traceFor(name);
    trace.states.at(-1)!.s.o.loads = { "#bigint": "1" };
    trace.states.at(-1)!.s.compression = ["decompressed"];
    expect(classify(trace).has(name)).toBe(false);
  });

});
