import assert from "node:assert/strict";
import { assertInputMetadata, record, itfInteger, itfSignedInteger } from "./itf.mjs";
export const actionNames = [
  "init", "bumpSource", "outsideCall", "requestLocalPair", "localCall",
  "coalescedLocalPair", "remoteCall", "invalidateRemote", "remoteReadFailureCall",
];
// Only these model fields are observable through the public API/environment.
// Cache-presence/value fields stay in Quint to predict future observations;
// a loader invocation alone is not evidence that a local value was published.
export const observationFields = [
  "sourceVersion", "lastResult", "outsideLoaderCalls", "requestLoaderCalls",
  "localLoaderCalls", "coalescedLoaderCalls", "remoteLoaderCalls", "redisReads", "redisWrites",
];
export function parseItfTrace(value, path) {
  const parsed = record(value, path);
  if (!Array.isArray(parsed.states) || parsed.states.length < 2) {
    throw new Error(`${path}: expected init and at least one action`);
  }
  const states = parsed.states.map((value, index) => {
    const context = `${path} step ${index}`;
    const state = record(value, context);
    const input = record(state.input, `${context} input`);
    if (Object.keys(input).sort().join() !== "choice,name"
      || itfSignedInteger(input.choice, `${context} input choice`) !== -1) {
      throw new Error(`${context}: core actions have no external arguments`);
    }
    const action = input.name;
    if (!actionNames.some((name) => name === action) || ((index === 0) !== (action === "init"))) {
      throw new Error(`${context}: unknown or misplaced action ${JSON.stringify(action)}`);
    }
    assertInputMetadata(state, action, -1, false, context);
    const raw = record(state.s, context);
    const integerFields = [
      ...observationFields, "localValue", "coalescedValue", "remoteValue",
    ];
    const booleanFields = ["localCached", "coalescedCached", "remoteReadable"];
    if (Object.keys(raw).length !== integerFields.length + booleanFields.length) {
      throw new Error(`${context}: unexpected model state fields`);
    }
    const decoded = {};
    for (const field of integerFields) {
      decoded[field] = itfInteger(raw[field], `${context} ${field}`);
    }
    for (const field of booleanFields) {
      if (typeof raw[field] !== "boolean")
        throw new Error(`${context}: expected boolean ${field}`);
      decoded[field] = raw[field];
    }
    return { action: action, state: decoded };
  });
  return { path, states };
}
const identity = useCase => ({
  keyType: "user_id", id: "123", useCase, tracked: useCase === "ConformanceRemote",
});
const localPolicy = { ttlSec: { local: 60 }, ramp: { local: 100 } };
const calls = {
  outsideCall: {
    identity: identity("ConformanceOutside"), policy: localPolicy,
    mode: "outside", counter: "outsideLoaderCalls",
  },
  requestLocalPair: {
    identity: identity("ConformanceRequest"), policy: { requestLocal: true },
    mode: "request-pair", counter: "requestLoaderCalls",
  },
  localCall: {
    identity: identity("ConformanceLocal"), policy: localPolicy,
    mode: "single", counter: "localLoaderCalls",
  },
  coalescedLocalPair: {
    identity: identity("ConformanceCoalesced"), policy: localPolicy,
    mode: "coalesced-pair", counter: "coalescedLoaderCalls",
  },
  remoteCall: {
    identity: identity("ConformanceRemote"),
    policy: { ttlSec: { remote: 60 }, ramp: { remote: 100 } },
    mode: "single", counter: "remoteLoaderCalls",
  },
};

export function coreCommands(action) {
  if (!actionNames.includes(action)) throw new Error("Unknown core command");
  if (action === "init") return [];
  // Preserve the core profile's explicit one-millisecond wall step. It never
  // advances a monotonic deadline or depends on expected cache contents.
  const clock = { op: "advanceWall", ms: 1 };
  if (action === "bumpSource") return [clock, { op: "bumpSource" }];
  if (action === "invalidateRemote") {
    return [clock, { op: "invalidate", identity: identity("ConformanceRemote") }];
  }
  const readFailure = action === "remoteReadFailureCall";
  const call = structuredClone(calls[readFailure ? "remoteCall" : action]);
  return [clock, { op: "call", ...call, readFailure }];
}

export function expectedCoreObservation(state) {
  return Object.fromEntries(observationFields.map(field => [field, state[field]]));
}

export function assertCoreObservation(state, observed) {
  assert.deepEqual(observed, expectedCoreObservation(state));
}
