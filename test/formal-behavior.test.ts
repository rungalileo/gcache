import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeRedis } from "./fake-redis.js";
import { BehaviorDriver, emptyObservation, type Fixture, type Input, type Observation } from "./formal/behavior-driver.js";

interface Scenario {
  name: string;
  feature: string;
  fixture: Fixture;
  steps: Array<{ input: Input; expect: Partial<Observation> }>;
}
const corpus = JSON.parse(readFileSync(new URL("../formal/behavioral-scenarios.json", import.meta.url), "utf8")) as {
  schemaVersion: number; scenarios: Scenario[];
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T12:00:00Z"));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function replay(scenario: Scenario, driver = new BehaviorDriver(scenario.fixture)): Promise<void> {
  let expected = emptyObservation(scenario.fixture);
  try {
    for (const [index, step] of scenario.steps.entries()) {
      const context = `${scenario.name} step ${index}: ${JSON.stringify(step.input)}`;
      // Expectation patches are assertion-side shorthand only. Every field of
      // the resulting observation is compared after every input.
      expected = { ...expected, ...step.expect };
      try {
        await driver.apply(step.input);
        expect(driver.snapshot(), context).toEqual(expected);
      } catch (cause) {
        throw new Error(`${context}\nexpected: ${JSON.stringify(expected)}\nactual: ${JSON.stringify(driver.snapshot())}`, { cause });
      }
    }
  } finally { await driver.dispose(); }
}

describe("portable behavioral scenarios", () => {
  it("keeps every ordinary test and documentation section in the reviewed source audit", () => {
    execFileSync(process.execPath, [fileURLToPath(new URL("../formal/check-source-audit.mjs", import.meta.url))]);
  });
  it("has a nonempty versioned corpus and unique names", () => {
    expect(corpus.schemaVersion).toBe(2);
    expect(corpus.scenarios.length).toBeGreaterThan(0);
    expect(new Set(corpus.scenarios.map(({ name }) => name)).size).toBe(corpus.scenarios.length);
    expect([...new Set(corpus.scenarios.map(({ feature }) => feature))].sort()).toEqual([
      "enablement", "request-local", "coalescing", "deadlines", "local-cache", "runtime-policy",
      "traversal", "fail-open", "invalidation", "remote-cache", "stale-recovery", "shadow-validation",
    ].sort());
    for (const scenario of corpus.scenarios) {
      expect(scenario.steps.length, scenario.name).toBeGreaterThan(0);
      for (const step of scenario.steps) {
        expect(step.expect, scenario.name).toBeTypeOf("object");
        for (const field of Object.keys(step.expect)) expect(emptyObservation({ policy: {}, observe: [] }), scenario.name).toHaveProperty(field);
      }
    }
  });
  for (const scenario of corpus.scenarios) {
    it(`${scenario.feature}: ${scenario.name}`, async () => { await replay(scenario); });
  }
});

function scenarioNamed(name: string): Scenario {
  const scenario = corpus.scenarios.find((candidate) => candidate.name === name);
  if (scenario === undefined) throw new Error(`Missing regression scenario: ${name}`);
  return scenario;
}

describe("behavior driver trust boundary", () => {
  it("compares diagnostic expectations without feeding them to observers", async () => {
    const scenario = structuredClone(scenarioNamed("adapter legacy null preserves only trustworthy miss metadata"));
    const events = scenario.steps[1]!.expect.events!;
    events[0]!.reason = "expired";
    await expect(replay(scenario)).rejects.toThrow(/step 1/);
  });
  it("detects missing recovery from actual caller results", async () => {
    const scenario = scenarioNamed("first stale age is recoverable without shared publication");
    const driver = new BehaviorDriver(scenario.fixture, { shouldAttemptStaleRecovery: () => false });
    await expect(replay(scenario, driver)).rejects.toThrow(/step 2/);
  });
  it("detects lost local storage on the next call", async () => {
    const scenario = scenarioNamed("local exact TTL boundary expires");
    const driver = new BehaviorDriver(scenario.fixture, { localMaxSize: 0 });
    await expect(replay(scenario, driver)).rejects.toThrow(/step 3/);
  });
  it("detects an acknowledged but lost invalidation after the delayed write", async () => {
    const scenario = scenarioNamed("delayed old write is fenced after invalidation");
    vi.spyOn(FakeRedis.prototype, "invalidate").mockResolvedValue(undefined);
    await expect(replay(scenario)).rejects.toThrow(/step 6/);
  });
});
