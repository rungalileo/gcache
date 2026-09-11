import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bindTrace } from "../formal/replay/bindings.mjs";
import { BehaviorDriver, type Fixture, type Input } from "./formal/behavior-driver.js";

// Harness control for the causally-ready-v1 settlement contract (PORTING.md).
// The replays below use the shared bindings and the committed smoke history of
// every BehaviorDriver-backed profile. A driver that skips its end-of-apply
// drain must be caught by the observation assertions; if it were not, the
// contract would be unenforced and a port could pass without ever settling.
// The core and local-clock profiles use other drivers and are not covered here.
const profiles = ["independent", "layers", "admission", "scope", "recovery", "policy", "shadow", "effects"] as const;

// Measured 2026-09-11 at commit 74efe65: without the drain, all eight smoke
// histories fail an observation comparison within their first five steps
// (six at a `beginCall`, whose getOrLoad has not reached its source or Redis
// read when the snapshot is taken; `scope` at `rejectLoader`; `policy` at
// `releasePolicy`), so the floor is the full set. Lower it only with a written
// reason (for example a regenerated smoke history that observes nothing
// asynchronous); it must stay at least one so the control keeps its teeth.
const minimumDetectingProfiles = 8;

async function replay(name: string, settle: boolean): Promise<void> {
  const path = resolve(`formal/${name}-smoke.itf.json`);
  const bound = bindTrace(name, JSON.parse(readFileSync(path, "utf8")), path);
  // The language-neutral bindings type fixtures loosely; the driver owns the shape.
  const driver = new BehaviorDriver(bound.fixture as unknown as Fixture, {}, { settle });
  try {
    for (const input of bound.setup as Input[]) await driver.apply(input);
    for (let index = 0; index < bound.trace.steps.length; index++) {
      for (const input of bound.commands(index, driver.snapshot(), { wallMs: Date.now() }) as Input[]) await driver.apply(input);
      bound.assert(index, driver.snapshot());
    }
  } finally { await driver.dispose(); }
}

// Each replay owns fresh fake timers and spies, exactly like the acceptance suites.
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-08T12:00:00Z")); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("harness control: causally-ready-v1 settlement", () => {
  const detected: string[] = [];
  const undetected: string[] = [];
  for (const name of profiles) {
    it(`harness control: ${name} smoke history passes with the settling driver`, async () => {
      await replay(name, true);
    });
    it(`harness control: ${name} smoke history is recorded against a driver that skips settlement`, async () => {
      try { await replay(name, false); undetected.push(name); }
      catch (error) {
        // Only an observation mismatch counts as detection. A driver or
        // binding crash would be a harness defect, not settlement evidence.
        if ((error as { code?: string }).code !== "ERR_ASSERTION") throw error;
        detected.push(name);
      }
    });
  }
  it(`harness control: skipping settlement is detected by at least ${minimumDetectingProfiles} profiles`, () => {
    expect(profiles.length).toBeGreaterThanOrEqual(minimumDetectingProfiles);
    expect(detected.length, `detected by ${JSON.stringify(detected)}; undetected by ${JSON.stringify(undetected)}`)
      .toBeGreaterThanOrEqual(minimumDetectingProfiles);
  });
});
