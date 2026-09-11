import assert from "node:assert/strict";
import { assertSubset } from "./validation.mjs";
import { assertInputMetadata, itfInteger, itfSignedInteger, record } from "./itf.mjs";
export const actions = ["init", "beginCall", "resolveLoader", "rejectLoader", "releaseRead", "failRead", "releaseLoad", "failLoad", "releaseDump", "failDump", "releaseWrite", "failWrite", "seedRemote", "tick", "jumpClock", "rollbackWall", "observerFault", "readBudgetPolicy", "adapterReply", "invalidate", "futureFence"];
const fields = ["now", "wall", "readStarted", "decodeStarted", "tracked", "reply", "replyAt", "readBudget", "baseReadBudget", "phase", "activeLoader", "activeRead", "deadline", "refill", "acceptedAt", "acceptedWall", "observerFailed", "readAborts", "observedFence", "writeTimestamp", "storedTimestamp", "watermark",
  "loaders", "reads", "writes", "invalidations", "loads", "dumps", "policyCalls"];
export const observedFields = ["loaders", "reads", "writes", "invalidations", "loads", "dumps", "policyCalls"];
const eventNames = ["request", "disabled", "miss", "error", "coalesced", "invalidation", "get", "fallback", "serialization", "futureOffset", "size", "storedSize", "writeDispatch"];
const timedEvents = new Set(["get", "fallback", "serialization", "futureOffset"]);
export function parseTrace(value, path) {
  const states = record(value, path).states;
  if (!Array.isArray(states) || states.length < 2)
    throw new Error(`${path}: expected a nonempty trace`);
  const steps = states.map((raw, index) => {
    const context = `${path} step ${index}`;
    const step = record(raw, context);
    const input = record(step.input, context);
    if (Object.keys(input).sort().join() !== "choice,name")
      throw new Error(`${context}: invalid explicit input`);
    const action = input.name;
    if (!actions.some((name) => name === action) || ((index === 0) !== (action === "init"))) {
      throw new Error(`${context}: unknown or misplaced action ${JSON.stringify(action)}`);
    }
    const chosen = action === "init" || action === "adapterReply" || action === "readBudgetPolicy" || action === "observerFault" || action === "resolveLoader" || action === "rejectLoader" || action === "releaseRead" || action === "failRead";
    const encoded = itfSignedInteger(input.choice, context);
    let choice;
    if (chosen) {
      if (encoded < 0)
        throw new Error(`${context}: missing effect choice`);
      choice = encoded;
      if ((action === "init" && choice > 5) || (action === "readBudgetPolicy" && choice > 4)
        || (action === "observerFault" && choice > 1)
        || (action === "adapterReply" && (choice < 1 || choice > 16)))
        throw new Error(`${context}: unsupported effect choice`);
    }
    else if (encoded !== -1)
      throw new Error(`${context}: unexpected effect choice`);
    assertInputMetadata(step, action, encoded, chosen, context);
    const rawState = record(step.s, context);
    if (Object.keys(rawState).length !== fields.length + 5)
      throw new Error(`${context}: unexpected model fields`);
    const integers = Object.fromEntries(fields.map((field) => [field, itfInteger(rawState[field], `${context} ${field}`)]));
    const state = { ...integers, calls: [], sources: [], readStates: [], readBudgets: [], events: [] };
    for (const field of ["calls", "sources", "readStates", "readBudgets"]) {
      const values = rawState[field];
      if (!Array.isArray(values))
        throw new Error(`${context}: missing ${field} list`);
      state[field] = values.map((value) => itfInteger(value, `${context} ${field}`));
      if (state[field].some((value) => (field === "readBudgets" ? ![10, 20, 30, 50].includes(value) : value > (field === "calls" ? 3 : 2)))) {
        throw new Error(`${context}: unsupported ${field} code`);
      }
    }
    if (!Array.isArray(rawState.events))
      throw new Error(`${context}: missing event observations`);
    state.events = rawState.events.map(raw => {
      const value = record(raw, context);
      if (Object.keys(value).sort().join() !== "amount,detail,event,location" || typeof value.event !== "string" ||
        !eventNames.some(event => event === value.event) || typeof value.location !== "string" || typeof value.detail !== "string") {
        throw new Error(`${context}: invalid event observation`);
      }
      const amount = itfInteger(value.amount, context);
      return { event: value.event, location: value.location, detail: value.detail, amount: timedEvents.has(value.event) ? amount / 1000 : amount };
    });
    return { action: action, ...(choice === undefined ? {} : { choice }), state };
  });
  return { path, steps };
}
// Concrete JSON encodings of the model's semantic reply classes. Timestamps
// come from the controlled external clock, never expected model state.
function adapterReply(choice, stamp) {
  const replies = [null, 42, { kind: "watermark_miss", observedWatermarkMs: stamp + 20 },
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
  return replies[choice - 1];
}
export function inputsFor(step, observed, environment) {
  const release = (effect, index, failed = false) => [
    { op: "faults", value: { [effect]: failed } }, { op: "release", effect, index },
    { op: "faults", value: { [effect]: false } },
  ];
  switch (step.action) {
    case "init": return [{ op: "policy", value: step.choice === 3 ? { remoteReadTimeoutMs: 30 } : step.choice === 4 ? null : {} }];
    case "beginCall": return [{ op: "begin" }];
    case "resolveLoader": return [{ op: "resolve", loader: step.choice, value: 1 }];
    case "rejectLoader": return [{ op: "reject", loader: step.choice }];
    case "releaseRead": return release("read", step.choice);
    case "failRead": return release("read", step.choice, true);
    case "releaseLoad": return release("load", observed.loads - 1);
    case "failLoad": return release("load", observed.loads - 1, true);
    case "releaseDump": return release("dump", observed.dumps - 1);
    case "failDump": return release("dump", observed.dumps - 1, true);
    case "releaseWrite": return release("write", observed.writes - 1);
    case "failWrite": return release("write", observed.writes - 1, true);
    case "seedRemote": return [{ op: "seed", value: 1 }];
    case "tick": return [{ op: "advance", ms: 10 }];
    case "jumpClock": return [{ op: "advance", ms: 10, deliverTimers: false }];
    case "readBudgetPolicy": return [{ op: "policy", value: step.choice === 0 ? {} : { remoteReadTimeoutMs: [0, 10, 20, 30, 50][step.choice] } }];
    case "adapterReply": return [{ op: "adapterReply", value: adapterReply(step.choice, environment.wallMs) }];
    case "observerFault": return [{ op: "faults", value: { observer: step.choice === 1 } }];
    case "rollbackWall": return [{ op: "shiftWall", ms: -1000 }];
    case "invalidate": return [{ op: "invalidate" }];
    case "futureFence": return [{ op: "invalidate", futureBufferMs: 20 }];
  }
}
function projectEvents(observed) {
  return observed.events.filter(event => event.event !== "readContext" && event.event !== "readAbort").map(event => {
    if (event.event === "writeDispatch") {
      if (typeof event.index !== "number")
        throw new Error("Missing actual write index");
      return { event: event.event, location: "remote", detail: "", amount: event.index };
    }
    assertSubset(event, { cacheNamespace: "urn", keyType: "id" });
    if (event.event !== "invalidation")
      assert.deepEqual(event.useCase, "Behavior");
    if (event.event === "error")
      assert.deepEqual(event.inFallback, event.error === "fallback");
    const location = event.layer ?? event.scope;
    const detail = event.reason ?? event.error ?? event.operation ?? "";
    const amount = event.seconds ?? event.bytes ?? 0;
    if (typeof location !== "string" || typeof detail !== "string" || typeof amount !== "number")
      throw new Error("Invalid actual diagnostic observation");
    return { event: event.event, location, detail, amount };
  });
}
export function project(observed) {
  return {
    ...Object.fromEntries(observedFields.map((field) => [field, observed[field]])),
    calls: observed.calls.map((call) => call.status === "pending" ? 0
      : call.status === "value" ? (call.value === 1 ? 1 : 4)
        : call.error.startsWith("source:") ? 2 : call.error.startsWith("timeout:") ? 3 : 4),
    writeTtls: observed.writeTtls, events: projectEvents(observed),
    readContexts: observed.events.filter(event => event.event === "readContext").map(({ index, timeoutMs, aborted }) => ({ index, timeoutMs, aborted })),
    readAborts: observed.events.filter(event => event.event === "readAbort").map(event => event.index),
  };
}
export function fixtureFor(mode) {
  return { policy: { ttlSec: { remote: 60 }, ...(mode >= 2 ? { remoteReadTimeoutMs: 10 } : {}) },
    tracked: mode !== 5, readTimeoutMs: mode === 0 ? "default" : 20, observe: ["readContext", "readAbort", ...eventNames] };
}
export function expectedObservations(trace) { const aborted = []; return trace.steps.map((step, index) => { const previous = trace.steps[index - 1]?.state; if (previous !== undefined && step.state.readAborts > previous.readAborts)
  aborted.push(previous.activeRead); return { ...Object.fromEntries(observedFields.map(field => [field, step.state[field]])), calls: step.state.calls, events: step.state.events, writeTtls: Array(step.state.writes).fill(60000), readAborts: [...aborted], readContexts: step.state.readBudgets.map((timeoutMs, index) => ({ index, timeoutMs, aborted: false })) }; }); }
