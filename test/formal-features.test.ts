import { successValues, profiles, parseTrace, featureInput, assertFeatureObservation, type Trace } from "../formal/replay/features.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BehaviorDriver } from "./formal/behavior-driver.js";
import { itfInteger, record } from "./formal/itf.js";

import { recordWitnesses } from "./formal/coverage-evidence.js";
import { runtimeWitnesses } from "./formal/runtime-witnesses.js";
import { recoveryShadowWitnesses } from "./formal/recovery-shadow-witnesses.js";
import type { Profile } from "./formal/feature-profile.js";
import { recoveryAdmissionWitnesses } from "./formal/recovery-admission-witnesses.js";
import { recoveryReadWitnesses } from "./formal/recovery-read-witnesses.js";
import { runtimeBoundaryWitnesses } from "./formal/runtime-boundary-witnesses.js";
import { localFailureWitnesses } from "./formal/local-failure-witnesses.js";
import { sourceBudgetsWitnesses } from "./formal/source-budgets-witnesses.js";
import { shadowDiagnosticsWitnesses } from "./formal/shadow-diagnostics-witnesses.js";
import { shadowLayersWitnesses } from "./formal/shadow-layers-witnesses.js";

async function replay(profile: Profile, trace: Trace) {
  const driver = new BehaviorDriver(typeof profile.fixture === "function" ? profile.fixture(trace.steps[0]!.choice) : profile.fixture);
  try {
    for (const input of profile.setup) await driver.apply(input);
    for (const [i, step] of trace.steps.entries()) {
      const { action, choice } = step;
      try {
        // Only named actions/choices and actual effect IDs enter the driver.
        // The model observation and its private state cannot control execution.
        if (action !== "init") await driver.apply(featureInput(profile, action, choice, driver.snapshot(), { wallMs: Date.now() }));
        assertFeatureObservation(profile, step, driver.snapshot());
      } catch (cause) {
        throw new Error(`${trace.path} step ${i} action ${action} choice ${choice}\nexpected: ${JSON.stringify({ o: step.expected, d: step.diagnostics, io: step.io })}\nactual: ${JSON.stringify(driver.snapshot())}\nreplay: DIALCACHE_FEATURE_TRACE_FILE=${JSON.stringify(trace.path)} corepack pnpm exec vitest run test/formal-features.test.ts --coverage.enabled=false`, { cause });
      }
    }
  } finally { await driver.dispose(); }
}

// These are reachability checks over replayed observations, not additional
// implementation state. A large corpus must not pass by missing its hard paths.
// Private predictions identify the schedules we sampled. A witness involving
// stored state is counted only when a later public call probes that prediction.
function layersWitnesses(traces: Trace[]): Set<string> {
  const seen = new Set<string>();
  const integer = (v: unknown) => itfInteger(v, "layers witness");
  const list = (v: unknown): number[] => {
    if (!Array.isArray(v)) throw new Error("Missing layers witness list");
    return v.map(integer);
  };
  for (const trace of traces) {
    const raw: unknown = JSON.parse(readFileSync(trace.path, "utf8"));
    const states = record(raw, trace.path).states;
    if (!Array.isArray(states)) throw new Error("Missing layers states");
    const predictions = states.map(step => record(record(step, trace.path).s, trace.path));
    const mode = trace.steps[0]!.choice;
    seen.add(`fixture:${mode}`);
    const calls: Array<{ context: number; identity: number }> = [];
    const evicted = new Set<number>();
    const promoted = new Set<number>();
    const preserved = new Set<number>();
    const published = new Set<number>();
    const validated = new Set<number>();
    const invalidated = new Set<number>();
    const fenced = new Map<number, Set<number>>();
    const survivingOther = new Set<number>();
    for (const [i, step] of trace.steps.entries()) {
      seen.add(`action:${step.action}`);
      const previous = trace.steps[i - 1]?.expected;
      if (previous === undefined) continue;
      const o = step.expected;
      const before = predictions[i - 1]!;
      const after = predictions[i]!;
      const ordersBefore = (before.lru as unknown[]).map(list);
      const ordersAfter = (after.lru as unknown[]).map(list);
      if (step.action === "invalidate") { invalidated.add(step.choice); fenced.set(step.choice, new Set()); }
      if (step.action === "beginCall") {
        const context = Math.floor(step.choice / 4), identity = step.choice % 4;
        const instance = context === 2 || context === 4 ? 1 : 0;
        const key = instance * 4 + identity;
        const policy = integer(before.policy);
        const returned = o.calls.at(-1)! > 0;
        const starts = o.loaders > previous.loaders;
        const read = o.reads > previous.reads;
        const remoteHit = o.loads > previous.loads;
        const localHit = context >= 3 && returned && !read && !starts && [0, 1, 3].includes(policy);
        if (!starts && !returned && calls.some((call, j) => previous.calls[j] === 0 && call.identity === identity
          && [0, 1].includes(call.context) && [0, 1].includes(context) && call.context !== context)
          && !calls.some((call, j) => previous.calls[j] === 0 && call.identity === identity && call.context === context)) seen.add("request-misses-share-process-flight");
        if (mode >= 2 && mode <= 3 && context >= 3 && !starts && !returned && [0, 1, 2, 3].includes(policy)) seen.add("zero-capacity-still-shares");
        if (mode >= 2 && mode <= 3 && context >= 3 && policy === 3 && starts
          && calls.some((call, j) => call.identity === identity && previous.calls[j]! > 0)) seen.add("zero-capacity-reloads");
        if (mode >= 2 && mode <= 3 && context < 3 && policy === 4 && returned && !starts
          && list(before.memo).slice(context * 4, context * 4 + 4).filter(v => v > 0).length > 2) seen.add("request-memo-exceeds-local-capacity");
        if (localHit) {
          if (mode === 4) {
            seen.add("absent-remote-preserves-local-reuse");
            if (previous.maintenance.includes("missing_remote")) seen.add("absent-remote-maintenance-preserves-local");
          }
          if (ordersBefore[instance]!.length === 2 && ordersBefore[instance]![0] === identity) { seen.add("lru-read-promotes"); promoted.add(key); }
          if (preserved.has(key)) seen.add("promoted-value-survives-eviction");
          if (survivingOther.has(key)) seen.add("capacity-is-per-instance");
          if (validated.has(key)) seen.add("validated-tracked-hit-warms-local");
          if (mode % 2 === 1 && invalidated.has(Math.floor(identity / 2))) seen.add("invalidation-preserves-local-hit");
        }
        if (context >= 3 && policy === 3 && starts && evicted.has(key)) seen.add("lru-eviction-probed");
        if (remoteHit && mode % 2 === 1) {
          validated.add(key);
          if (published.has(key)) seen.add("tracked-refill-needs-remote-validation");
        }
        const entity = Math.floor(identity / 2);
        const fencedBytes = list(before.remoteValues)[identity]! > 0 && list(before.created)[identity]! <= list(before.watermark)[entity]!;
        if (fencedBytes && read && mode % 2 === 0 && remoteHit) seen.add("untracked-ignores-watermark");
        if (fencedBytes && read && mode % 2 === 1 && starts) {
          const variants = fenced.get(entity);
          variants?.add(identity);
          if (variants?.size === 2) seen.add("invalidation-fences-both-operations");
        }
        if (remoteHit) { survivingOther.delete(key); promoted.delete(key); preserved.delete(key); }
        for (const pending of published) if (Math.floor(pending / 4) === instance) published.delete(pending);
        calls.push({ context, identity });
      }
      if (step.action === "resolveLoader") {
        const source = record((before.sources as unknown[])[Math.floor((step.choice - 1) / 2)], trace.path);
        const key = integer(source.instance) * 4 + integer(source.key);
        if (source.local === true) { survivingOther.delete(key); promoted.delete(key); preserved.delete(key); validated.delete(key); }
        for (const pending of published) if (Math.floor(pending / 4) === integer(source.instance)) published.delete(pending);
      }
      if (step.action === "resolveLoader" && mode % 2 === 1 && o.writes > previous.writes) {
        const source = record((before.sources as unknown[])[Math.floor((step.choice - 1) / 2)], trace.path);
        const key = integer(source.instance) * 4 + integer(source.key);
        if (list(before.localValues)[key] === 0) published.add(key);
      }
      for (const instance of [0, 1]) {
        for (const key of ordersBefore[instance]!) if (!ordersAfter[instance]!.includes(key)) {
          evicted.add(instance * 4 + key); promoted.delete(instance * 4 + key); preserved.delete(instance * 4 + key); validated.delete(instance * 4 + key);
          for (const other of ordersBefore[1 - instance]!) survivingOther.add((1 - instance) * 4 + other);
          for (const kept of ordersAfter[instance]!) if (promoted.has(instance * 4 + kept)) preserved.add(instance * 4 + kept);
        }
        for (const key of ordersAfter[instance]!) evicted.delete(instance * 4 + key);
      }
    }
  }
  return seen;
}

