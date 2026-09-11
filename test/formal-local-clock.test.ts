import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { recordWitnesses } from "./formal/coverage-evidence.js";
import { localClockWitnesses, parseLocalClockTrace, replayLocalClockTrace } from "./formal/local-clock-profile.js";

const profile = "local-clock";
const single = process.env.DIALCACHE_FEATURE_TRACE_FILE;
const directory = process.env.DIALCACHE_FEATURE_TRACE_DIR;
const paths = single !== undefined ? (single.includes(`/${profile}/`) || single.endsWith(`${profile}-smoke.itf.json`) ? [resolve(single)] : [])
  : directory === undefined ? [resolve(`formal/${profile}-smoke.itf.json`)]
  : readdirSync(resolve(directory, profile)).filter(file => file.endsWith(".itf.json")).sort().map(file => resolve(directory, profile, file));
if (directory !== undefined && single === undefined) {
  const execution = JSON.parse(readFileSync("formal/execution.json", "utf8")) as { models: Array<{ profile?: string; replayRegressions?: string[] }> };
  for (const name of execution.models.find(model => model.profile === profile)?.replayRegressions ?? []) {
    paths.push(resolve(directory, "..", "regressions", profile, `${name}.itf.json`));
  }
}
if (single === undefined && paths.length === 0) throw new Error("No local-clock traces found");
const traces = paths.map(path => parseLocalClockTrace(JSON.parse(readFileSync(path, "utf8")), path));
describe("generated local-clock conformance", () => {
  for (const trace of traces) it(`replays ${trace.path}`, async () => { await replayLocalClockTrace(trace); });
  if (directory !== undefined && single === undefined) it("reaches fractional expiry and shared instance grid", () => {
    const required = ["fractional-insertion-expiry", "shared-instance-grid"];
    const seen = localClockWitnesses(traces);
    expect(required.filter(witness => !seen.has(witness))).toEqual([]);
    recordWitnesses(profile, seen, required, traces);
  });
  if (traces.length > 0) {
    it("rejects missing observations and unsupported inputs", () => {
      const raw = JSON.parse(readFileSync(traces[0]!.path, "utf8"));
      delete raw.states[0].s.o.loaders;
      expect(() => parseLocalClockTrace(raw, "missing-observation")).toThrow(/observation fields/);
      raw.states[0].s.o.loaders = { "#bigint": "0" };
      raw.states[1].input.name = "unknown";
      expect(() => parseLocalClockTrace(raw, "unknown-input")).toThrow(/Unknown/);
      raw.states[1].input = { name: "advanceTicks", choice: { "#bigint": "9007199254740993" } };
      expect(() => parseLocalClockTrace(raw, "unsafe-input")).toThrow(/safe ITF integer/);
    });
    it("compares observations without changing the declared schedule", async () => {
      const trace = structuredClone(traces[0]!);
      trace.steps[1]!.expected.loaders++;
      await expect(replayLocalClockTrace(trace)).rejects.toThrow(/expected 1, actual 0/);
    });
    it("ignores private model state as an execution input", async () => {
      const raw = JSON.parse(readFileSync(traces[0]!.path, "utf8"));
      for (const state of raw.states) state.s = { o: state.s.o, ticks: "not an input", entries: null };
      await replayLocalClockTrace(parseLocalClockTrace(raw, "private-state-removed"));
    });
  }
});

// Keep classifier controls tied to the actual shared-grid regression even when
// the selected replay is a different randomly generated clock history.
describe("local-clock witness attribution", () => {
  const smoke = (): ReturnType<typeof parseLocalClockTrace> => parseLocalClockTrace(
    JSON.parse(readFileSync("formal/local-clock-smoke.itf.json", "utf8")), "clock witness fixture");
  it("observes both the fractional insertion boundary and the distinct construction phases", () => {
    expect([...localClockWitnesses([smoke()])]).toContain("fractional-insertion-expiry");
    expect([...localClockWitnesses([smoke()])]).toContain("shared-instance-grid");
  });
  it("cannot credit an expiry before the final boundary calls", () => {
    const trace = smoke();
    trace.steps.splice(-2);
    expect(localClockWitnesses([trace]).has("fractional-insertion-expiry")).toBe(false);
    expect(localClockWitnesses([trace]).has("shared-instance-grid")).toBe(false);
  });
  it("same-phase construction does not establish a shared cross-phase clock grid", () => {
    const trace = smoke();
    const fractionalConstruction = trace.steps.findIndex(step => step.action === "advanceTicks" && step.choice === 400);
    trace.steps.splice(fractionalConstruction, 1);
    trace.steps.find(step => step.action === "advanceTicks" && step.choice === 300)!.choice = 700;
    const seen = localClockWitnesses([trace]);
    expect(seen.has("fractional-insertion-expiry")).toBe(true);
    expect(seen.has("shared-instance-grid")).toBe(false);
  });
});
