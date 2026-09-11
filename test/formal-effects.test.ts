import { actions, parseTrace, fixtureFor, inputsFor, project, expectedObservations, type Trace } from "../formal/replay/effects.mjs";
type Action = string;
import { effectsAuthorityWitnesses } from "./formal/effects-authority-witnesses.js";
import { recordWitnesses } from "./formal/coverage-evidence.js";

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

  if (directory !== undefined && singleFile === undefined) {
    it("covers every action and the required race witnesses", () => {
      const seen = new Set<Action>();
      const witnesses = new Set<string>();
      const diagnosticWitnesses = new Set<string>();
      for (const trace of traces) {
        witnesses.add(`fixture:${trace.steps[0]!.choice}`);
        let budgetChanged = false;
        let delayedWriteWasFenced = false;
        const normalizedFenceSources = new Set<number>();
        const normalizedReplies = new Map<number, number>();
        let failedRead = false;
        let failedDecode = false;
        let acquiredAt: number | undefined;
        let decodeStarted = 0;
        for (const [index, step] of trace.steps.entries()) {
          seen.add(step.action);
          const s = step.state;
          const previous = trace.steps[index - 1]?.state;
          if (step.action === "readBudgetPolicy") budgetChanged = true;
          if (!budgetChanged && previous?.readBudgets.length === 0 && s.readBudgets.length === 1) {
            witnesses.add(`initial-budget:${trace.steps[0]!.choice}`);
          }
          for (const event of s.events) {
            diagnosticWitnesses.add(`event:${event.event}`);
            if (event.event === "error" || event.event === "miss") diagnosticWitnesses.add(`${event.event}:${event.detail}`);
            if (event.event === "serialization" && event.amount > 0) diagnosticWitnesses.add(`duration:${event.detail}`);
          }
          if (step.action === "releaseRead" && previous !== undefined && previous.reply > 0 && previous.readStates[step.choice!] === 0 && previous.now < previous.deadline) {
            diagnosticWitnesses.add(`reply:${previous.reply}`);
            if (previous.tracked === 1 && [7, 12, 16].includes(previous.reply) && s.phase === 1) normalizedFenceSources.add(s.activeLoader);
            if (previous.tracked === 0 && previous.reply === 16) diagnosticWitnesses.add("untracked-demotes-fenced-reply");
            if (s.phase === 1) normalizedReplies.set(s.activeLoader, previous.reply);
          }
          if (previous !== undefined && step.action === "resolveLoader" && previous.sources[step.choice!] === 0 && previous.refill === 1 && previous.now < previous.deadline) {
            if (normalizedFenceSources.has(step.choice!) && previous.observedFence > previous.wall && s.dumps === previous.dumps) diagnosticWitnesses.add("normalized-fence-blocks-publication");
            const reply = normalizedReplies.get(step.choice!);
            if (reply !== undefined && s.observedFence === 0 && s.dumps === previous.dumps + 1) {
              diagnosticWitnesses.add(`normalized-reply-allows-refill:${reply}`);
            }
            if (reply !== undefined && s.observedFence > previous.wall && s.dumps === previous.dumps && s.calls.includes(1)) {
              diagnosticWitnesses.add(`normalized-reply-fences-refill:${reply}`);
            }
            if (step.choice === previous.activeLoader && previous.calls.filter(value => value === 0).length > 1) {
              witnesses.add("source-followers-share-accepted-result");
            }
          }
          for (const budget of s.readBudgets) witnesses.add(`read-budget:${budget}`);
          if (step.action === "beginCall" && previous?.phase === 3 && previous.readBudget !== previous.readBudgets[previous.activeRead]) witnesses.add("follower-keeps-read-budget");
          if (s.sources.includes(0) && s.sources.includes(1)) witnesses.add("abandoned-overlap");
          if (step.action === "seedRemote") delayedWriteWasFenced = false;
          if (previous?.phase === 3 && s.phase === 1) {
            failedRead = step.action === "failRead" || s.readAborts > previous.readAborts;
            failedDecode = false;
            if (s.readAborts > previous.readAborts) {
              witnesses.add("read-timeout-starts-source");
              if (step.action !== "tick") witnesses.add("read-late-settlement");
            }
          }
          if ((step.action === "releaseRead" || step.action === "failRead") && previous?.readStates[step.choice!] === 1) {
            witnesses.add("abandoned-read-settles");
          }
          if (step.action === "releaseRead" && s.phase === 4) { acquiredAt = s.wall; decodeStarted = s.now; }
          if (step.action === "releaseLoad" && acquiredAt !== undefined) {
            if (s.now - decodeStarted >= 10) witnesses.add("decode-outlives-deadline");
            if (s.watermark >= acquiredAt) witnesses.add("acquired-hit-survives-invalidation");
            if (s.now - decodeStarted >= 10 && s.readAborts === previous?.readAborts && s.loaders === previous.loaders) {
              witnesses.add("successful-read-has-no-late-cancel");
            }
          }
          if (step.action === "failLoad") failedDecode = true;
          if (step.action === "resolveLoader" && previous?.sources[step.choice!] === 0 && previous.now < previous.deadline) {
            if (failedRead && s.phase === 0 && s.dumps === previous.dumps) witnesses.add("failed-read-no-refill");
            if (failedDecode && s.dumps > previous.dumps) witnesses.add("failed-decode-refills");
          }
          if (step.action === "releaseDump" && s.phase === 0) witnesses.add("dump-rechecks-fence-after-rollback");
          if (step.action === "failDump") witnesses.add("dump-failure-preserves-value");
          if (step.action === "failWrite") witnesses.add("write-failure-preserves-value");
          if (step.action === "releaseDump" && previous !== undefined && previous.now >= previous.deadline) witnesses.add("serialize-outlives-deadline");
          if (step.action === "rejectLoader" && previous?.sources[step.choice!] === 1 &&
            s.events.filter(event => event.event === "error" && event.detail === "fallback").length ===
              previous.events.filter(event => event.event === "error" && event.detail === "fallback").length &&
            s.calls.every((value, index) => value === previous.calls[index])) witnesses.add("late-rejection-does-not-repeat-error");
          if (step.action === "releaseWrite") {
            delayedWriteWasFenced = s.storedTimestamp <= s.watermark;
            if (previous !== undefined && previous.now >= previous.deadline) witnesses.add("publication-after-deadline");
          }
          // Require a later public read/refill to expose the stored stale write.
          if (delayedWriteWasFenced && step.action === "releaseRead" && previous?.phase === 3
            && s.loaders === previous.loaders + 1) witnesses.add("delayed-fenced-write");
          if (previous?.phase === 1 && previous.sources[step.choice!] === 0 && previous.now >= previous.deadline
            && (step.action === "resolveLoader" || step.action === "rejectLoader")) {
            witnesses.add("late-settlement");
            witnesses.add(step.action === "resolveLoader" ? "late-resolve" : "late-reject");
          }
        }
      }
      const required = JSON.parse(readFileSync(new URL("../formal/coverage-witnesses.json", import.meta.url), "utf8")) as Record<string, string[]>;
      const allWitnesses = new Set([...witnesses, ...diagnosticWitnesses, ...effectsAuthorityWitnesses(traces.map(trace => trace.path))]);
      expect(required.effects!.filter(witness => !allWitnesses.has(witness)), "Missing effects witnesses").toEqual([]);
      expect([...seen].sort()).toEqual([...actions].sort());
      recordWitnesses("effects", allWitnesses, required.effects!, traces);
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