function admissionWitnesses(traces: Trace[]): Set<string> {
  const seen = new Set<string>();
  type Flight = { identity: number; selected: boolean; callers: number[] };
  type Job = { identity: number; phase: "source" | "decode" | "confirmation"; deadline: number; timedOut: boolean };
  type Effect = { flight: Flight } | { job: number };
  for (const trace of traces) {
    let now = 0;
    let overlay = 0;
    const registered = new Map<number, Flight>();
    const jobs = new Map<number, Job>();
    const reads = new Map<number, Effect>();
    const loads = new Map<number, Effect>();
    const released = new Set<number>();
    const instance = (identity: number) => Math.floor(identity / 3);
    const finish = (index: number) => {
      const job = jobs.get(index)!;
      if (job.timedOut) released.add(job.identity);
      jobs.delete(index);
    };
    for (const [i, step] of trace.steps.entries()) {
      seen.add(`action:${step.action}`);
      const o = step.expected;
      const previous = trace.steps[i - 1]?.expected;
      if (previous === undefined) continue;
      for (const outcome of o.shadow) seen.add(`outcome:${outcome}`);
      if (step.action === "policy") overlay = step.choice;
      if (step.action === "advance") {
        now += step.choice;
        for (const job of jobs.values()) if (now >= job.deadline) job.timedOut = true;
      }
      if (step.action === "beginCall") {
        if (o.reads > previous.reads) {
          const flight = { identity: step.choice, selected: overlay % 2 === 0, callers: [o.calls.length - 1] };
          if (overlay >= 2 && registered.has(step.choice)) seen.add("uncoalesced-hit-overlap");
          if (overlay < 2) registered.set(step.choice, flight);
          reads.set(o.reads - 1, { flight });
        } else {
          const flight = registered.get(step.choice);
          if (flight === undefined) throw new Error(`${trace.path}: no observed read for follower`);
          flight.callers.push(o.calls.length - 1);
        }
      }
      if (step.action === "releaseRead") {
        const effect = reads.get(step.choice);
        if (effect === undefined) throw new Error(`${trace.path}: unknown read ${step.choice}`);
        if ("flight" in effect) loads.set(o.loads - 1, effect);
        else finish(effect.job);
        reads.delete(step.choice);
      }
      if (step.action === "releaseLoad") {
        const effect = loads.get(step.choice);
        if (effect === undefined) throw new Error(`${trace.path}: unknown load ${step.choice}`);
        if ("flight" in effect) {
          const flight = effect.flight;
          const active = [...jobs.values()].filter((job) => instance(job.identity) === instance(flight.identity));
          const duplicate = active.find((job) => job.identity === flight.identity);
          if (o.loaders > previous.loaders) {
            if (flight.callers.length > 1) seen.add("coalesced-hit-one-job");
            if (overlay % 2 === 1) seen.add("accepted-shadow-policy");
            if ([...jobs.values()].filter((job) => instance(job.identity) !== instance(flight.identity)).length === 2) seen.add("other-instance-full-admission");
            if ([...jobs.values()].some((job) => job.identity % 3 === flight.identity % 3)) seen.add("per-instance-deduplication");
            if (released.has(flight.identity)) seen.add("readmission-after-timeout-drains");
            jobs.set(o.loaders - 1, { identity: flight.identity, phase: "source", deadline: now + 10, timedOut: false });
          } else if (o.shadow.length > previous.shadow.length) {
            if (duplicate && active.length < 2) seen.add("duplicate-with-free-capacity");
            if (!duplicate && active.length === 2) seen.add("full-capacity-drop");
            // An expired job must be a cause of this drop, not merely coexist
            // with a different live duplicate that would already block it.
            for (const job of duplicate ? [duplicate] : active.length === 2 ? active : []) {
              if (job.timedOut) seen.add(`${job.phase}-timeout-keeps-slot`);
            }
          } else if (!flight.selected) seen.add("unselected-hit-skips-job");
          if (registered.get(flight.identity) === flight) registered.delete(flight.identity);
        } else if (o.reads > previous.reads) {
          jobs.get(effect.job)!.phase = "confirmation";
          reads.set(o.reads - 1, { job: effect.job });
        } else finish(effect.job);
        loads.delete(step.choice);
      }
      if (step.action === "resolveLoader" || step.action === "rejectLoader") {
        const loader = step.action === "resolveLoader" ? Math.floor((step.choice - 1) / 2) : step.choice;
        if (o.loads > previous.loads) {
          jobs.get(loader)!.phase = "decode";
          loads.set(o.loads - 1, { job: loader });
        } else finish(loader);
      }
    }
  }
  return seen;
}

