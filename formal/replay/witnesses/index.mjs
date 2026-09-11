import { readFileSync } from "node:fs";
import { actions as effectActions, parseTrace as parseEffectsTrace } from "../effects.mjs";
import { profiles as featureProfiles, parseTrace as parseFeatureTrace } from "../features.mjs";
import { localClockActions, parseLocalClockTrace } from "../local-clock.mjs";
import { admissionWitnesses } from "./admission.mjs";
import { effectsWitnesses } from "./effects.mjs";
import { effectsAuthorityWitnesses } from "./effects-authority.mjs";
import { independentWitnesses } from "./independent.mjs";
import { actionLabels, flowLabels } from "./labels.mjs";
import { layersWitnesses } from "./layers.mjs";
import { localClockWitnesses } from "./local-clock.mjs";
import { localFailureWitnesses } from "./local-failure.mjs";
import { policyWitnesses } from "./policy.mjs";
import { recoveryWitnesses } from "./recovery.mjs";
import { recoveryAdmissionWitnesses } from "./recovery-admission.mjs";
import { recoveryReadWitnesses } from "./recovery-read.mjs";
import { recoveryShadowWitnesses } from "./recovery-shadow.mjs";
import { runtimeWitnesses } from "./runtime.mjs";
import { runtimeBoundaryWitnesses } from "./runtime-boundaries.mjs";
import { scopeWitnesses } from "./scope.mjs";
import { shadowWitnesses } from "./shadow.mjs";
import { shadowDiagnosticsWitnesses } from "./shadow-diagnostics.mjs";
import { shadowLayersWitnesses } from "./shadow-layers.mjs";
import { sourceBudgetsWitnesses } from "./source-budgets.mjs";
import { privateStates, readTrace } from "./trace.mjs";

// One language-neutral witness evaluator for every profile with a completion
// gate. Any port runs it over the same sampled histories and exported
// regressions; TypeScript's test suite calls the same functions. Classifiers
// read declared inputs, public observations and private model predictions from
// the Quint histories only. Driver observations never reach this module, and
// nothing here supplies an implementation's inputs.
export const witnessProfiles = [...Object.keys(featureProfiles), "effects", "local-clock"];

function union(...sets) {
  return new Set(sets.flatMap(set => [...set]));
}

// Parse the corpus once with the shared strict parsers. Feature histories also
// expose their decoded private predictions for the classifiers that need them.
export function loadCorpus(profile, paths) {
  if (profile === "effects") return paths.map(path => parseEffectsTrace(readTrace(path), path));
  if (profile === "local-clock") return paths.map(path => parseLocalClockTrace(readTrace(path), path));
  const definition = featureProfiles[profile];
  if (definition === undefined) throw new Error(`Unknown witness profile ${profile}`);
  return paths.map(path => {
    const raw = readTrace(path);
    return { ...parseFeatureTrace(raw, path, definition), states: privateStates(raw, path) };
  });
}

export function evaluateCorpus(profile, corpus, paths) {
  switch (profile) {
    case "effects": return union(effectsWitnesses(corpus), effectsAuthorityWitnesses(paths));
    case "local-clock": return localClockWitnesses(corpus);
    case "policy": return union(policyWitnesses(corpus), runtimeWitnesses(profile, paths));
    case "scope": return union(scopeWitnesses(corpus), runtimeWitnesses(profile, paths));
    case "layers": return union(layersWitnesses(corpus), runtimeWitnesses(profile, paths));
    case "admission": return admissionWitnesses(corpus);
    case "independent": return independentWitnesses(corpus);
    case "recovery": return union(recoveryWitnesses(corpus), recoveryShadowWitnesses(profile, paths));
    case "shadow": return union(shadowWitnesses(corpus), recoveryShadowWitnesses(profile, paths), shadowDiagnosticsWitnesses(paths));
    case "recovery-read": return union(actionLabels(corpus), recoveryReadWitnesses(paths), recoveryAdmissionWitnesses(paths));
    case "shadow-layers": return union(actionLabels(corpus), shadowLayersWitnesses(paths));
    case "local-failure": return union(actionLabels(corpus), localFailureWitnesses(paths));
    case "source-budgets": return union(actionLabels(corpus), sourceBudgetsWitnesses(paths));
    case "runtime-boundaries": return union(flowLabels(corpus), runtimeBoundaryWitnesses(profile, paths));
    default: throw new Error(`Unknown witness profile ${profile}`);
  }
}

export function evaluateWitnesses(profile, paths) {
  return evaluateCorpus(profile, loadCorpus(profile, paths), paths);
}

// Every declared external action must appear in the corpus. init is the
// initial state, not a transition, and is excluded for the feature profiles.
export function requiredActions(profile) {
  if (profile === "effects") return [...effectActions];
  if (profile === "local-clock") return [...localClockActions];
  const definition = featureProfiles[profile];
  if (definition === undefined) throw new Error(`Unknown witness profile ${profile}`);
  return Object.keys(definition.actions);
}

export function readWitnessRegistry(path = new URL("../../coverage-witnesses.json", import.meta.url)) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function requiredWitnesses(profile, registry = readWitnessRegistry()) {
  const required = registry[profile];
  if (!Array.isArray(required) || required.length === 0) throw new Error(`No required witnesses registered for ${profile}`);
  return [...required];
}

// The completion gate: every required label and every declared action must be
// reached. Returns the evaluated labels together with whatever is missing.
export function checkWitnesses(profile, paths, registry = readWitnessRegistry()) {
  if (paths.length === 0) throw new Error(`No ${profile} histories to evaluate`);
  const corpus = loadCorpus(profile, paths);
  const seen = evaluateCorpus(profile, corpus, paths);
  const actions = new Set(corpus.flatMap(trace => trace.steps.map(step => step.action)));
  const required = requiredWitnesses(profile, registry);
  const missing = [...requiredActions(profile).filter(action => !actions.has(action)).map(action => `action:${action}`),
    ...required.filter(label => !seen.has(label))];
  return { profile, traces: paths.length, seen, required, missing };
}
