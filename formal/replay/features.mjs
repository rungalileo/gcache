import assert from "node:assert/strict";
import { assertSubset } from "./validation.mjs";
import { emptyObservation } from "./observation.mjs";
import { assertInputMetadata, itfInteger, itfSignedInteger, record } from "./itf.mjs";
import { recoveryReadProfile } from "./profiles/recovery-read.mjs";
import { localFailureProfile } from "./profiles/local-failure.mjs";
import { runtimeBoundariesProfile } from "./profiles/runtime-boundaries.mjs";
import { shadowLayersProfile } from "./profiles/shadow-layers.mjs";
import { sourceBudgetsProfile } from "./profiles/source-budgets.mjs";
const settle = (op) => ({
  ...(op === "resolve" ? { choices: [1, 2] } : {}),
  input: (choice, o) => op === "resolve" ? { op, loader: o.loaders - 1, value: choice } : { op, loader: o.loaders - 1 },
});
// Portable success codes reserve 0/3/4 for pending/source-error/deadline.
export const successValues = [1, 2, undefined, null, false, 0, ""];
const resolveValue = (maxSources) => ({
  choices: Array.from({ length: maxSources * successValues.length }, (_, i) => i + 1),
  input: (choice) => {
    const value = successValues[(choice - 1) % successValues.length];
    return { op: "resolve", loader: Math.floor((choice - 1) / successValues.length), ...(value === undefined ? {} : { value }) };
  },
});
const effectCounts = { read: "reads", load: "loads", dump: "dumps", write: "writes", policy: "policyCalls" };
const release = (effect) => ({
  input: (_, o) => ({ op: "release", effect, index: o[effectCounts[effect]] - 1 }),
});
const fault = (field) => ({
  choices: [0, 1], input: (choice) => ({ op: "faults", value: { [field]: choice === 1 } }),
});
const advance = (choices) => ({ choices, input: (choice) => ({ op: "advance", ms: choice }) });
const overlays = [
  {}, { ttlSec: { local: 2 } }, { ttlSec: { remote: 2 } }, { ramp: { local: 0 } },
  { ramp: { remote: 0 } }, { ttlSec: { local: -1 } }, { ttlSec: { remote: -1 } },
  { staleOnErrorMaxAgeSec: 2 }, { ramp: { local: 0, remote: 0 } },
  { ttlSec: { remote: 4 }, staleOnErrorMaxAgeSec: 0 },
];
const policyOverlays = overlays.concat(overlays.map((overlay) => ({ ...overlay, coalesce: false })), [
  { remoteReadTimeoutMs: 0 }, { ramp: { local: 101 } }, { ramp: { remote: 101 } },
  { staleOnErrorMaxAgeSec: 1 }, { staleOnErrorMaxAgeSec: -1 }, { shadow: { ramp: 101 } },
]);
const layerPolicies = [{}, { requestLocal: false }, { ramp: { local: 0 } },
  { ramp: { remote: 0 } }, { ramp: { local: 0, remote: 0 } }, { requestLocal: false, ramp: { local: 0, remote: 0 } }];
const shadowSeed = { choices: [1, 2, 3, 4, 5, 6, 7, 8], input: (choice) => choice <= 2
    ? { op: "seed", value: choice } : choice === 7 ? { op: "seed", payloadText: JSON.stringify("café") }
    : choice === 8 ? { op: "seed", payloadHex: "22636166c3a922" } : choice === 6 ? { op: "seed", payloadText: " 1" }
      : { op: "seed", payloadHex: choice === 3 ? "31" : choice === 4 ? "32" : "2031" } };