function scopeWitnesses(traces: Trace[]): Set<string> {
  const seen = new Set<string>();
  for (const trace of traces) {
    const closed = new Set<number>();
    const rejected = new Set<number>();
    const published = new Map<number, { value: number; scope: number }>();
    const bypassed = new Map<number, number>();
    const sources = new Map<number, { scope: number; memoizing: boolean; shared: boolean }>();
    const scopes: number[] = [];
    let lateOuterSource = false;
    let valueBeforeNestedClose: number | undefined;
    let policyCall = -1;
    let overlay = 0;
    const holder = (scope: number) => scope === 1 ? 1 : 0;
    for (const [i, step] of trace.steps.entries()) {
      seen.add(`action:${step.action}`);
      const o = step.expected;
      const previous = trace.steps[i - 1]?.expected;
      if (previous === undefined) continue;
      for (const layer of step.diagnostics!.fallbackErrors) seen.add(`failure-layer:${layer}`);
      if (step.action === "rejectLoader") {
        const failures = o.calls.filter((value, j) => value === 3 && previous.calls[j] === 0).length;
        const added = step.diagnostics!.fallbackErrors.length - trace.steps[i - 1]!.diagnostics!.fallbackErrors.length;
        if (failures > 1 && added === 1) seen.add("one-error-for-request-followers");
        if (failures === 1 && added === 0) seen.add("pass-through-error-has-no-cache-trail");
      }
      if (step.action === "policy") overlay = step.choice;
      if (step.action === "closeScope") {
        closed.add(step.choice);
        if (step.choice === 2) valueBeforeNestedClose = published.get(0)?.value;
        if (step.choice < 2) { published.delete(step.choice); bypassed.delete(step.choice); }
      }
      if (step.action === "beginCall") {
        const scope = step.choice;
        scopes.push(scope);
        if (o.policyCalls > previous.policyCalls) policyCall = scopes.length - 1;
        else if (o.loaders > previous.loaders) {
          sources.set(o.loaders - 1, { scope, memoizing: false, shared: false });
          if (scope === 3) seen.add("disabled-bypass");
          if (scope < 5 && closed.has(holder(scope))) seen.add("detached-bypass");
        }
      }
      if (step.action === "releasePolicy") {
        const scope = scopes[policyCall]!;
        const lifetime = holder(scope);
        if (o.loaders > previous.loaders) {
          const active = o.sourceScopes.at(-1)!;
          const memoizing = active && overlay !== 1;
          if (!active) seen.add("policy-reply-after-close");
          if (memoizing) {
            if (overlay === 0 && rejected.has(lifetime)) seen.add("rejected-flight-retry");
            if (scope === 1 && lateOuterSource) seen.add("replacement-miss-after-late-source");
            for (const source of sources.values()) {
              if (!source.memoizing || closed.has(holder(source.scope))) continue;
              if (holder(source.scope) !== lifetime) seen.add("independent-scope-overlap");
              else if (overlay === 2) seen.add("uncoalesced-scope-overlap");
            }
          }
          if (active && overlay === 1 && published.has(lifetime)) bypassed.set(lifetime, published.get(lifetime)!.value);
          sources.set(o.loaders - 1, { scope, memoizing, shared: memoizing && overlay === 0 });
        } else if (o.calls[policyCall] !== 0) {
          seen.add("memo-hit");
          seen.add(`memo-value:${o.calls[policyCall]}`);
          if (published.get(lifetime)?.scope !== scope) {
            if (scope === 2) seen.add("nested-memo-hit");
            if (scope === 4) seen.add("reenabled-memo-hit");
          }
          if (lifetime === 0 && valueBeforeNestedClose === o.calls[policyCall]) seen.add("memo-after-nested-close");
          if (bypassed.get(lifetime) === o.calls[policyCall]) seen.add("memo-after-policy-bypass");
        }
        policyCall = -1;
      }
      if (step.action === "resolveLoader" || step.action === "rejectLoader") {
        const loader = step.action === "resolveLoader" ? Math.floor((step.choice - 1) / successValues.length) : step.choice;
        const source = sources.get(loader);
        if (source === undefined) throw new Error(`${trace.path}: missing source ${loader}`);
        const completed = o.calls.filter((value, index) => value !== 0 && previous.calls[index] === 0);
        const lifetime = holder(source.scope);
        if (step.action === "rejectLoader") {
          if (source.shared) rejected.add(lifetime);
          if (completed.length > 1) seen.add("shared-rejection");
        } else if (source.memoizing) {
          if (closed.has(lifetime)) {
            seen.add("source-settles-after-close");
            if (lifetime === 0) lateOuterSource = true;
          } else {
            published.set(lifetime, { value: completed[0]!, scope: source.scope });
            if (lifetime === 0) valueBeforeNestedClose = undefined;
            bypassed.delete(lifetime);
          }
        }
        sources.delete(loader);
      }
    }
  }
  return seen;
}

