import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { replaySources } from "../sources.mjs";

// Reachability is a property of the common input corpus. Ports reuse this
// evaluated witness evidence only after matching every byte of that corpus
// and its definitions, and separately replay all implementation observations.
// The definition inputs are language neutral: the registry, the required
// witnesses, the execution manifest, the profile's model and observation
// library, every Quint library, the shared replay closure (which contains the
// witness classifiers) and the profile's declared witness sources.
export function witnessInputs(profile, directory = ".") {
  const registry = JSON.parse(readFileSync(resolve(directory, "formal/profiles.json"), "utf8"));
  const execution = JSON.parse(readFileSync(resolve(directory, "formal/execution.json"), "utf8"));
  const entry = registry.profiles.find(candidate => candidate.id === profile);
  if (entry === undefined) throw new Error(`Unknown witness profile ${profile}`);
  const inputs = [...new Set(["formal/profiles.json", "formal/coverage-witnesses.json", "formal/execution.json",
    `formal/dialcache-${profile}-conformance.qnt`, "formal/conformance-observations.qnt",
    ...execution.libraries, ...replaySources(directory), ...(entry.witnessSources ?? [])])];
  const foreign = inputs.filter(path => /^(test|src|go)\//.test(path));
  if (foreign.length) throw new Error(`Witness inputs must be language neutral; remove ${foreign.join(", ")} from witnessSources`);
  return inputs;
}

const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");

export function witnessEvidence(profile, seen, required, paths, directory = ".") {
  const inputs = witnessInputs(profile, directory).map(path => ({ path, sha256: hash(resolve(directory, path)) }));
  const corpus = paths.map(path => ({ name: basename(path), sha256: hash(path) }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  if (new Set(corpus.map(({ name }) => name)).size !== corpus.length) throw new Error("Witness corpus contains duplicate file names");
  return { schemaVersion: 1, profile, traces: paths.length, required: [...required], seen: [...seen].sort(), inputs, corpus };
}

export function writeWitnessEvidence(outputDirectory, evidence) {
  mkdirSync(outputDirectory, { recursive: true });
  const path = resolve(outputDirectory, `${evidence.profile}.json`);
  writeFileSync(path, JSON.stringify(evidence, null, 2) + "\n");
  return path;
}
