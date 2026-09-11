import { performance } from "node:perf_hooks";

import { vi } from "vitest";

import { DialCache, DialCacheKeyConfig } from "../../src/index.js";
import { emptyObservation, type Observation } from "./behavior-driver.js";
import { itfInteger, itfSignedInteger, record } from "./itf.js";

type Projected = Omit<Observation, "calls"> & { calls: number[] };
export interface LocalClockStep { action: string; choice: number; expected: Projected }
export interface LocalClockTrace { path: string; steps: LocalClockStep[] }
const advances = [1, 100, 300, 400, 700, 999200, 999999, 1000000];
const choices: Record<string, readonly number[]> = {
  init: [-1], constructInstance: [0, 1], advanceTicks: advances, call: [0, 1, 2, 3],
};

export function parseLocalClockTrace(raw: unknown, path: string): LocalClockTrace {
  const states = record(raw, path).states;
  if (!Array.isArray(states) || states.length < 2) throw new Error("Clock trace requires initialization and a transition");
  const shape = emptyObservation();
  const steps = states.map((value, index): LocalClockStep => {
    const state = record(value, `${path} state${index}`);
    const input = record(state.input, "clock input");
    if (Object.keys(input).sort().join() !== "choice,name" || typeof input.name !== "string"
      || !Object.hasOwn(choices, input.name) || (index === 0) !== (input.name === "init")) {
      throw new Error("Unknown or misplaced clock action");
    }
    const choice = itfSignedInteger(input.choice, "clock choice");
    if (!choices[input.name]!.includes(choice)) throw new Error("Invalid clock choice");
    const rawObservation = record(record(state.s, "clock state").o, "clock observation");
    if (Object.keys(rawObservation).sort().join() !== Object.keys(shape).sort().join()) throw new Error("Missing clock observation fields");
    const expected: Record<string, unknown> = {};
    for (const [key, baseline] of Object.entries(shape)) {
      const observed = rawObservation[key];
      if (key === "calls") {
        if (!Array.isArray(observed)) throw new Error("Invalid clock calls");
        expected[key] = observed.map(value => itfInteger(value, "clock returned value"));
      } else if (typeof baseline === "number") expected[key] = itfInteger(observed, `clock ${key}`);
      else {
        if (!Array.isArray(observed) || observed.length !== 0) throw new Error(`Unsupported clock ${key}`);
        expected[key] = [];
      }
    }
    return { action: input.name, choice, expected: expected as Projected };
  });
  return { path, steps };
}

// This binding deliberately creates default DialCache instances. A shared
// integer fake Clock injected into each cache would hide a construction-grid
// mistake. Only declared microsecond advances move the process clock.
export async function replayLocalClockTrace(trace: LocalClockTrace): Promise<void> {
  let ticks = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => ticks / 1000);
  const actual: Projected = { ...emptyObservation(), calls: [] };
  const caches: Array<{ call: (offered: number) => Promise<number> } | undefined> = [undefined, undefined];
  try {
    for (const [index, step] of trace.steps.entries()) {
      if (step.action === "constructInstance") {
        if (caches[step.choice] !== undefined) throw new Error("Instance already constructed");
        const cache = new DialCache();
        const load = cache.cached(async (offered: number) => { actual.loaders++; return offered; }, {
          keyType: "clock", useCase: "QuintLocalGrid", cacheKey: () => "one",
          defaultConfig: new DialCacheKeyConfig({ ttlSec: { local: 1 } }),
        });
        caches[step.choice] = { call: offered => cache.enable(() => load(offered)) };
      } else if (step.action === "advanceTicks") ticks += step.choice;
      else if (step.action === "call") {
        const cache = caches[Math.floor(step.choice / 2)];
        if (cache === undefined) throw new Error("Call before instance construction");
        actual.calls.push(await cache.call(step.choice % 2 + 1));
      }
      if (JSON.stringify(actual) !== JSON.stringify(step.expected)) {
        // Object key order is not part of the observation protocol.
        for (const key of Object.keys(actual) as Array<keyof Projected>) {
          if (JSON.stringify(actual[key]) !== JSON.stringify(step.expected[key])) {
            throw new Error(`${trace.path} step ${index} ${step.action} choice ${step.choice} ${key}: expected ${JSON.stringify(step.expected[key])}, actual ${JSON.stringify(actual[key])}`);
          }
        }
      }
    }
  } finally { now.mockRestore(); }
}

// Consequential coverage uses only the declared schedule and returned values /
// source counts. Private model timestamps never steer or credit the replay.
export function localClockWitnesses(traces: readonly LocalClockTrace[]): Set<string> {
  const seen = new Set<string>();
  for (const trace of traces) {
    let ticks = 0;
    const constructions: Array<number | undefined> = [undefined, undefined];
    const fills: Array<{ ticks: number; value: number; hitBefore: boolean } | undefined> = [];
    const expirations: Array<{ instance: number; ticks: number; inserted: number }> = [];
    for (const [index, step] of trace.steps.entries()) {
      seen.add(`action:${step.action}`);
      if (step.action === "constructInstance") constructions[step.choice] = ticks;
      if (step.action === "advanceTicks") ticks += step.choice;
      if (step.action !== "call") continue;
      const instance = Math.floor(step.choice / 2);
      const offered = step.choice % 2 + 1;
      const before = trace.steps[index - 1]!.expected;
      const value = step.expected.calls.at(-1)!;
      const previous = fills[instance];
      const sourceDelta = step.expected.loaders - before.loaders;
      if (previous !== undefined && sourceDelta === 0 && value === previous.value
        && offered !== value && Math.floor(ticks / 1000) - Math.floor(previous.ticks / 1000) === 999) previous.hitBefore = true;
      if (sourceDelta === 1 && value === offered) {
        if (previous !== undefined && previous.hitBefore && offered !== previous.value
          && ticks % 1000 === 0 && Math.floor(ticks / 1000) - Math.floor(previous.ticks / 1000) === 1000) {
          if (previous.ticks % 1000 !== 0) seen.add("fractional-insertion-expiry");
          expirations.push({ instance, ticks, inserted: previous.ticks });
        }
        fills[instance] = { ticks, value, hitBefore: false };
      }
    }
    if (expirations.some(left => expirations.some(right => left.instance !== right.instance
      && left.ticks === right.ticks && Math.floor(left.inserted / 1000) === Math.floor(right.inserted / 1000)
      && constructions[left.instance] !== undefined && constructions[right.instance] !== undefined
      && constructions[left.instance]! % 1000 !== constructions[right.instance]! % 1000))) seen.add("shared-instance-grid");
  }
  return seen;
}