// Private clock/cache predictions classify only schedules subsequently probed
// by real replay. They never enter driver inputs or implementation projection.
function clockWitnesses(name: "policy" | "recovery", traces: Trace[]): Set<string> {
  const seen = new Set<string>();
  for (const trace of traces) {
    const states = (JSON.parse(readFileSync(trace.path, "utf8")).states as unknown[]).map(state => record(record(state, trace.path).s, trace.path));
    let rolledLocal: { key: number; expires: number } | undefined;
    let hitBeforeExpiry: { key: number; value: number; expires: number; at: number } | undefined;
    let rolled = false;
    const integer = (value: unknown) => itfInteger(value, trace.path);
    for (const [i, step] of trace.steps.entries()) {
      if (i === 0) continue;
      const before = states[i - 1]!;
      const previous = trace.steps[i - 1]!.expected;
      const o = step.expected;
      if (step.action === "rollbackWall") {
        rolled = true;
        if (name === "policy" && integer(before.localValue) > 0) rolledLocal = { key: integer(before.localKey), expires: integer(before.localExpires) };
      }
      if (name === "policy" && step.action === "releasePolicy") {
        const key = integer(before.key), overlay = integer(before.overlay), base = overlay < 20 ? overlay % 10 : 0;
        const local = before.providerFailed === false && ![20, 21].includes(overlay) && ![3, 5, 8].includes(base);
        const now = integer(before.now), expires = integer(before.localExpires), value = integer(before.localValue);
        const sameEntry = local && integer(before.localKey) === key && value > 0;
        // The probe occurs after the original expiry but before even the shortest
        // permitted TTL could expire if the preceding read had renewed it.
        if (sameEntry && hitBeforeExpiry?.key === key && hitBeforeExpiry.value === value &&
          hitBeforeExpiry.expires === expires && now >= expires && now < hitBeforeExpiry.at + 1000 &&
          (o.reads > previous.reads || o.loaders > previous.loaders)) seen.add("local-hit-preserves-insertion-expiry");
        if (sameEntry && now < expires && o.calls[integer(before.policyCall)]! > 0 &&
          o.reads === previous.reads && o.loaders === previous.loaders) hitBeforeExpiry = { key, value, expires, at: now };
        if (local && rolledLocal?.key === key && integer(before.localKey) === key && integer(before.localExpires) === rolledLocal.expires) {
          const result = o.calls[integer(before.policyCall)]!;
          if (integer(before.now) < rolledLocal.expires && result > 0 && o.reads === previous.reads && o.loaders === previous.loaders) seen.add("rollback-preserves-live-local");
          if (integer(before.now) >= rolledLocal.expires && (o.reads > previous.reads || o.loaders > previous.loaders)) seen.add("rollback-does-not-extend-local-ttl");
        }
        if (rolled && before.readFailed === false && integer((before.remoteValues as unknown[])[key]) > 0 &&
          integer(before.now) < integer((before.remoteExpires as unknown[])[key]) && integer((before.remoteCreated as unknown[])[key]) > integer(before.wall) &&
          o.reads > previous.reads && o.loads === previous.loads && o.loaders > previous.loaders) seen.add("rollback-rejects-future-remote");
      }
      if (name === "recovery" && step.action === "releaseLoad" && integer(before.phase) === 3 && before.loadFailed === false &&
        integer(before.wall) < integer(before.candidateCreated) && o.recovery.length > previous.recovery.length && o.recovery.at(-1) === "miss") seen.add("rollback-rejects-retained-future");
    }
  }
  return seen;
}

function policyWitnesses(traces: Trace[]): Set<string> {
  const seen = clockWitnesses("policy", traces);
  for (const trace of traces) {
    let policyEpoch = 0;
    let overlay = 0;
    let providerFailed = false;
    let pendingPolicy = -1;
    const keys: number[] = [];
    const sources = new Map<number, { key: number; epoch: number; overlay: number }>();
    for (const [i, step] of trace.steps.entries()) {
      seen.add(`action:${step.action}`);
      const o = step.expected;
      const previous = trace.steps[i - 1]?.expected;
      if (previous === undefined) continue;
      if (step.action === "beginCall") {
        keys.push(step.choice);
        pendingPolicy = o.calls.length - 1;
      }
      if (step.action === "policy") {
        if (overlay !== step.choice) policyEpoch++;
        overlay = step.choice;
      }
      if (step.action === "providerFault") providerFailed = step.choice === 1;
      if (step.action === "releasePolicy") {
        const key = keys[pendingPolicy]!;
        if (!providerFailed) {
          if (overlay === 20 && o.loaders > previous.loaders && o.reads === previous.reads) seen.add("invalid-read-budget-bypasses-caching");
          if (overlay === 21 && o.reads > previous.reads) seen.add("invalid-local-ramp-preserves-remote");
          if (overlay === 22 && o.calls[pendingPolicy]! > 0 && o.reads === previous.reads && o.loaders === previous.loaders) seen.add("invalid-remote-ramp-preserves-local");
          if (overlay === 25 && o.loads > previous.loads && o.loaders === previous.loaders) seen.add("invalid-shadow-preserves-serving");
        }
        if (o.loaders > previous.loaders) {
          for (const source of sources.values()) {
            if (source.key !== key) seen.add("cross-key-overlap");
            else if (overlay >= 10 && overlay < 20 && !providerFailed) seen.add("uncoalesced-same-key-overlap");
          }
          sources.set(o.loaders - 1, { key, epoch: policyEpoch, overlay });
        } else if (o.calls[pendingPolicy] === 0) {
          if ([...sources.values()].some((source) => source.key === key && source.epoch < policyEpoch)) {
            seen.add("join-after-policy-change");
          }
        } else {
          if (o.loads > previous.loads) { seen.add("remote-hit"); seen.add(`remote-value:${o.calls[pendingPolicy]}`); }
          if (o.reads === previous.reads) { seen.add("local-hit"); seen.add(`local-value:${o.calls[pendingPolicy]}`); }
        }
        pendingPolicy = -1;
      }
      if (step.action === "resolveLoader" || step.action === "rejectLoader") {
        const loader = step.action === "resolveLoader" ? Math.floor((step.choice - 1) / successValues.length) : step.choice;
        const source = sources.get(loader);
        if (source === undefined) throw new Error(`${trace.path}: missing accepted source ${loader}`);
        if ([...sources.keys()].some((pending) => pending < loader)) seen.add("reverse-source-settlement");
        if (previous.calls.filter((c, index) => c === 0 && o.calls[index] !== 0).length > 1) seen.add("coalesced-result");
        if (o.writes > previous.writes) {
          if ([23, 24].includes(source.overlay) && o.writeTtls.at(-1) === 1000) seen.add(`invalid-recovery-retention:${source.overlay}`);
          if (source.epoch < policyEpoch) seen.add("publication-after-policy-change");
          if (pendingPolicy >= 0 && o.calls[pendingPolicy] === 0) seen.add("publication-during-policy-fetch");
        }
        sources.delete(loader);
      }
      for (const ttl of o.writeTtls) seen.add(`ttl:${ttl}`);
    }
  }
  return seen;
}

