import { parseLocalClockTrace, localClockInput, assertLocalClockObservation, type Projected, type LocalClockTrace } from "../../formal/replay/local-clock.mjs";
export { parseLocalClockTrace, type LocalClockTrace } from "../../formal/replay/local-clock.mjs";
import { performance } from "node:perf_hooks";

import { vi } from "vitest";

import { DialCache, DialCacheKeyConfig } from "../../src/index.js";
import { emptyObservation, type Observation } from "./behavior-driver.js";
import { itfInteger, itfSignedInteger, record } from "./itf.js";

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
      for (const input of localClockInput(step.action, step.choice)) {
      if (input.op === "constructInstance") {
        if (caches[input.instance!] !== undefined) throw new Error("Instance already constructed");
        const cache = new DialCache();
        const load = cache.cached(async (offered: number) => { actual.loaders++; return offered; }, {
          keyType: "clock", useCase: "QuintLocalGrid", cacheKey: () => "one",
          defaultConfig: new DialCacheKeyConfig({ ttlSec: { local: 1 } }),
        });
        caches[input.instance!] = { call: offered => cache.enable(() => load(offered)) };
      } else if (input.op === "advanceTicks") ticks += input.ticks!;
      else if (input.op === "call") {
        const cache = caches[input.instance!];
        if (cache === undefined) throw new Error("Call before instance construction");
        actual.calls.push(await cache.call(input.offered!));
      }
      }
      assertLocalClockObservation(step, actual);
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
