import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { shadowDiagnosticsWitnessRules, shadowDiagnosticsWitnesses } from "../formal/replay/witnesses/shadow-diagnostics.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/shadow-diagnostics-witnesses.json", import.meta.url), "utf8")) as Array<{
  regression: string;
  trace: { states: Array<{ input: { name: string; choice: unknown }; s: { o: Record<string, unknown>; d: Record<string, unknown> } }> };
}>;
const directory = mkdtempSync(join(tmpdir(), "dialcache-shadow-diagnostics-witness-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const integer = (value: number) => ({ "#bigint": String(value) });
function traceFor(name: string) {
  const rule = shadowDiagnosticsWitnessRules.find(rule => rule.name === name)!;
  return structuredClone(fixtures.find(fixture => fixture.regression === rule.regression)!.trace);
}
function classified(name: string, trace: unknown): boolean {
  const path = join(directory, "trace.itf.json");
  writeFileSync(path, JSON.stringify(trace));
  return shadowDiagnosticsWitnesses([path]).has(name);
}

// Input/public-diagnostic excerpts are produced by Quint. These negative
// controls validate attribution and never count as implementation detections.
describe("shadow diagnostic witness attribution boundaries", () => {
  for (const rule of shadowDiagnosticsWitnessRules) {
    it(`requires verdicts and diagnostics for ${rule.name}`, () => {
      const original = traceFor(rule.name);
      expect(classified(rule.name, original)).toBe(true);
      for (const checkpoint of rule.checkpoints) for (const field of ["o", "d"] as const) {
        const changed = structuredClone(original);
        changed.states[checkpoint.step]!.s[field] = {};
        expect(classified(rule.name, changed)).toBe(false);
      }
    });
  }
  it("does not credit omitted logging from an explicit false runtime reply", () => {
    const name = "omitted-shadow-logging-keeps-mismatch-metrics-only";
    const trace = traceFor(name);
    trace.states.splice(1, 0, { input: { name: "logPolicy", choice: integer(0) }, s: structuredClone(trace.states[0]!.s) });
    expect(classified(name, trace)).toBe(false);
  });
  it("requires crossing the full freshness boundary before payload confirmation", () => {
    const name = "shadow-confirmation-past-freshness-preserves-payload-and-age";
    const trace = traceFor(name);
    trace.states[6]!.input.choice = integer(59_999);
    expect(classified(name, trace)).toBe(false);
  });
  it("requires the rollback age to clamp to zero", () => {
    const name = "shadow-confirmation-rollback-keeps-payload-and-reports-offset";
    const trace = traceFor(name);
    trace.states[7]!.s.d.ages = [integer(1000)];
    expect(classified(name, trace)).toBe(false);
  });
  it("rejects a serving-layer metric for detached C1 work", () => {
    const name = "shadow-confirmation-rollback-keeps-payload-and-reports-offset";
    const trace = traceFor(name);
    trace.states[7]!.s.d.futureOffsets = [{ layer: "remote", offsetMs: integer(1000) }];
    expect(classified(name, trace)).toBe(false);
  });
  it("requires the exact dark future offset rather than merely a positive sample", () => {
    const name = "future-dark-c0-reports-offset-and-fills-semantic-miss";
    const trace = traceFor(name);
    trace.states[4]!.s.d.futureOffsets = [{ layer: "remote_shadow", offsetMs: integer(1) }];
    expect(classified(name, trace)).toBe(false);
  });
  it("rejects future-C0 deserialization despite a correct future metric", () => {
    const name = "future-dark-c0-reports-offset-and-fills-semantic-miss";
    const trace = traceFor(name);
    trace.states[7]!.s.o.loads = integer(1);
    expect(classified(name, trace)).toBe(false);
  });
});