function recoveryScopeWitnesses(traces: Trace[]): Set<string> {
  const seen = new Set<string>();
  for (const trace of traces) {
    const states = (JSON.parse(readFileSync(trace.path, "utf8")).states as unknown[]).map(state => record(record(state, trace.path).s, trace.path));
    const memo = new Map<number, { value: number; group: number }>();
    const probes = new Map<number, Set<number>>();
    let closedDuringDecode = false, probeAfterClosedRecovery = false;
    const integer = (value: unknown) => itfInteger(value, trace.path);
    for (const [i, step] of trace.steps.entries()) {
      if (i === 0 || trace.steps[0]!.choice < 4) continue;
      const before = states[i - 1]!, after = states[i]!;
      const previous = trace.steps[i - 1]!.expected, o = step.expected;
      if (step.action === "closeScope") {
        memo.delete(step.choice);
        if (integer(before.phase) === 3 && (before.attached as boolean[])[step.choice]) closedDuringDecode = true;
      }
      if (step.action === "releaseLoad" && o.recovery.length > previous.recovery.length && o.recovery.at(-1) === "served") {
        const group = o.recovery.length;
        for (const scope of [0, 1]) if ((before.attached as boolean[])[scope] && !(before.closed as boolean[])[scope]) {
          memo.set(scope, { value: integer((after.memo as unknown[])[scope]), group });
        }
        if (closedDuringDecode) probeAfterClosedRecovery = true;
        closedDuringDecode = false;
      } else if (step.action === "releaseLoad" || (step.action === "resolveLoader" && o.calls.some((v, j) => v > 0 && previous.calls[j] === 0))) {
        for (const scope of [0, 1]) if ((before.attached as boolean[])[scope]) memo.delete(scope);
      }
      if (step.action === "releaseLoad") closedDuringDecode = false;
      if (step.action === "beginCall" || step.action === "joinCall") {
        const scope = step.action === "beginCall" ? Math.floor(step.choice / 4) : step.choice;
        const recovered = memo.get(scope);
        if (recovered !== undefined && o.calls.at(-1) === recovered.value && o.reads === previous.reads && o.loaders === previous.loaders) {
          seen.add("recovered-value-request-hit");
          const groupProbes = probes.get(recovered.group) ?? new Set<number>();
          groupProbes.add(scope); probes.set(recovered.group, groupProbes);
          if (groupProbes.size === 2) seen.add("recovery-memoizes-both-requests");
        }
        if (probeAfterClosedRecovery && o.reads > previous.reads) { seen.add("closed-recovery-does-not-memoize-another-scope"); probeAfterClosedRecovery = false; }
      }
      if (step.action === "joinCall" && step.diagnostics!.coalesced.length > trace.steps[i - 1]!.diagnostics!.coalesced.length && step.diagnostics!.coalesced.at(-1) === "request_local") seen.add("request-follower-shares-recovery-flight");
    }
  }
  return seen;
}

