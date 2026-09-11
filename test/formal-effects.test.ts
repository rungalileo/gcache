import { effectsAuthorityWitnesses } from "./formal/effects-authority-witnesses.js";
import { recordWitnesses } from "./formal/coverage-evidence.js";

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BehaviorDriver, type Input, type Fixture, type Observation, type AdapterReply } from "./formal/behavior-driver.js";
import { itfInteger, itfSignedInteger, record } from "./formal/itf.js";
import { assertEffectsHistory } from "./formal/effects-contract.js";

const actions = ["init", "beginCall", "resolveLoader", "rejectLoader", "releaseRead", "failRead", "releaseLoad", "failLoad", "releaseDump", "failDump", "releaseWrite", "failWrite", "seedRemote", "tick", "jumpClock", "rollbackWall", "observerFault", "readBudgetPolicy", "adapterReply", "invalidate", "futureFence"] as const;
type Action = typeof actions[number];
const fields = ["now", "wall", "readStarted", "decodeStarted", "tracked", "reply", "replyAt", "readBudget", "baseReadBudget", "phase", "activeLoader", "activeRead", "deadline", "refill", "acceptedAt", "acceptedWall", "observerFailed", "readAborts", "observedFence", "writeTimestamp", "storedTimestamp", "watermark",
  "loaders", "reads", "writes", "invalidations", "loads", "dumps", "policyCalls"] as const;
const observedFields = ["loaders", "reads", "writes", "invalidations", "loads", "dumps", "policyCalls"] as const;
interface Event { event: string; location: string; detail: string; amount: number }
const eventNames = ["request", "disabled", "miss", "error", "coalesced", "invalidation", "get", "fallback", "serialization", "futureOffset", "size", "storedSize", "writeDispatch"] as const;
const timedEvents = new Set(["get", "fallback", "serialization", "futureOffset"]);
type State = Record<typeof fields[number], number> & { calls: number[]; sources: number[]; readStates: number[]; readBudgets: number[]; events: Event[] };
interface Step { action: Action; choice?: number; state: State }
interface Trace { path: string; steps: Step[] }

function parseTrace(value: unknown, path: string): Trace {
  const states = record(value, path).states;
  if (!Array.isArray(states) || states.length < 2) throw new Error(`${path}: expected a nonempty trace`);
  const steps = states.map((raw, index): Step => {
    const context = `${path} step ${index}`;
    const step = record(raw, context);
    const input = record(step.input, context);
    if (Object.keys(input).sort().join() !== "choice,name") throw new Error(`${context}: invalid explicit input`);
    const action = input.name;
    if (!actions.some((name) => name === action) || ((index === 0) !== (action === "init"))) {
      throw new Error(`${context}: unknown or misplaced action ${JSON.stringify(action)}`);
    }
    const chosen = action === "init" || action === "adapterReply" || action === "readBudgetPolicy" || action === "observerFault" || action === "resolveLoader" || action === "rejectLoader" || action === "releaseRead" || action === "failRead";
    const encoded = itfSignedInteger(input.choice, context);
    let choice: number | undefined;
    if (chosen) {
      if (encoded < 0) throw new Error(`${context}: missing effect choice`);
      choice = encoded;
      if ((action === "init" && choice > 5) || (action === "readBudgetPolicy" && choice > 4)
        || (action === "observerFault" && choice > 1)
        || (action === "adapterReply" && (choice < 1 || choice > 16))) throw new Error(`${context}: unsupported effect choice`);
    } else if (encoded !== -1) throw new Error(`${context}: unexpected effect choice`);
    const rawState = record(step.s, context);
    if (Object.keys(rawState).length !== fields.length + 5) throw new Error(`${context}: unexpected model fields`);
    const integers = Object.fromEntries(fields.map((field) => [field, itfInteger(rawState[field], `${context} ${field}`)])) as Record<typeof fields[number], number>;
    const state: State = { ...integers, calls: [], sources: [], readStates: [], readBudgets: [], events: [] };
    for (const field of ["calls", "sources", "readStates", "readBudgets"] as const) {
      const values = rawState[field];
      if (!Array.isArray(values)) throw new Error(`${context}: missing ${field} list`);
      state[field] = values.map((value) => itfInteger(value, `${context} ${field}`));
      if (state[field].some((value) => (field === "readBudgets" ? ![10, 20, 30, 50].includes(value) : value > (field === "calls" ? 3 : 2)))) {
        throw new Error(`${context}: unsupported ${field} code`);
      }
    }
    if (!Array.isArray(rawState.events)) throw new Error(`${context}: missing event observations`);
    state.events = rawState.events.map(raw => {
      const value = record(raw, context);
      if (Object.keys(value).sort().join() !== "amount,detail,event,location" || typeof value.event !== "string" ||
        !eventNames.some(event => event === value.event) || typeof value.location !== "string" || typeof value.detail !== "string") {
        throw new Error(`${context}: invalid event observation`);
      }
      const amount = itfInteger(value.amount, context);
      return { event: value.event, location: value.location, detail: value.detail, amount: timedEvents.has(value.event) ? amount / 1000 : amount };
    });
    return { action: action as Action, ...(choice === undefined ? {} : { choice }), state };
  });
  return { path, steps };
}

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

