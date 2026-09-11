import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { shadowLayersWitnesses, shadowLayersWitnessRules } from "./formal/shadow-layers-witnesses.js";

// These excerpts come from actual Quint regressions. They contain only inputs
// and public observations. Mutated excerpts test attribution, never the port.
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/shadow-layers-witnesses.json", import.meta.url), "utf8")) as Array<{
  regression: string;
  trace: { states: Array<{ input: { name: string; choice: unknown }; s: { o: Record<string, unknown> } }> };
}>;
const directory = mkdtempSync(join(tmpdir(), "dialcache-shadow-layers-witness-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const integer = (value: number) => ({ "#bigint": String(value) });
function classify(trace: unknown): Set<string> {
  const path = join(directory, "trace.itf.json");
  writeFileSync(path, JSON.stringify(trace));
  return shadowLayersWitnesses([path]);
}
function traceFor(name: string) {
  const rule = shadowLayersWitnessRules.find(rule => rule.name === name)!;
  return structuredClone(fixtures.find(fixture => fixture.regression === rule.regression)!.trace);
}

describe("shadow/layer witness attribution boundaries", () => {
  for (const rule of shadowLayersWitnessRules) {
    it(`requires every public checkpoint for ${rule.name}`, () => {
      const original = traceFor(rule.name);
      expect(classify(original).has(rule.name)).toBe(true);
      for (const checkpoint of rule.checkpoints) {
        const corrupted = structuredClone(original);
        corrupted.states[checkpoint.step]!.s.o = {};
        expect(classify(corrupted).has(rule.name)).toBe(false);
      }
    });
  }
  it("rejects capacity credit if the served source slot releases at the job deadline", () => {
    const name = "mixed-shadow-capacity-retains-only-owned-source";
    const trace = traceFor(name);
    trace.states[9]!.s.o.reads = integer(4);
    trace.states[9]!.s.o.shadow = ["dropped", "timeout", "timeout"];
    expect(classify(trace).has(name)).toBe(false);
  });
  it("rejects C0 publication even if a later source replaces it with the right local value", () => {
    const name = "dark-present-c0-never-publishes-local";
    const trace = traceFor(name);
    trace.states[4]!.s.o.calls = [0, 1].map(integer);
    expect(classify(trace).has(name)).toBe(false);
  });
  it("requires accepted retention at dispatch as well as a later expiry probe", () => {
    const name = "dark-fill-policy-snapshot-controls-physical-expiry";
    const trace = traceFor(name);
    trace.states[7]!.s.o.writeTtls = [integer(180_000)];
    expect(classify(trace).has(name)).toBe(false);
  });
  it("rejects a retained-candidate claim without crossing the exact freshness boundary", () => {
    const name = "retained-fresh-c0-compares-after-freshness-boundary";
    const trace = traceFor(name);
    trace.states[4]!.input.choice = integer(0);
    expect(classify(trace).has(name)).toBe(false);
  });
  it("rejects inclusive shadow cohort admission at the exact sample", () => {
    const name = "shadow-cohort-equality-does-not-admit";
    const trace = traceFor(name);
    trace.states[3]!.s.o.reads = integer(1);
    trace.states[3]!.s.o.dumps = integer(1);
    expect(classify(trace).has(name)).toBe(false);
  });
  it("requires the deduplicated caller to receive its own independently settled value", () => {
    const name = "dark-job-dedup-preserves-independent-source-values";
    const trace = traceFor(name);
    trace.states[4]!.s.o.calls = [0, 1].map(integer);
    expect(classify(trace).has(name)).toBe(false);
  });
  it("rejects an unbounded caller timed out with its dark job", () => {
    const name = "unbounded-caller-outlives-released-dark-job";
    const trace = traceFor(name);
    trace.states[3]!.s.o.calls = [integer(4)];
    expect(classify(trace).has(name)).toBe(false);
  });
  it("distinguishes a propagated timeout source error from the job deadline verdict", () => {
    const name = "dark-propagated-timeout-is-source-error";
    const trace = traceFor(name);
    trace.states[3]!.s.o.shadow = ["timeout"];
    expect(classify(trace).has(name)).toBe(false);
  });
});
