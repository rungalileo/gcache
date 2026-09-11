import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { localFailureWitnessRules, localFailureWitnesses } from "../formal/replay/witnesses/local-failure.mjs";
import { sourceBudgetsWitnessRules, sourceBudgetsWitnesses } from "../formal/replay/witnesses/source-budgets.mjs";

interface Trace { states: Array<{ input: { name: string; choice: unknown }; s: { o: Record<string, unknown> } }> }
const suites = [
  { family: "local-failure", rules: localFailureWitnessRules, classify: localFailureWitnesses },
  { family: "source-budgets", rules: sourceBudgetsWitnessRules, classify: sourceBudgetsWitnesses },
].map(suite => ({ ...suite, fixtures: JSON.parse(readFileSync(new URL(`./fixtures/${suite.family}-witnesses.json`, import.meta.url), "utf8")) as Array<{
  regression: string; trace: Trace;
}> }));
const directory = mkdtempSync(join(tmpdir(), "dialcache-public-prefix-witness-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const integer = (value: number) => ({ "#bigint": String(value) });
function traceFor(name: string) {
  const suite = suites.find(suite => suite.rules.some(rule => rule.name === name))!;
  const rule = suite.rules.find(rule => rule.name === name)!;
  return structuredClone(suite.fixtures.find(fixture => fixture.regression === rule.regression)!.trace);
}
function classified(name: string, trace: Trace): boolean {
  const path = join(directory, "trace.itf.json");
  writeFileSync(path, JSON.stringify(trace));
  return suites.find(suite => suite.rules.some(rule => rule.name === name))!.classify([path]).has(name);
}

// Actual Quint input/public-observation excerpts challenge the classifier.
// These are harness controls and never count as positive behavioral evidence.
describe("local failure and source budget attribution boundaries", () => {
  for (const suite of suites) for (const rule of suite.rules) {
    it(`requires every public checkpoint for ${rule.name}`, () => {
      const original = traceFor(rule.name);
      expect(classified(rule.name, original)).toBe(true);
      for (const checkpoint of rule.checkpoints) {
        const changed = structuredClone(original);
        changed.states[checkpoint.step]!.s.o = {};
        expect(classified(rule.name, changed)).toBe(false);
      }
    });
  }
  it("requires old local bytes to survive the failed-read invocation", () => {
    const name = "failed-local-read-suppresses-later-source-publication";
    const trace = traceFor(name);
    trace.states.at(-1)!.s.o.calls = [1, 2, 2, 2].map(integer);
    expect(classified(name, trace)).toBe(false);
  });
  it("requires clearing the local fault before source settlement", () => {
    const name = "failed-local-read-suppresses-later-source-publication";
    const trace = traceFor(name);
    trace.states[6]!.input.choice = integer(1);
    expect(classified(name, trace)).toBe(false);
  });
  it("does not confuse request memo reuse with local publication after a failed write", () => {
    const name = "failed-local-write-keeps-result-and-request-memo";
    const trace = traceFor(name);
    trace.states[7]!.s.o.calls = [1, 1, 1].map(integer);
    trace.states[7]!.s.o.loaders = integer(1);
    expect(classified(name, trace)).toBe(false);
  });
  it("rejects a default source deadline firing one millisecond early", () => {
    const name = "default-source-budget-expires-at-sixty-seconds";
    const trace = traceFor(name);
    trace.states[3]!.s.o.calls = [integer(4)];
    expect(classified(name, trace)).toBe(false);
  });
  it("rejects a follower receiving a new budget after joining the same source", () => {
    const name = "late-follower-keeps-leaders-remaining-source-budget";
    const trace = traceFor(name);
    trace.states[7]!.s.o.calls = [4, 0].map(integer);
    expect(classified(name, trace)).toBe(false);
  });
  it("requires a held policy to delay actual source start", () => {
    const name = "policy-wait-does-not-spend-source-budget";
    const trace = traceFor(name);
    trace.states[2]!.s.o.loaders = integer(1);
    expect(classified(name, trace)).toBe(false);
  });
  it("rejects late abandoned publication even when the retry caller kept its value", () => {
    const name = "abandoned-source-cannot-replace-successful-retry";
    const trace = traceFor(name);
    trace.states[9]!.s.o.calls = [4, 2, 1].map(integer);
    expect(classified(name, trace)).toBe(false);
  });
  it("requires a later enabled call to prove outside calls did not publish", () => {
    const name = "outside-calls-skip-source-deadlines-sharing-and-publication";
    const trace = traceFor(name);
    trace.states[7]!.s.o.calls = [1, 2, 2].map(integer);
    trace.states[7]!.s.o.loaders = integer(2);
    expect(classified(name, trace)).toBe(false);
  });
});
