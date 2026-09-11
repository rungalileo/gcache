import { profiles, parseTrace, featureInput, assertFeatureObservation, type Trace } from "../formal/replay/features.mjs";
import { checkWitnesses } from "../formal/replay/witnesses/index.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BehaviorDriver } from "./formal/behavior-driver.js";
import type { Profile } from "./formal/feature-profile.js";

async function replay(profile: Profile, trace: Trace) {
  const driver = new BehaviorDriver(typeof profile.fixture === "function" ? profile.fixture(trace.steps[0]!.choice) : profile.fixture);
  try {
    for (const input of profile.setup) await driver.apply(input);
    for (const [i, step] of trace.steps.entries()) {
      const { action, choice } = step;
      try {
        // Only named actions/choices and actual effect IDs enter the driver.
        // The model observation and its private state cannot control execution.
        if (action !== "init") await driver.apply(featureInput(profile, action, choice, driver.snapshot(), { wallMs: Date.now() }));
        assertFeatureObservation(profile, step, driver.snapshot());
      } catch (cause) {
        throw new Error(`${trace.path} step ${i} action ${action} choice ${choice}\nexpected: ${JSON.stringify({ o: step.expected, d: step.diagnostics, io: step.io })}\nactual: ${JSON.stringify(driver.snapshot())}\nreplay: DIALCACHE_FEATURE_TRACE_FILE=${JSON.stringify(trace.path)} corepack pnpm exec vitest run test/formal-features.test.ts --coverage.enabled=false`, { cause });
      }
    }
  } finally { await driver.dispose(); }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-08T12:00:00Z")); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const single = process.env.DIALCACHE_FEATURE_TRACE_FILE;
const directory = process.env.DIALCACHE_FEATURE_TRACE_DIR;
const selectedProfile = process.env.DIALCACHE_FEATURE_PROFILE;
if (selectedProfile !== undefined && !Object.hasOwn(profiles, selectedProfile)) throw new Error(`Unknown selected feature profile: ${selectedProfile}`);
const execution = JSON.parse(readFileSync(new URL("../formal/execution.json", import.meta.url), "utf8")) as {
  models: Array<{ profile?: string; replayRegressions?: string[] }>;
};
for (const [name, profile] of Object.entries(profiles)) {
  if (selectedProfile !== undefined && selectedProfile !== name) continue;
  const paths = single !== undefined ? (single.includes(`/${name}/`) || single.endsWith(`${name}-smoke.itf.json`) ? [resolve(single)] : [])
    : directory === undefined ? [resolve(`formal/${name}-smoke.itf.json`)]
    : readdirSync(resolve(directory, name)).filter((file) => file.endsWith(".itf.json")).sort().map((file) => resolve(directory, name, file));
  if (directory !== undefined && single === undefined) {
    const regressions = execution.models.find(model => model.profile === name)?.replayRegressions ?? [];
    for (const regression of regressions) paths.push(resolve(directory, "..", "regressions", name, `${regression}.itf.json`));
  }
  if (single === undefined && paths.length === 0) throw new Error(`No ${name} traces found`);
  if (paths.length === 0) continue;
  const traces = paths.map((path) => parseTrace(JSON.parse(readFileSync(path, "utf8")), path, profile));
  describe(`generated ${name} conformance`, () => {
    for (const trace of traces) it(`replays ${trace.path}`, async () => { await replay(profile, trace); });
    // The completion gate runs the shared language-neutral evaluator over the
    // same histories. `node formal/witnesses.mjs evaluate` is the sole producer
    // of the reusable evidence files; this test only checks reachability.
    if (directory !== undefined && single === undefined) it("reaches every action and required outcome or race", () => {
      expect(checkWitnesses(name, traces.map(trace => trace.path)).missing, `Missing ${name} coverage witnesses`).toEqual([]);
    }, 30_000);
    if (traces.length > 0) {
      it("rejects missing observations, unknown actions and invalid choices", () => {
        const raw = JSON.parse(readFileSync(traces[0]!.path, "utf8"));
        delete raw.states[0].s.o.reads;
        expect(() => parseTrace(raw, "missing-observation", profile)).toThrow(/observation fields/);
        raw.states[0].s.o.reads = { "#bigint": "0" };
        if (profile.explicitInputs) raw.states[1].input.name = "unknown";
        else raw.states[1]["mbt::actionTaken"] = "unknown";
        expect(() => parseTrace(raw, "unknown-action", profile)).toThrow(/unknown/);
        const chosenAction = Object.keys(profile.actions).find((action) => profile.actions[action]!.choices !== undefined)!;
        if (profile.explicitInputs) raw.states[1].input = { name: chosenAction, choice: { "#bigint": "9007199254740993" } };
        else {
          raw.states[1]["mbt::actionTaken"] = chosenAction;
          raw.states[1]["mbt::nondetPicks"].choice = { tag: "Some", value: { "#bigint": "9007199254740993" } };
        }
        expect(() => parseTrace(raw, "unsafe-choice", profile)).toThrow(/safe ITF integer/);
      });
      if (profile.readIO) it("rejects missing read observations and detects corrupted budgets", async () => {
        const raw = JSON.parse(readFileSync(traces[0]!.path, "utf8"));
        delete raw.states[0].s.io;
        expect(() => parseTrace(raw, "missing-read-observations", profile)).toThrow();
        const trace = structuredClone(traces[0]!);
        trace.steps[1]!.io!.budgets.push(999);
        await expect(replay(profile, trace)).rejects.toThrow(/step 1 action.*\nexpected:.*\nactual:/s);
      });
      if (profile.diagnosticAge !== undefined) it("rejects missing diagnostics and detects corrupted diagnostic expectations", async () => {
        const raw = JSON.parse(readFileSync(traces[0]!.path, "utf8"));
        delete raw.states[0].s.d;
        expect(() => parseTrace(raw, "missing-diagnostics", profile)).toThrow();
        const trace = structuredClone(traces[0]!);
        trace.steps[1]!.diagnostics!.ages.push(123);
        await expect(replay(profile, trace)).rejects.toThrow(/step 1 action.*\nexpected:.*\nactual:/s);
      });
      it("detects a corrupted model observation without changing execution", async () => {
        const trace = structuredClone(traces[0]!);
        trace.steps[1]!.expected.writes += 1;
        await expect(replay(profile, trace)).rejects.toThrow(/step 1 action.*\nexpected:.*\nactual:/s);
      });
    }
  });
}
if (single !== undefined && !Object.keys(profiles).some((name) => single.includes(`/${name}/`) || single.endsWith(`${name}-smoke.itf.json`))) {
  throw new Error("Single feature trace must be inside its independent/layers/admission/scope/recovery/policy/shadow profile directory");
}
