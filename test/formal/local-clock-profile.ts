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