// Concrete JSON encodings of the model's semantic reply classes. Timestamps
// come from the controlled external clock, never expected model state.
function adapterReply(choice: number): AdapterReply {
  const stamp = Date.now();
  const replies: AdapterReply[] = [null, 42, { kind: "watermark_miss", observedWatermarkMs: stamp + 20 },
    { reason: "value_absent" }, { kind: "miss" }, { kind: "miss", reason: "invented" },
    { kind: "miss", reason: "invented", observedWatermarkMs: stamp + 20 },
    { kind: "miss", reason: "watermark_fenced" }, { kind: "miss", reason: "watermark_fenced", observedWatermarkMs: -1 },
    { kind: "miss", reason: "value_absent", observedWatermarkMs: 1.5 },
    { kind: "miss", reason: "value_absent", observedWatermarkMs: 9007199254740992 },
    { kind: "miss", reason: "value_absent", observedWatermarkMs: stamp + 20 },
    { kind: "miss", reason: "expired", observedWatermarkMs: 0 },
    { kind: "miss", reason: "value_absent", payload: "1", createdAtMs: stamp },
    { reason: "watermark_fenced", observedWatermarkMs: stamp + 20, payload: "1", createdAtMs: stamp },
    { kind: "miss", reason: "watermark_fenced", observedWatermarkMs: stamp + 20 }];
  return replies[choice - 1]!;
}
function inputsFor(step: Pick<Step, "action" | "choice">, driver: BehaviorDriver): Input[] {
  const observed = driver.snapshot();
  const release = (effect: "read" | "load" | "dump" | "write", index: number, failed = false): Input[] => [
    { op: "faults", value: { [effect]: failed } }, { op: "release", effect, index },
    { op: "faults", value: { [effect]: false } },
  ];
  switch (step.action) {
    case "init": return [{ op: "policy", value: step.choice === 3 ? { remoteReadTimeoutMs: 30 } : step.choice === 4 ? null : {} }];
    case "beginCall": return [{ op: "begin" }];
    case "resolveLoader": return [{ op: "resolve", loader: step.choice!, value: 1 }];
    case "rejectLoader": return [{ op: "reject", loader: step.choice! }];
    case "releaseRead": return release("read", step.choice!);
    case "failRead": return release("read", step.choice!, true);
    case "releaseLoad": return release("load", observed.loads - 1);
    case "failLoad": return release("load", observed.loads - 1, true);
    case "releaseDump": return release("dump", observed.dumps - 1);
    case "failDump": return release("dump", observed.dumps - 1, true);
    case "releaseWrite": return release("write", observed.writes - 1);
    case "failWrite": return release("write", observed.writes - 1, true);
    case "seedRemote": return [{ op: "seed", value: 1 }];
    case "tick": return [{ op: "advance", ms: 10 }];
    case "jumpClock": return [{ op: "advance", ms: 10, deliverTimers: false }];
    case "readBudgetPolicy": return [{ op: "policy", value: step.choice === 0 ? {} : { remoteReadTimeoutMs: [0, 10, 20, 30, 50][step.choice!]! } }];
    case "adapterReply": return [{ op: "adapterReply", value: adapterReply(step.choice!) }];
    case "observerFault": return [{ op: "faults", value: { observer: step.choice === 1 } }];
    case "rollbackWall": return [{ op: "shiftWall", ms: -1000 }];
    case "invalidate": return [{ op: "invalidate" }];
    case "futureFence": return [{ op: "invalidate", futureBufferMs: 20 }];
  }
}

