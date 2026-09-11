import { parseTrace, fixtureFor, inputsFor, project, expectedObservations, type Trace } from "../formal/replay/effects.mjs";
import { checkWitnesses } from "../formal/replay/witnesses/index.mjs";

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BehaviorDriver } from "./formal/behavior-driver.js";
import { assertEffectsHistory } from "./formal/effects-contract.js";

const singleFile = process.env.DIALCACHE_EFFECTS_TRACE_FILE;
const directory = process.env.DIALCACHE_EFFECTS_TRACE_DIR;
function loadTraces(): Trace[] {
  let paths: string[];
  if (singleFile !== undefined) paths = [resolve(singleFile)];
  else if (directory === undefined) paths = [resolve("formal/effects-smoke.itf.json")];
  else {
    paths = readdirSync(directory).filter((name) => name.endsWith(".itf.json")).sort().map((name) => resolve(directory, name));
    const execution = JSON.parse(readFileSync(new URL("../formal/execution.json", import.meta.url), "utf8")) as {
      models: Array<{ profile?: string; replayRegressions?: string[] }>;
    };
    for (const name of execution.models.find(model => model.profile === "effects")?.replayRegressions ?? []) {
      paths.push(resolve(directory, "..", "regressions", "effects", `${name}.itf.json`));
    }
  }
  if (paths.length === 0) throw new Error("No effects conformance traces found");
  return paths.map((path) => parseTrace(JSON.parse(readFileSync(path, "utf8")), path));
}
const traces = loadTraces();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T12:00:00Z"));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function replay(trace: Trace) {
  // Configuration is an explicit initial input, independent of expected state.
  const driver = new BehaviorDriver(fixtureFor(trace.steps[0]!.choice!));
  try {
    await driver.apply({ op: "faults", value: { holdReads: true, holdLoads: true, holdDumps: true, holdWrites: true } });
    const expectations = expectedObservations(trace);
    for (const [index, step] of trace.steps.entries()) {
      const context = `${trace.path} step ${index} action ${step.action}`;
      const expected = expectations[index];
      try {
        // Only the action/choice and independently observed effect index enter execution.
        const inputs = inputsFor({ action: step.action, ...(step.choice === undefined ? {} : { choice: step.choice }) }, driver.snapshot(), { wallMs: Date.now() });
        for (const input of inputs) await driver.apply(input);
        // Check C23/C25/C26 directly on observed history, independently of
        // expected Quint phases, timestamps, and outcome predictions.
        assertEffectsHistory(driver.contractHistory());
        expect(project(driver.snapshot()), context).toEqual(expected);
      } catch (cause) {
        throw new Error(`${context}\nexpected: ${JSON.stringify(expected)}\nactual: ${JSON.stringify(driver.snapshot())}\nreplay: DIALCACHE_EFFECTS_TRACE_FILE=${JSON.stringify(trace.path)} corepack pnpm exec vitest run test/formal-effects.test.ts`, { cause });
      }
    }
  } finally { await driver.dispose(); }
}

describe("generated pending-effect conformance", () => {
  for (const trace of traces) it(`replays ${trace.path}`, async () => { await replay(trace); });

  // The shared language-neutral evaluator supplies the witness gate; the CLI
  // `node formal/witnesses.mjs evaluate` writes the reusable evidence files.
  if (directory !== undefined && singleFile === undefined) {
    it("covers every action and the required race witnesses", () => {
      expect(checkWitnesses("effects", traces.map(trace => trace.path)).missing, "Missing effects witnesses").toEqual([]);
    });
  }

  it("rejects missing diagnostics and detects a corrupted event without changing execution", async () => {
    const raw = JSON.parse(readFileSync(traces[0]!.path, "utf8"));
    delete raw.states[0].s.events;
    expect(() => parseTrace(raw, "missing-events")).toThrow();
    const trace = structuredClone(traces[0]!);
    trace.steps[1]!.state.events.push({ event: "miss", location: "remote", detail: "value_absent", amount: 0 });
    await expect(replay(trace)).rejects.toThrow(/step 1 action.*\nexpected:.*\nactual:/s);
  });

  it("rejects missing choices and precision loss", () => {
    const raw = JSON.parse(readFileSync(traces[0]!.path, "utf8"));
    raw.states[1].input = { name: "resolveLoader", choice: { "#bigint": "-1" } };
    expect(() => parseTrace(raw, "missing-choice")).toThrow(/missing effect choice/);
    raw.states[1].input.choice = { "#bigint": "9007199254740993" };
    expect(() => parseTrace(raw, "unsafe-choice")).toThrow(/safe ITF integer/);
  });
});