export const profiles = {
  "source-budgets": sourceBudgetsProfile,
  "runtime-boundaries": runtimeBoundariesProfile,
  "shadow-layers": shadowLayersProfile,
  "local-failure": localFailureProfile,
  "recovery-read": recoveryReadProfile,
  independent: {
    explicitInputs: true,
    readIO: true,
    fixture: { policy: { ttlSec: { remote: 1 }, staleOnErrorMaxAgeSec: 5, coalesce: false },
      tracked: true, readTimeoutMs: 5, fallbackTimeoutMs: 10, recovery: "allow", observe: ["readContext", "readAbort"] },
    setup: [{ op: "seed", value: 1, ageMs: 1000 }, { op: "faults", value: { holdReads: true, holdLoads: true } }],
    actions: {
      beginCall: { input: () => ({ op: "begin" }) },
      ...Object.fromEntries(["read", "load"].flatMap(effect => [false, true].map(fail => [`${fail ? "fail" : "release"}${effect === "read" ? "Read" : "Load"}`, {
          choices: [0, 1, 2, 3, 4, 5], input: (choice) => ({ op: "release", effect, index: choice, fail }),
        }]))),
      resolveLoader: { choices: Array.from({ length: 12 }, (_, i) => i + 1), input: choice => ({ op: "resolve", loader: Math.floor((choice - 1) / 2), value: (choice - 1) % 2 + 1 }) },
      rejectLoader: { choices: [0, 1, 2, 3, 4, 5], input: choice => ({ op: "reject", loader: choice }) },
      advance: advance([1, 5, 10, 1000]),
      seed: { choices: [0, 1, 2, 3, 4, 5], input: choice => ({ op: "seed", value: choice === 2 || choice === 4 ? 2 : 1,
          ageMs: choice === 0 || choice === 4 ? 0 : choice === 3 ? 4999 : choice === 5 ? 1999 : 1000 }) },
      invalidate: { input: () => ({ op: "invalidate" }) },
      policy: { choices: [0, 1, 2, 3], input: choice => ({ op: "policy", value: {
            remoteReadTimeoutMs: choice % 2 === 0 ? 5 : 10, staleOnErrorMaxAgeSec: choice < 2 ? 5 : 2
          } }) },
    },
  },
  layers: {
    explicitInputs: true,
    initChoices: [0, 1, 2, 3, 4, 5],
    fixture: (choice) => ({ policy: { requestLocal: true, ttlSec: { local: 60, remote: 60 } },
      tracked: choice % 2 === 1, remote: choice < 4, localMaxSize: choice === 2 || choice === 3 ? 0 : 2, fallbackTimeoutMs: null }),
    setup: [0, 1, 2].map(scope => ({ op: "openScope", id: String(scope), instance: scope === 2 ? "1" : "0" })),
    actions: {
      beginCall: { choices: Array.from({ length: 20 }, (_, i) => i), input: (choice) => {
          const context = Math.floor(choice / 4);
          const identity = choice % 4;
          return { op: "begin", key: String(Math.floor(identity / 2)), useCase: `Layers${identity % 2}`,
            ...(context < 3 ? { scope: String(context) } : { instance: context === 4 ? "1" : "0" }) };
        } },
      resolveLoader: { choices: Array.from({ length: 40 }, (_, i) => i + 1),
        input: (choice) => ({ op: "resolve", loader: Math.floor((choice - 1) / 2), value: (choice - 1) % 2 + 1 }) },
      rejectLoader: { choices: Array.from({ length: 20 }, (_, i) => i), input: (choice) => ({ op: "reject", loader: choice }) },
      closeScope: { choices: [0, 1, 2], input: (choice) => ({ op: "closeScope", id: String(choice) }) },
      policy: { choices: [0, 1, 2, 3, 4, 5], input: (choice) => ({ op: "policy", value: layerPolicies[choice] }) },
      seed: { choices: [0, 1, 2, 3, 4, 5, 6, 7], input: (choice) => ({ op: "seed",
          key: String(Math.floor(choice / 4)), useCase: `Layers${Math.floor(choice / 2) % 2}`, value: choice % 2 + 1 }) },
      invalidate: { choices: [0, 1], input: (choice) => ({ op: "invalidate", key: String(choice) }) },
      tick: { input: () => ({ op: "advance", ms: 1 }) },
    },
  },
  admission: {
    explicitInputs: true,
    fixture: { policy: { ttlSec: { remote: 60 }, shadow: { ramp: 100 } }, tracked: true,
      shadowMaxInFlight: 2, readTimeoutMs: 1000, probeSourceScope: true },
    setup: [0, 1, 2].map((key) => ({ op: "seed", key: String(key), value: 1 }))
      .concat([{ op: "faults", value: { holdReads: true, holdLoads: true } }]),
    actions: {
      beginCall: { choices: [0, 1, 2, 3, 4, 5], input: (choice) => ({ op: "begin",
          key: String(choice % 3), instance: String(Math.floor(choice / 3)) }) },
      releaseRead: { choices: Array.from({ length: 32 }, (_, i) => i), input: (choice) => ({ op: "release", effect: "read", index: choice }) },
      releaseLoad: { choices: Array.from({ length: 32 }, (_, i) => i), input: (choice) => ({ op: "release", effect: "load", index: choice }) },
      resolveLoader: { choices: Array.from({ length: 32 }, (_, i) => i + 1),
        input: (choice) => ({ op: "resolve", loader: Math.floor((choice - 1) / 2), value: (choice - 1) % 2 + 1 }) },
      rejectLoader: { choices: Array.from({ length: 16 }, (_, i) => i), input: (choice) => ({ op: "reject", loader: choice }) },
      seed: { choices: [0, 1, 2, 3, 4, 5], input: (choice) => ({ op: "seed", key: String(Math.floor(choice / 2)), value: choice % 2 + 1 }) },
      advance: advance([1, 10]),
      policy: { choices: [0, 1, 2, 3], input: (choice) => ({ op: "policy",
          value: { shadow: { ramp: choice % 2 === 0 ? 100 : 0 }, coalesce: choice < 2 } }) },
    },
  },
  scope: {
    explicitInputs: true,
    diagnosticAge: "none",
    fixture: { policy: { requestLocal: true }, remote: false, fallbackTimeoutMs: null, probeSourceScope: true, observe: ["coalesced", "error"] },
    setup: [{ op: "openScope", id: "0" }, { op: "faults", value: { holdPolicies: true } }],
    actions: {
      openScope: { choices: [1, 2, 3, 4], input: (choice) => ({ op: "openScope", id: String(choice),
          ...(choice === 1 ? {} : { parent: choice === 4 ? "3" : "0" }), ...(choice === 3 ? { disabled: true } : {}) }) },
      closeScope: { choices: [0, 1, 2, 3, 4], input: (choice) => ({ op: "closeScope", id: String(choice) }) },
      beginCall: { choices: [0, 1, 2, 3, 4, 5], input: (choice) => ({ op: "begin",
          ...(choice === 5 ? { outside: true } : { scope: String(choice) }) }) },
      releasePolicy: release("policy"),
      resolveLoader: resolveValue(16),
      rejectLoader: { choices: Array.from({ length: 16 }, (_, i) => i), input: (choice) => ({ op: "reject", loader: choice }) },
      policy: { choices: [0, 1, 2], input: (choice) => ({ op: "policy",
          value: choice === 0 ? {} : choice === 1 ? { requestLocal: false } : { coalesce: false } }) },
    },
  },
  recovery: {
    explicitInputs: true,
    diagnosticAge: "recoveryAge",
    initChoices: Array.from({ length: 8 }, (_, i) => i),
    fixture: (choice) => ({ policy: { ttlSec: { remote: 1 }, staleOnErrorMaxAgeSec: 5, requestLocal: choice >= 4 }, tracked: true, fallbackTimeoutMs: 10,
      recovery: ["default", "allow", "deny", "error"][choice % 4], observe: ["recoveryAge", "coalesced", "error"] }),
    setup: [{ op: "openScope", id: "0" }, { op: "openScope", id: "1" }, { op: "seed", value: 1, ageMs: 1000 }, { op: "faults", value: { holdLoads: true } }],
    actions: {
      beginCall: { choices: Array.from({ length: 8 }, (_, i) => i), input: (choice) => ({ op: "begin", scope: String(Math.floor(choice / 4)), ...(choice % 4 === 3 ? {} : { recovery: ["allow", "deny", "error"][choice % 4] }) }) },
      joinCall: { choices: [0, 1], input: (choice) => ({ op: "begin", scope: String(choice) }) },
      closeScope: { choices: [0, 1], input: (choice) => ({ op: "closeScope", id: String(choice) }) },
      resolveLoader: { choices: [0, 1, 2, 3, 4, 5, 6, 7], input: (choice) => ({ op: "resolve", loader: choice, value: 2 }) },
      rejectLoader: { choices: [0, 1, 2, 3, 4, 5, 6, 7], input: (choice) => ({ op: "reject", loader: choice }) },
      rejectTimeout: { choices: [0, 1, 2, 3, 4, 5, 6, 7], input: (choice) => ({ op: "reject", loader: choice, error: "timeout" }) },
      releaseLoad: release("load"),
      seed: { choices: [0, 1, 2, 3, 4, 5, 6], input: (choice) => ({ op: "seed", value: choice === 6 ? 2 : 1,
          ageMs: [0, 999, 1000, 4999, 5000, -1, 1000][choice] }) },
      advance: advance([1, 10, 1000, 4000]), rollbackWall: { input: () => ({ op: "shiftWall", ms: -1000 }) }, invalidate: { input: () => ({ op: "invalidate" }) },
      policy: { choices: [2000, 5000], input: (choice) => ({ op: "policy", value: { staleOnErrorMaxAgeSec: choice / 1000 } }) },
      readFault: fault("read"), loadFault: fault("load"),
    },
  },
  policy: {
    explicitInputs: true,
    policyErrorIO: true,
    fixture: { policy: { ttlSec: { local: 1, remote: 1 }, staleOnErrorMaxAgeSec: 5 }, localMaxSize: 1, fallbackTimeoutMs: null, observe: ["error"] },
    setup: [{ op: "faults", value: { holdPolicies: true } }],
    actions: {
      beginCall: { choices: [0, 1], input: (choice) => ({ op: "begin", key: String(choice) }) },
      releasePolicy: release("policy"),
      resolveLoader: resolveValue(12),
      rejectLoader: { choices: Array.from({ length: 12 }, (_, i) => i), input: (choice) => ({ op: "reject", loader: choice }) },
      seed: { choices: [0, 1, 2, 3], input: (choice) => ({ op: "seed", key: String(Math.floor(choice / 2)), value: choice % 2 + 1, ttlMs: 5000 }) },
      policy: { choices: policyOverlays.map((_, i) => i), input: (choice) => ({ op: "policy", value: policyOverlays[choice] }) },
      advance: advance([1, 500, 1000, 2000, 5000]), rollbackWall: { input: () => ({ op: "shiftWall", ms: -1000 }) }, providerFault: fault("policy"),
      readFault: fault("read"), dumpFault: fault("dump"), writeFault: fault("write"),
    },
  },
  shadow: {
    explicitInputs: true, diagnosticFutureOffsets: true,
    diagnosticAge: "shadowAge", diagnosticConfigErrors: true, initChoices: Array.from({ length: 13 }, (_, i) => i),
    fixture: (choice) => ({ policy: { ttlSec: { remote: 60 }, ramp: { remote: 0 },
        shadow: { ramp: 100, ...(choice < 4 || choice >= 8 ? {} : { logMismatches: true }) } }, tracked: true, shadowHook: choice !== 8,
      ...(choice % 4 === 0 || choice >= 11 ? {} : { comparator: ["equal", "unequal", "error"][choice === 10 ? 2 : choice % 4 - 1] }),
      ...(choice === 9 || choice === 10 ? { comparisonMs: 10 } : {}),
      ...(choice >= 11 ? { sourceWorkMs: choice === 11 ? 9 : 10 } : {}),
      observe: ["shadowAge", "mismatchWarning", "coalesced", "error", "futureOffset"] }),
    setup: [{ op: "faults", value: { holdReads: true, holdLoads: true, holdDumps: true, holdWrites: true } }],
    actions: {
      beginCall: { input: () => ({ op: "begin" }) }, resolveLoader: settle("resolve"), rejectLoader: settle("reject"),
      releaseRead: release("read"), releaseLoad: release("load"), releaseDump: release("dump"), releaseWrite: release("write"),
      advance: advance([1, 10]), seed: shadowSeed, reencode: shadowSeed,
      seedUnicode: { ...shadowSeed, choices: [7, 8] },
      invalidate: { choices: [0, 20], input: (choice) => ({ op: "invalidate", futureBufferMs: choice }) },
      readFault: fault("read"), loadFault: fault("load"), dumpFault: fault("dump"), writeFault: fault("write"),
      rollbackWall: { input: () => ({ op: "shiftWall", ms: -1000 }) },
      advanceWall: { choices: [1, 60000], input: choice => ({ op: "shiftWall", ms: choice }) },
      shadowPolicy: { choices: [0, 1, 2], input: (choice) => ({ op: "policy", value: { shadow: { ramp: [100, 0, 101][choice] } } }) },
      logPolicy: { choices: [0, 1, 2], input: (choice) => ({ op: "policy", value: { shadow: { logMismatches: choice === 2 ? "invalid" : choice === 1 } } }) },
    },
  },
};
function observation(raw, context) {
  const value = record(raw, context);
  const shape = { ...emptyObservation(), calls: [] };
  if (Object.keys(value).sort().join() !== Object.keys(shape).sort().join())
    throw new Error(`${context}: unexpected observation fields`);
  const result = Object.fromEntries(Object.entries(shape).map(([key, initial]) => {
    const item = value[key];
    if (typeof initial === "number")
      return [key, itfInteger(item, context)];
    if (!Array.isArray(item))
      throw new Error(`${context}: expected ${key} list`);
    return [key, item.map((entry) => {
        if (key === "calls" || key === "writeTtls") {
          const integer = itfInteger(entry, context);
          if (key === "calls" && (integer < 0 || integer > 9 && integer !== 11))
            throw new Error(`${context}: unsupported caller outcome`);
          return integer;
        }
        if (typeof entry !== (key === "sourceScopes" ? "boolean" : "string"))
          throw new Error(`${context}: invalid ${key} entry`);
        return entry;
      })];
  }));
  return result;
}
function diagnostics(raw, context, configErrors = false, futureOffsets = false) {
  const value = record(raw, context);
  const fields = ["ages", "coalesced", "fallbackErrors", "warnings", ...(configErrors ? ["configErrors"] : []), ...(futureOffsets ? ["futureOffsets"] : [])];
  if (Object.keys(value).sort().join() !== fields.sort().join() || !Array.isArray(value.ages))
    throw new Error(`${context}: invalid diagnostics`);
  const labels = (items, allowed) => {
    if (!Array.isArray(items) || items.some(item => typeof item !== "string" || !allowed.includes(item)))
      throw new Error(`${context}: invalid diagnostic labels`);
    return items;
  };
  const offsets = futureOffsets ? (() => {
    if (!Array.isArray(value.futureOffsets))
      throw new Error(`${context}: missing future offsets`);
    return value.futureOffsets.map(raw => {
      const offset = record(raw, context);
      if (Object.keys(offset).sort().join() !== "layer,offsetMs" || offset.layer !== "remote_shadow")
        throw new Error(`${context}: invalid future offset layer`);
      const offsetMs = itfInteger(offset.offsetMs, context);
      if (offsetMs <= 0)
        throw new Error(`${context}: future offset must be positive`);
      return { layer: offset.layer, offsetMs };
    });
  })() : [];
  return { ...(futureOffsets ? { futureOffsets: offsets } : {}), ...(configErrors ? { configErrors: itfInteger(value.configErrors, context) } : {}), warnings: itfInteger(value.warnings, context), ages: value.ages.map(age => itfInteger(age, context) / 1000),
    coalesced: labels(value.coalesced, ["process", "request_local"]), fallbackErrors: labels(value.fallbackErrors, ["noop", "local", "remote", "request_local"]) };
}
function readIO(raw, context, callCount) {
  const value = record(raw, context);
  if (Object.keys(value).sort().join() !== "aborted,budgets,sourceErrors" || !Array.isArray(value.budgets) || !Array.isArray(value.aborted) || !Array.isArray(value.sourceErrors))
    throw new Error(`${context}: invalid read observations`);
  const budgets = value.budgets.map(v => itfInteger(v, context)), aborted = value.aborted.map(v => itfInteger(v, context));
  if (budgets.some(v => v <= 0) || aborted.some(v => v >= budgets.length) || new Set(aborted).size !== aborted.length)
    throw new Error(`${context}: invalid read budget or cancellation`);
  const sourceErrors = value.sourceErrors.map(v => itfInteger(v, context));
  if (sourceErrors.length !== callCount)
    throw new Error(`${context}: missing caller error identities`);
  return { budgets, aborted, sourceErrors };
}
function markerIO(raw, context) {
  if (!Array.isArray(raw))
    throw new Error(`${context}: missing marker observations`);
  return raw.map(item => {
    const marker = record(item, context);
    if (Object.keys(marker).sort().join() !== "cutoffMs,ttlMs")
      throw new Error(`${context}: invalid marker observation`);
    return { cutoffMs: itfSignedInteger(marker.cutoffMs, context), ttlMs: itfSignedInteger(marker.ttlMs, context) };
  });
}
export function parseTrace(raw, path, profile) {
  const states = record(raw, path).states;
  if (!Array.isArray(states) || states.length < 2)
    throw new Error(`${path}: expected a nonempty trace`);
  return { path, steps: states.map((rawState, i) => {
      const context = `${path} step ${i}`;
      const state = record(rawState, context);
      // Explicit inputs are recorded by the Quint transition itself, including
      // deterministic regressions where Quint emits no MBT metadata. Never infer
      // a command from differences in expected state.
      const input = record(state.input, context);
      if (Object.keys(input).sort().join() !== "choice,name") {
        throw new Error(`${context}: invalid explicit input`);
      }
      const action = input.name;
      if (typeof action !== "string" || (i === 0 ? action !== "init" : !Object.hasOwn(profile.actions, action))) {
        throw new Error(`${context}: unknown or misplaced action`);
      }
      const choices = action === "init" ? profile.initChoices : profile.actions[action]?.choices;
      const choice = itfSignedInteger(input.choice, context);
      if (choices === undefined ? choice !== -1 : !choices.includes(choice)) {
        throw new Error(`${context}: unsupported explicit choice`);
      }
      assertInputMetadata(state, action, choice, choices !== undefined, context);
      const expected = observation(record(state.s, context).o, context);
      return { action, choice, expected,
        ...(profile.policyErrorIO ? { policyErrors: policyErrors(record(state.s, context).policyErrors, context) } : {}),
        ...(profile.compressionIO ? { compression: compressionIO(record(state.s, context).compression, context) } : {}),
        ...(profile.markerIO ? { markers: markerIO(record(state.s, context).markers, context) } : {}),
        ...(profile.readIO ? { io: readIO(record(state.s, context).io, context, expected.calls.length) } : {}),
        ...(profile.diagnosticAge === undefined ? {} : { diagnostics: diagnostics(record(state.s, context).d, context, profile.diagnosticConfigErrors, profile.diagnosticFutureOffsets) }) };
    }) };
}
function valueCode(value) {
  const v = value.value;
  if (v === 1 || v === 2)
    return v;
  if (v === null)
    return 6;
  if (v === false)
    return 7;
  if (v === 0)
    return 8;
  if (v === "")
    return 9;
  if (v === "undefined")
    return 11;
  if (typeof v === "object" && v.absent === true)
    return 5;
  return 10;
}
function project(o) {
  return { ...o, calls: o.calls.map((c) => c.status === "pending" ? 0
      : c.status === "value" ? valueCode(c)
        : c.error.startsWith("source:") ? 3 : c.error.startsWith("timeout:") ? 4 : 10) };
}
// Well-shaped observations outside a declared value domain are semantic
// failures. Keep their evidence typed so the coordinator can distinguish them
// from missing fields or malformed driver records.
function assertObservedDomain(valid, actual, expected) {
  if (!valid) throw new assert.AssertionError({ actual, expected, operator: "observed value domain" });
}
export function projectObservation(profile, observed) {
  if (profile.policyErrorIO) {
    if (observed.events === undefined)
      throw new Error("Missing actual policy diagnostics");
    const selected = observed.events.filter(event => event.event === "error" && event.layer === "noop" && event.error === "config_resolution");
    for (const event of selected)
      assertSubset(event, { cacheNamespace: "urn", useCase: "Behavior", keyType: "id", inFallback: false });
    const { events: _events, ...base } = observed;
    return { ...projectBaseObservation(profile, base), policyErrors: selected.map(() => ({ layer: "noop", errorType: "config_resolution" })) };
  }
  if (!profile.markerIO && !profile.compressionIO)
    return projectBaseObservation(profile, observed);
  const markers = [];
  const compression = [];
  const events = observed.events?.filter(event => {
    if (profile.compressionIO && event.event === "compression") {
      assertSubset(event, { cacheNamespace: "urn", useCase: "Behavior", keyType: "id", layer: "remote" });
      if (typeof event.outcome !== "string")
        throw new Error("Invalid actual compression outcome shape");
      assertObservedDomain(event.outcome === "decompressed" || event.outcome === "fallback_raw",
        { outcome: event.outcome }, { outcome: ["decompressed", "fallback_raw"] });
      compression.push(event.outcome);
      return false;
    }
    if (!profile.markerIO || event.event !== "marker")
      return true;
    if (typeof event.cutoffMs !== "number" || typeof event.ttlMs !== "number")
      throw new Error("Invalid actual marker observation");
    markers.push({ cutoffMs: event.cutoffMs, ttlMs: event.ttlMs });
    return false;
  });
  if (events === undefined)
    throw new Error("Missing actual marker observations");
  const { events: _events, ...base } = observed;
  return { ...projectBaseObservation(profile, profile.readIO || profile.diagnosticAge !== undefined ? { ...base, events } : base),
    ...(profile.markerIO ? { markers } : {}), ...(profile.compressionIO ? { compression } : {}) };
}
function policyErrors(raw, context) {
  if (!Array.isArray(raw))
    throw new Error(`${context}: missing policy errors`);
  return raw.map(item => {
    const error = record(item, context);
    if (Object.keys(error).sort().join() !== "errorType,layer" || error.layer !== "noop" || error.errorType !== "config_resolution")
      throw new Error(`${context}: invalid policy error`);
    return { layer: error.layer, errorType: error.errorType };
  });
}
function compressionIO(raw, context) {
  if (!Array.isArray(raw) || raw.some(value => value !== "decompressed" && value !== "fallback_raw"))
    throw new Error(`${context}: invalid compression observations`);
  return raw;
}
function projectBaseObservation(profile, observed) {
  if (profile.readIO) {
    const { events, ...base } = observed;
    if (events === undefined)
      throw new Error("Missing actual read observations");
    const io = { budgets: [], aborted: [], sourceErrors: observed.calls.map(call => {
        if (call.status !== "error" || !call.error.startsWith("source:"))
          return 0;
        if (!/^source:\d+$/.test(call.error))
          throw new Error("Unknown actual source error identity");
        return Number(call.error.slice("source:".length)) + 1;
      }) };
    for (const event of events) {
      if (event.event === "readContext") {
        assert.deepEqual(event.index, io.budgets.length);
        assert.deepEqual(event.aborted, false);
        if (typeof event.timeoutMs !== "number")
          throw new Error("Missing actual read budget");
        io.budgets.push(event.timeoutMs);
      }
      else if (event.event === "readAbort") {
        if (typeof event.index !== "number")
          throw new Error("Missing actual cancellation identity");
        io.aborted.push(event.index);
      }
      else {
        if (typeof event.event !== "string")
          throw new Error("Missing actual read event kind");
        assertObservedDomain(false, { event: event.event }, { event: ["readContext", "readAbort"] });
      }
    }
    return { o: project(base), io };
  }
  if (profile.diagnosticAge === undefined)
    return { o: project(observed) };
  const { events, ...base } = observed;
  if (events === undefined)
    throw new Error("Missing actual diagnostic observations");
  const ages = [];
  const futureOffsets = [];
  let warnings = 0, configErrors = 0;
  const coalesced = [], fallbackErrors = [];
  const outcomes = profile.diagnosticAge === "shadowAge" ? observed.shadow.filter(x => x === "match" || x === "mismatch")
    : observed.recovery.filter(x => x === "served");
  for (const event of events) {
    // This profile selects source failures; other error trails are specified
    // by effects. Maintenance errors deliberately carry another use case.
    if (profile.diagnosticConfigErrors && event.event === "error" && event.error === "config_resolution") {
      assertSubset(event, { cacheNamespace: "urn", useCase: "Behavior", keyType: "id", layer: "remote", inFallback: false });
      configErrors++;
      continue;
    }
    if (event.event === "error" && event.error !== "fallback")
      continue;
    assertSubset(event, { cacheNamespace: "urn", useCase: "Behavior", keyType: "id" });
    if (event.event === "coalesced") {
      if (typeof event.scope !== "string")
        throw new Error("Missing coalescing scope");
      coalesced.push(event.scope);
    }
    else if (event.event === "error") {
      // This projection selects source failures; the effects profile compares
      // the complete cache/read/serializer error trail independently.
      if (event.error === "fallback") {
        assert.deepEqual(event.inFallback, true);
        if (typeof event.layer !== "string")
          throw new Error("Missing source failure layer");
        fallbackErrors.push(event.layer);
      }
    }
    else if (event.event === "futureOffset" && profile.diagnosticFutureOffsets) {
      if (typeof event.layer !== "string")
        throw new Error("Invalid actual future offset layer shape");
      if (typeof event.seconds !== "number")
        throw new Error("Invalid actual future offset shape");
      assert.deepEqual({ layer: event.layer }, { layer: "remote_shadow" });
      assertObservedDomain(Number.isSafeInteger(event.seconds * 1000) && event.seconds > 0,
        { seconds: event.seconds }, { seconds: "positive time in whole milliseconds" });
      futureOffsets.push({ layer: event.layer, offsetMs: event.seconds * 1000 });
    }
    else if (event.event === "mismatchWarning") {
      assert.deepEqual(event.outcome, "mismatch");
      warnings++;
    }
    else {
      assert.deepEqual(event.event, profile.diagnosticAge);
      assert.deepEqual(event.outcome, outcomes[ages.length]);
      if (typeof event.seconds !== "number")
        throw new Error("Missing actual diagnostic age");
      ages.push(event.seconds);
    }
  }
  return { o: project(base), d: { warnings, ages, coalesced, fallbackErrors, ...(profile.diagnosticFutureOffsets ? { futureOffsets } : {}), ...(profile.diagnosticConfigErrors ? { configErrors } : {}) } };
}
export function expectedObservation(step) { return { o: step.expected, ...(step.policyErrors === undefined ? {} : { policyErrors: step.policyErrors }), ...(step.diagnostics === undefined ? {} : { d: step.diagnostics }), ...(step.io === undefined ? {} : { io: step.io }), ...(step.markers === undefined ? {} : { markers: step.markers }), ...(step.compression === undefined ? {} : { compression: step.compression }) }; }
export function featureInput(profile, action, choice, observed, environment) { const binding = profile.actions[action]; if (!binding || (binding.choices ? !binding.choices.includes(choice) : choice !== -1 && choice !== 0))
  throw new Error("Unknown feature action or choice"); return binding.input(choice, observed, environment); }
export function assertFeatureObservation(profile, step, observed) { assert.deepEqual(projectObservation(profile, observed), expectedObservation(step)); }