function independentWitnesses(traces: Trace[]): Set<string> {
  const seen = new Set<string>();
  for (const trace of traces) {
    const states = (JSON.parse(readFileSync(trace.path, "utf8")).states as Array<{ s: Record<string, unknown> }>).map(x => x.s);
    const integer = (v: unknown) => itfInteger(v, trace.path);
    const records = (v: unknown) => v as Record<string, unknown>[];
    const recovered = new Map<number, number>();
    for (const [i, step] of trace.steps.entries()) {
      seen.add(`action:${step.action}`);
      if (i === 0) continue;
      const before = states[i - 1]!, previous = trace.steps[i - 1]!.expected, o = step.expected;
      if (step.action === "beginCall" && records(states[i]!.reads).filter(r => r.active === true).length > 1) seen.add("independent-read-overlap");
      if (new Set(step.io!.sourceErrors.filter(id => id > 0)).size >= 2) seen.add("independent-source-error-identities");
      if (step.io!.budgets.includes(5) && step.io!.budgets.includes(10)) seen.add("independent-read-budgets");
      if (step.io!.aborted.length > trace.steps[i - 1]!.io!.aborted.length && o.calls.includes(0) &&
        records(states[i]!.reads).some(r => r.active === true)) seen.add("one-read-times-out-before-another");
      if ((step.action === "releaseRead" || step.action === "failRead") && records(before.reads)[step.choice]!.active === false &&
        previous.calls.includes(0) && JSON.stringify(o) === JSON.stringify(previous)) seen.add("late-read-does-not-affect-other-call");
      if (step.action === "releaseLoad" || step.action === "failLoad") {
        const load = records(before.loads)[step.choice]!, caller = integer(load.caller), call = records(before.calls)[caller]!;
        if (load.recovery === true && step.action === "failLoad" && o.calls[caller] === 3 && step.io!.sourceErrors[caller] === integer(call.source) + 1) {
          seen.add("failed-recovery-keeps-source-error");
        }
        if (load.recovery === true && o.calls[caller] === integer(load.value)) {
          recovered.set(caller, o.calls[caller]!);
          if (new Set(recovered.values()).size === 2) seen.add("distinct-retained-recovery-values");
          if (integer(before.watermark) >= integer(call.created)) seen.add("acquired-recovery-survives-invalidation");
        }
        if (load.recovery === false && step.action === "releaseLoad" && integer(before.watermark) >= integer(call.acquiredAt)) seen.add("acquired-fresh-decode-survives-invalidation");
        if (load.recovery === true && o.recovery.at(-1) === "miss" && records(before.calls).some(c => integer(c.maxAge) !== integer(call.maxAge) && integer(c.phase) !== 5)) seen.add("independent-recovery-age-boundary");
      }
      if (step.action === "resolveLoader" || step.action === "rejectLoader") {
        const source = records(before.sources)[step.action === "rejectLoader" ? step.choice : Math.floor((step.choice - 1) / 2)]!;
        if (source.active === false && previous.calls.includes(0) && JSON.stringify(o) === JSON.stringify(previous)) seen.add("late-source-does-not-affect-other-call");
        if (o.writes > previous.writes && records(before.calls).some(c => integer(c.phase) === 2 && c.canWrite === false)) seen.add("refill-authority-is-per-call");
      }
      for (const outcome of o.recovery) seen.add(`recovery:${outcome}`);
      if (o.calls.includes(4)) seen.add("source-deadline");
    }
  }
  return seen;
}
function witnesses(name: string, traces: Trace[]): Set<string> {
  if (["recovery-read", "shadow-layers", "local-failure", "source-budgets"].includes(name)) {
    const paths = traces.map(trace => trace.path);
    return new Set([...traces.flatMap(trace => trace.steps.map(step => `action:${step.action}`)),
      ...(name === "recovery-read" ? recoveryReadWitnesses(paths) : name === "shadow-layers" ? shadowLayersWitnesses(paths) : name === "local-failure" ? localFailureWitnesses(paths) : sourceBudgetsWitnesses(paths))]);
  }
  if (name === "independent") return independentWitnesses(traces);
  if (name === "layers") return layersWitnesses(traces);
  if (name === "admission") return admissionWitnesses(traces);
  if (name === "scope") return scopeWitnesses(traces);
  if (name === "policy") return policyWitnesses(traces);
  const seen = name === "recovery" ? new Set([...clockWitnesses("recovery", traces), ...recoveryScopeWitnesses(traces)]) : new Set<string>();
  for (const trace of traces) {
    let invalidatedDuringFlight = false;
    let advancedDuringDecode = false;
    let decoding = false;
    let c0Released = false;
    let shadowTimedOut = false;
    if (name === "recovery" || name === "shadow") seen.add(`fixture:${trace.steps[0]!.choice}`);
    let logging = trace.steps[0]!.choice >= 4 && trace.steps[0]!.choice < 8;
    const defaultLogging = logging;
    let sawShadowPolicy = false, acceptedDefaultLogging = false;
    let shadowPolicy = 0, jobAdmitted = false, changedAdmittedJob = false;
    let acceptedLogging = false;
    let acceptedInvalidLogging = false;
    let invalidLoggingReportedAtAdmission = false;
    // Model-private values classify reached comparison schedules only; replay
    // above has already compared public callbacks/results independently.
    const shadowStates = name === "shadow" ? (JSON.parse(readFileSync(trace.path, "utf8")).states as unknown[])
      .map(state => record(record(state, trace.path).s, trace.path)) : [];
    let wallRolledAfterC0 = false;
    let classifier = -1;
    let operationClassifier = -1;
    let recoveryCause = "";
    let recoveryErrorCount = 0;
    const abandoned = new Set<number>();
    let currentSource = -1;
    for (const [i, step] of trace.steps.entries()) {
      seen.add(`action:${step.action}`);
      const o = step.expected;
      const previous = trace.steps[i - 1]?.expected;
      if (previous === undefined) continue;
      for (const outcome of o.recovery.concat(o.shadow)) seen.add(`outcome:${outcome}`);
      if (step.action === "beginCall") {
        invalidatedDuringFlight = false; advancedDuringDecode = false; decoding = false;
        c0Released = false; shadowTimedOut = false;
      }
      if (name === "recovery") {
        if (step.action === "beginCall") { operationClassifier = step.choice % 4; recoveryErrorCount = step.diagnostics!.fallbackErrors.length; }
        if (step.action === "beginCall") classifier = step.choice % 4 === 3 ? [3, 0, 1, 2][trace.steps[0]!.choice % 4]! : step.choice % 4;
        if (o.loaders > previous.loaders) {
          if (abandoned.size > 0) seen.add("recovery-abandoned-overlap");
          currentSource = o.loaders - 1; decoding = false;
        }
        const rejected = step.action === "rejectLoader" || step.action === "rejectTimeout";
        if (step.action === "advance" && currentSource >= 0 && !decoding &&
          (o.loads > previous.loads || o.recovery.length > previous.recovery.length || o.calls.some((c, i) => c === 4 && previous.calls[i] === 0))) {
          abandoned.add(currentSource);
          recoveryCause = "deadline";
          if (classifier === 1 && o.calls.includes(4)) {
            if (operationClassifier === 1) seen.add("explicit-denial-overrides-timeout");
            if (operationClassifier === 3 && trace.steps[0]!.choice % 4 === 2) seen.add("instance-denial-overrides-timeout-default");
          }
        }
        if (rejected && !abandoned.has(step.choice)) {
          const instance = trace.steps[0]!.choice % 4;
          if (instance === 1 && operationClassifier === 1 && o.calls.some((c, j) => c === 3 && previous.calls[j] === 0)) seen.add("operation-denial-overrides-instance-allow");
          if (instance === 3 && operationClassifier === 3 && o.calls.some((c, j) => c === 3 && previous.calls[j] === 0)) seen.add("instance-classifier-error-preserves-source");
          recoveryCause = step.action === "rejectTimeout" ? "propagated-timeout" : "source-error";
          if (classifier === 3 && step.action === "rejectLoader" && o.calls.includes(3) && o.loads === previous.loads) seen.add("default-denies-ordinary-error");
        }
        if ((rejected || step.action === "resolveLoader") && abandoned.has(step.choice)) {
          seen.add("recovery-late-source-settles"); abandoned.delete(step.choice);
        }
        if (o.loads > previous.loads && step.action !== "beginCall") decoding = true;
        if (o.recovery.length > previous.recovery.length && o.recovery.at(-1) === "served") {
          if (step.diagnostics!.fallbackErrors.length === recoveryErrorCount + 1 && step.diagnostics!.fallbackErrors.at(-1) === "remote") seen.add("recovery-keeps-source-failure-trail");
          if (trace.steps[0]!.choice % 4 === 1 && operationClassifier === 3 && recoveryCause === "source-error") seen.add("instance-allow-recovers-ordinary-error");
          if (trace.steps[0]!.choice % 4 === 2 && operationClassifier === 0) seen.add("operation-allow-overrides-instance-denial");
        }
        if (o.recovery.length > previous.recovery.length && o.recovery.at(-1) === "served" && classifier === 3) {
          seen.add(`default-recovers-${recoveryCause}`);
        }
        if (step.action === "releaseLoad" && o.recovery.at(-1) === "deserialization_error" && o.calls.some((c, i) => c === 4 && previous.calls[i] === 0)) seen.add("recovery-failure-preserves-timeout");
        if (step.action === "invalidate" && o.calls.includes(0)) invalidatedDuringFlight = true;
        if (step.action === "rejectLoader" && o.loads > previous.loads) decoding = true;
        if (step.action === "advance" && decoding) advancedDuringDecode = true;
        if (o.recovery.length > previous.recovery.length) {
          const outcome = o.recovery.at(-1);
          if (outcome === "served" && invalidatedDuringFlight) seen.add("retained-across-invalidation");
          if (outcome === "served" && previous.calls.filter((c) => c === 0).length > 1) seen.add("coalesced-recovery");
          if (outcome === "miss" && step.action === "releaseLoad" && advancedDuringDecode) seen.add("expired-during-decode");
        }
      }
      if (name === "shadow") {
        if (step.action === "beginCall") {
          acceptedLogging = logging; wallRolledAfterC0 = false;
          acceptedInvalidLogging = shadowStates[i - 1]!.invalidLog === true;
          invalidLoggingReportedAtAdmission = step.diagnostics!.configErrors === trace.steps[i - 1]!.diagnostics!.configErrors! + 1;
          acceptedDefaultLogging = !defaultLogging && !sawShadowPolicy;
          jobAdmitted = o.reads > previous.reads; changedAdmittedJob = false;
          if (trace.steps[0]!.choice === 11 && jobAdmitted && o.calls.at(-1) === 0 && o.shadow.length === previous.shadow.length) {
            seen.add("source-work-before-deadline-dispatches-read");
          }
          if (trace.steps[0]!.choice === 12 && o.reads === previous.reads && o.calls.at(-1) === 0 &&
            o.shadow.length === previous.shadow.length + 1 && o.shadow.at(-1) === "timeout" &&
            step.diagnostics!.fallbackErrors.length === trace.steps[i - 1]!.diagnostics!.fallbackErrors.length) {
            seen.add("source-work-exhausts-deferred-job");
          }
          if (!jobAdmitted && o.loaders > previous.loaders) {
            if (trace.steps[0]!.choice === 8) seen.add("missing-hook-skips-job");
            else if (shadowPolicy > 0) seen.add(`shadow-policy-skips-job:${shadowPolicy}`);
          }
        }
        if (step.action === "logPolicy" || step.action === "shadowPolicy") sawShadowPolicy = true;
        if (step.action === "logPolicy") { logging = step.choice === 1; shadowPolicy = 0; }
        if (step.action === "shadowPolicy") {
          shadowPolicy = step.choice; logging = defaultLogging;
          if (jobAdmitted && step.choice > 0) changedAdmittedJob = true;
        }
        if (step.action === "rollbackWall" && c0Released) wallRolledAfterC0 = true;
        if (trace.steps[0]!.choice === 12 && ["resolveLoader", "rejectLoader"].includes(step.action) &&
          previous.calls.at(-1) === 0 && o.calls.at(-1) === 4 && o.reads === previous.reads &&
          o.shadow.length === previous.shadow.length && step.diagnostics!.fallbackErrors.length === trace.steps[i - 1]!.diagnostics!.fallbackErrors.length + 1 &&
          step.diagnostics!.fallbackErrors.at(-1) === "local") {
          seen.add(step.action === "resolveLoader" ? "expired-job-source-resolve-keeps-deadline" : "expired-job-source-reject-keeps-deadline");
        }
        if (o.shadow.length > previous.shadow.length) {
          const outcome = o.shadow.at(-1);
          if (changedAdmittedJob && shadowPolicy > 0 && ["match", "mismatch", "filled"].includes(outcome!)) seen.add("admitted-job-keeps-shadow-policy");
          const c0Payload = itfInteger(shadowStates[i - 1]!.c0, trace.path);
          const frame = itfInteger(shadowStates[i - 1]!.frame, trace.path);
          const decoded = (payload: number) => payload >= 7 ? 3 : [3, 5, 6].includes(payload) ? 1 : payload === 4 ? 2 : payload;
          const c0Value = decoded(c0Payload);
          const binary = (payload: number) => [3, 4, 5, 8].includes(payload);
          if (step.action === "releaseRead" && outcome === "mismatch" && c0Payload >= 7 && frame >= 7 && binary(c0Payload) !== binary(frame)) {
            seen.add(binary(c0Payload) ? "binary-to-text-confirmation" : "text-to-binary-confirmation");
          }
          if (step.action === "releaseRead" && outcome === "superseded" && frame > 0 && decoded(frame) === c0Value) seen.add("different-bytes-same-value-superseded");
          if (step.action === "releaseLoad" && outcome === "match" && binary(c0Payload) && trace.steps[0]!.choice % 4 === 0) seen.add("binary-c0-compares-decoded-value");
          if (step.action === "releaseLoad" && outcome === "timeout" && o.comparisons > previous.comparisons) seen.add(`comparison-crosses-deadline:${trace.steps[0]!.choice}`);
          const sourceValue = itfInteger(shadowStates[i - 1]!.sourceValue, trace.path);
          if (outcome === "match" && c0Value !== sourceValue && trace.steps[0]!.choice % 4 === 1) seen.add("custom-equal-overrides-values");
          if (outcome === "mismatch" && c0Value === sourceValue && trace.steps[0]!.choice % 4 === 2) seen.add("custom-unequal-confirms-equal-values");
          if (outcome === "mismatch" && acceptedLogging !== logging) seen.add(`captured-logging:${acceptedLogging}`);
          if (outcome === "mismatch") seen.add(`mismatch-logging:${acceptedLogging}`);
          if (outcome === "mismatch" && acceptedDefaultLogging && step.diagnostics!.warnings === trace.steps[i - 1]!.diagnostics!.warnings) seen.add("omitted-logging-defaults-off");
          if (outcome === "mismatch" && acceptedInvalidLogging && invalidLoggingReportedAtAdmission &&
            step.diagnostics!.warnings === trace.steps[i - 1]!.diagnostics!.warnings) seen.add("invalid-logging-compares-without-warning");
          if (acceptedLogging && step.diagnostics!.warnings === trace.steps[i - 1]!.diagnostics!.warnings) {
            if (outcome === "match") seen.add("enabled-logging-match-has-no-warning");
            if (outcome === "superseded") seen.add("enabled-logging-superseded-has-no-warning");
          }
          if (step.diagnostics!.ages.length > trace.steps[i - 1]!.diagnostics!.ages.length) {
            if (wallRolledAfterC0 && step.diagnostics!.ages.at(-1) === 0) seen.add("age-clamped-after-rollback");
            if (step.diagnostics!.ages.at(-1)! > 0) seen.add("age-at-verdict");
          }
        }
        if (step.action === "releaseRead") {
          c0Released = true;
          if (o.calls.includes(0) && o.shadow.length === previous.shadow.length) seen.add("c0-before-source");
        }
        if (step.action === "resolveLoader" && jobAdmitted && !c0Released && previous.calls.at(-1) === 0 && [1, 2].includes(o.calls.at(-1)!)) seen.add("source-before-c0");
        if (o.shadow.length > previous.shadow.length && o.shadow.at(-1) === "timeout") shadowTimedOut = true;
        if (step.action === "releaseWrite" && shadowTimedOut) seen.add("write-completes-after-timeout");
      }
    }
  }
  return seen;
}
const required = JSON.parse(readFileSync(new URL("../formal/coverage-witnesses.json", import.meta.url), "utf8")) as Record<string, string[]>;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-08T12:00:00Z")); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const single = process.env.DIALCACHE_FEATURE_TRACE_FILE;
const directory = process.env.DIALCACHE_FEATURE_TRACE_DIR;
const selectedProfile = process.env.DIALCACHE_FEATURE_PROFILE;
if (selectedProfile !== undefined && !Object.hasOwn(profiles, selectedProfile)) throw new Error(`Unknown selected feature profile: ${selectedProfile}`);
const execution = JSON.parse(readFileSync(new URL("../formal/execution.json", import.meta.url), "utf8")) as {
  models: Array<{ profile?: string; replayRegressions?: string[] }>;
};
for (const [name, profile] of Object.entries(profiles)) {
  if (selectedProfile !== undefined && selectedProfile !== name) continue;
  const paths = single !== undefined ? (single.includes(`/${name}/`) || single.endsWith(`${name}-smoke.itf.json`) ? [resolve(single)] : [])
    : directory === undefined ? [resolve(`formal/${name}-smoke.itf.json`)]
    : readdirSync(resolve(directory, name)).filter((file) => file.endsWith(".itf.json")).sort().map((file) => resolve(directory, name, file));
  if (directory !== undefined && single === undefined) {
    const regressions = execution.models.find(model => model.profile === name)?.replayRegressions ?? [];
    for (const regression of regressions) paths.push(resolve(directory, "..", "regressions", name, `${regression}.itf.json`));
  }
  if (single === undefined && paths.length === 0) throw new Error(`No ${name} traces found`);
  if (paths.length === 0) continue;
  const traces = paths.map((path) => parseTrace(JSON.parse(readFileSync(path, "utf8")), path, profile));
  describe(`generated ${name} conformance`, () => {
    for (const trace of traces) it(`replays ${trace.path}`, async () => { await replay(profile, trace); });
    if (directory !== undefined && single === undefined) it("reaches every action and required outcome or race", () => {
      const paths = traces.map(trace => trace.path);
      const seen = new Set([...witnesses(name, traces), ...runtimeWitnesses(name, paths), ...runtimeBoundaryWitnesses(name, paths), ...recoveryShadowWitnesses(name, paths), ...(name === "recovery-read" ? recoveryAdmissionWitnesses(paths) : []), ...(name === "shadow" ? shadowDiagnosticsWitnesses(paths) : [])]);
      const wanted = Object.keys(profile.actions).map((action) => `action:${action}`).concat(required[name]!);
      expect(wanted.filter((witness) => !seen.has(witness)), `Missing ${name} coverage witnesses`).toEqual([]);
      recordWitnesses(name, seen, required[name]!, traces);
    }, 30_000);
    if (traces.length > 0) {
      it("rejects missing observations, unknown actions and invalid choices", () => {
        const raw = JSON.parse(readFileSync(traces[0]!.path, "utf8"));
        delete raw.states[0].s.o.reads;
        expect(() => parseTrace(raw, "missing-observation", profile)).toThrow(/observation fields/);
        raw.states[0].s.o.reads = { "#bigint": "0" };
        if (profile.explicitInputs) raw.states[1].input.name = "unknown";
        else raw.states[1]["mbt::actionTaken"] = "unknown";
        expect(() => parseTrace(raw, "unknown-action", profile)).toThrow(/unknown/);
        const chosenAction = Object.keys(profile.actions).find((action) => profile.actions[action]!.choices !== undefined)!;
        if (profile.explicitInputs) raw.states[1].input = { name: chosenAction, choice: { "#bigint": "9007199254740993" } };
        else {
          raw.states[1]["mbt::actionTaken"] = chosenAction;
          raw.states[1]["mbt::nondetPicks"].choice = { tag: "Some", value: { "#bigint": "9007199254740993" } };
        }
        expect(() => parseTrace(raw, "unsafe-choice", profile)).toThrow(/safe ITF integer/);
      });
      if (profile.readIO) it("rejects missing read observations and detects corrupted budgets", async () => {
        const raw = JSON.parse(readFileSync(traces[0]!.path, "utf8"));
        delete raw.states[0].s.io;
        expect(() => parseTrace(raw, "missing-read-observations", profile)).toThrow();
        const trace = structuredClone(traces[0]!);
        trace.steps[1]!.io!.budgets.push(999);
        await expect(replay(profile, trace)).rejects.toThrow(/step 1 action.*\nexpected:.*\nactual:/s);
      });
      if (profile.diagnosticAge !== undefined) it("rejects missing diagnostics and detects corrupted diagnostic expectations", async () => {
        const raw = JSON.parse(readFileSync(traces[0]!.path, "utf8"));
        delete raw.states[0].s.d;
        expect(() => parseTrace(raw, "missing-diagnostics", profile)).toThrow();
        const trace = structuredClone(traces[0]!);
        trace.steps[1]!.diagnostics!.ages.push(123);
        await expect(replay(profile, trace)).rejects.toThrow(/step 1 action.*\nexpected:.*\nactual:/s);
      });
      it("detects a corrupted model observation without changing execution", async () => {
        const trace = structuredClone(traces[0]!);
        trace.steps[1]!.expected.writes += 1;
        await expect(replay(profile, trace)).rejects.toThrow(/step 1 action.*\nexpected:.*\nactual:/s);
      });
    }
  });
}
if (single !== undefined && !Object.keys(profiles).some((name) => single.includes(`/${name}/`) || single.endsWith(`${name}-smoke.itf.json`))) {
  throw new Error("Single feature trace must be inside its independent/layers/admission/scope/recovery/policy/shadow profile directory");
}
