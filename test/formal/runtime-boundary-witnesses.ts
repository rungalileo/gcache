import { readFileSync } from "node:fs";

import { itfInteger, itfSignedInteger, record } from "./itf.js";

const values = [1, 2, 5, 11, 6, 7, 8, 9];
const layerNames = ["request", "local", "remote"];
interface PublicState { action: string; choice: number; calls: number[]; loaders: number; reads: number; loads: number; writes: number }
function publicStates(raw: unknown): PublicState[] {
  const states = record(raw, "runtime-boundaries trace").states;
  if (!Array.isArray(states)) throw new Error("Missing runtime-boundaries states");
  return states.map(raw => {
    const state = record(raw, "state");
    const input = record(state.input, "input");
    const o = record(record(state.s, "state").o, "observation");
    if (typeof input.name !== "string" || !Array.isArray(o.calls)) throw new Error("Invalid runtime-boundaries envelope");
    return { action: input.name, choice: itfSignedInteger(input.choice, "choice"),
      calls: o.calls.map(value => itfInteger(value, "call")), loaders: itfInteger(o.loaders, "loaders"),
      reads: itfInteger(o.reads, "reads"), loads: itfInteger(o.loads, "loads"), writes: itfInteger(o.writes, "writes") };
  });
}

// Evidence is attributed from external policy/settlement commands and public
// returns/effects. Private model admissions, cache values and owners are never
// consulted. The replay separately checks every observation in these traces.
export function runtimeBoundaryTraceWitnesses(raw: unknown): Set<string> {
  const states = publicStates(raw);
  const seen = new Set<string>();
  const fixture = states[0]!.choice;
  const layer = fixture < 6 ? fixture % 3 : fixture === 7 ? 2 : fixture === 9 ? 0 : 1;
  const defaultSharing = fixture >= 3;
  let policy = 9;
  let pendingCaller = -1;
  let open = true;
  const policies = new Map<number, number>();
  interface Source { caller: number; policy: number; active: boolean; reads: number }
  const sources = new Map<number, Source>();
  interface Publication { loader: number; value: number; policy: number }
  let publication: Publication | undefined;
  let priorPublication: Publication | undefined;
  let equality: { loader: number; value: number } | undefined;
  let preserved: { policy: number; publication: Publication; bypassValue: number } | undefined;
  const settled = new Set<number>();
  const falsyProbes = new Set<number>();
  const sharedPolicies = new Set<number>();
  const uncachedDefaults = new Set<number>();
  let killedSettlements = 0;
  for (let index = 1; index < states.length; index++) {
    const step = states[index]!;
    const before = states[index - 1]!;
    seen.add(`action:${step.action}`);
    if (step.action === "policy") policy = step.choice;
    if (step.action === "closeScope") { open = false; publication = undefined; }
    if (step.action === "beginCall") pendingCaller = before.calls.length;
    if (step.action === "releasePolicy") {
      policies.set(pendingCaller, policy);
      if (step.loaders === before.loaders + 1) {
        sources.set(step.loaders - 1, { caller: pendingCaller, policy,
          active: open && !(policy >= 14 && policy <= 17) && policy !== 21
            && (fixture < 6 || fixture === 9 || layer === 1 && (policy === 18 || policy === 20) || layer === 2 && policy === 19)
            && (fixture !== 8 || policy === 20)
            && (layer === 0 ? policy !== 13 : policy >= 12 || Math.floor(policy / 3) >= 2),
          reads: step.reads - before.reads });
      }
      const value = step.calls[pendingCaller];
      const hit = value !== undefined && value !== 0 && step.loaders === before.loaders && before.calls[pendingCaller] === 0;
      if (hit && publication !== undefined && value === publication.value) {
        if ([5, 11].includes(value) && settled.has(5) && settled.has(11)) seen.add(`absent-distinct-from-text:${layerNames[layer]}`);
        if ([6, 7, 8, 9].includes(value)) falsyProbes.add(value);
        if (falsyProbes.size === 4) seen.add(`falsy-values:${layerNames[layer]}`);
        if (equality !== undefined && layer !== 0 && Math.floor(policy / 3) === 2
          && publication.policy < 12 && Math.floor(publication.policy / 3) === 2
          && publication.loader > equality.loader && value !== equality.value) seen.add(`exact-serving-cohort:${layerNames[layer]}`);
        if (priorPublication !== undefined && publication.loader < priorPublication.loader
          && value !== priorPublication.value && !defaultSharing && layer === 0
          && publication.policy % 3 === 0 && priorPublication.policy % 3 === 0) seen.add("inherited-false-request-last-writer");
        if (preserved !== undefined && preserved.publication === publication && value !== preserved.bypassValue) {
          const names: Record<number, string> = { 13: "false-request-leaf", 14: "invalid-coalesce", 15: "invalid-request-local", 16: "null-coalesce", 17: "null-request-local" };
          if (preserved.policy === 21) {
            if (fixture === 9 && killedSettlements >= 2 && sharedPolicies.has(9)) seen.add("full-feature-kill-switch");
          } else seen.add(`bypass-preserves-cache:${names[preserved.policy]}`);
        }
        if (fixture === 6 && publication.policy === 18 && [...uncachedDefaults].some(previous => previous !== value)) seen.add("runtime-ttl-implies-ramp:local");
        if (fixture === 7 && publication.policy === 19 && [...uncachedDefaults].some(previous => previous !== value)) seen.add("runtime-ttl-implies-ramp:remote");
        if (fixture === 8 && publication.policy === 20 && sharedPolicies.has(20)
          && [...uncachedDefaults].some(previous => previous !== value)) seen.add("disabled-baseline-default-sharing");
        if (defaultSharing && layer === 2 && step.reads === before.reads + 1 && step.loads === before.loads + 1) {
          if (policy === 12 && sharedPolicies.has(12)) seen.add("null-provider-inherits-serving-and-sharing");
          if (policy === 9 && sharedPolicies.has(9)) seen.add("default-ramp-and-sharing");
        }
      }
    }
    if (step.action !== "resolveLoader") continue;
    const loader = Math.floor(step.choice / values.length);
    const value = values[step.choice % values.length];
    const source = sources.get(loader);
    if (source === undefined || value === undefined || before.calls[source.caller] !== 0 || step.calls[source.caller] !== value) continue;
    settled.add(value);
    if (!source.active && fixture >= 6 && source.policy === 9) uncachedDefaults.add(value);
    if (!source.active && source.policy === 21) killedSettlements++;
    const completed = step.calls.map((result, caller) => ({ result, caller }))
      .filter(({ result, caller }) => before.calls[caller] === 0 && result === value);
    if (source.active && completed.length >= 2 && completed.every(({ caller }) => policies.get(caller) === source.policy)) {
      sharedPolicies.add(source.policy);
      if (!defaultSharing && source.policy < 12 && source.policy % 3 === 2) seen.add("runtime-enables-sharing");
      if (defaultSharing && source.policy === 9 && [...sources.values()].some(other => other.policy === 10)) seen.add("reenabled-default-sharing");
    }
    if (source.active) {
      priorPublication = publication;
      publication = { loader, value, policy: source.policy };
    } else if (layer !== 0 && source.policy < 12 && Math.floor(source.policy / 3) === 1
      && source.reads === 0 && step.writes === before.writes) equality = { loader, value };
    else if (publication !== undefined && source.reads === 0 && step.writes === before.writes
      && (source.policy >= 14 && source.policy <= 17 || source.policy === 21 || source.policy === 13 && layer === 0)) {
      preserved = { policy: source.policy, publication, bypassValue: value };
    }
  }
  return seen;
}

export function runtimeBoundaryWitnesses(profile: string, paths: readonly string[]): Set<string> {
  if (profile !== "runtime-boundaries") return new Set();
  const seen = new Set<string>();
  for (const path of paths) for (const witness of runtimeBoundaryTraceWitnesses(JSON.parse(readFileSync(path, "utf8")))) seen.add(witness);
  return seen;
}