function projectEvents(observed: Observation): Event[] {
  return observed.events!.filter(event => event.event !== "readContext" && event.event !== "readAbort").map(event => {
    if (event.event === "writeDispatch") {
      if (typeof event.index !== "number") throw new Error("Missing actual write index");
      return { event: event.event, location: "remote", detail: "", amount: event.index };
    }
    expect(event).toMatchObject({ cacheNamespace: "urn", keyType: "id" });
    if (event.event !== "invalidation") expect(event.useCase).toBe("Behavior");
    if (event.event === "error") expect(event.inFallback).toBe(event.error === "fallback");
    const location = event.layer ?? event.scope;
    const detail = event.reason ?? event.error ?? event.operation ?? "";
    const amount = event.seconds ?? event.bytes ?? 0;
    if (typeof location !== "string" || typeof detail !== "string" || typeof amount !== "number") throw new Error("Invalid actual diagnostic observation");
    return { event: event.event, location, detail, amount };
  });
}
function project(driver: BehaviorDriver) {
  const observed = driver.snapshot();
  return {
    ...Object.fromEntries(observedFields.map((field) => [field, observed[field]])),
    calls: observed.calls.map((call) => call.status === "pending" ? 0
      : call.status === "value" ? (call.value === 1 ? 1 : 4)
      : call.error.startsWith("source:") ? 2 : call.error.startsWith("timeout:") ? 3 : 4),
    writeTtls: observed.writeTtls, events: projectEvents(observed),
    readContexts: observed.events!.filter(event => event.event === "readContext").map(({ index, timeoutMs, aborted }) => ({ index, timeoutMs, aborted })),
    readAborts: observed.events!.filter(event => event.event === "readAbort").map(event => event.index),
  };
}

function fixtureFor(mode: number): Fixture {
  return { policy: { ttlSec: { remote: 60 }, ...(mode >= 2 ? { remoteReadTimeoutMs: 10 } : {}) },
    tracked: mode !== 5, readTimeoutMs: mode === 0 ? "default" : 20, observe: ["readContext", "readAbort", ...eventNames] };
}
async function replay(trace: Trace) {
  // Configuration is an explicit initial input, independent of expected state.
  const driver = new BehaviorDriver(fixtureFor(trace.steps[0]!.choice!));
  try {
    await driver.apply({ op: "faults", value: { holdReads: true, holdLoads: true, holdDumps: true, holdWrites: true } });
    const abortedReads: number[] = [];
    for (const [index, step] of trace.steps.entries()) {
      const previous = trace.steps[index - 1]?.state;
      if (previous !== undefined && step.state.readAborts > previous.readAborts) abortedReads.push(previous.activeRead);
      const context = `${trace.path} step ${index} action ${step.action}`;
      const expected = { ...Object.fromEntries(observedFields.map((field) => [field, step.state[field]])),
        calls: step.state.calls, events: step.state.events, writeTtls: Array<number>(step.state.writes).fill(60_000), readAborts: abortedReads, readContexts: step.state.readBudgets.map((timeoutMs, index) => ({ index, timeoutMs, aborted: false })) };
      try {
        // Only the action/choice and independently observed effect index enter execution.
        const inputs = inputsFor({ action: step.action, ...(step.choice === undefined ? {} : { choice: step.choice }) }, driver);
        for (const input of inputs) await driver.apply(input);
        // Check C23/C25/C26 directly on observed history, independently of
        // expected Quint phases, timestamps, and outcome predictions.
        assertEffectsHistory(driver.contractHistory());
        expect(project(driver), context).toEqual(expected);
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
