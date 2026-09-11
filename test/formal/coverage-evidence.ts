import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

// Optional measurement output. Expected observations never enter the driver.
// A baseline run must pass all replays as well as these reachability checks.
export function recordWitnesses(profile: string, seen: Set<string>, required: string[], traces: readonly { path: string }[]): void {
  const directory = process.env.DIALCACHE_COVERAGE_EVIDENCE_DIR;
  if (directory === undefined) return;
  mkdirSync(directory, { recursive: true });
  const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  // Reachability is a property of the common input corpus. Ports reuse this
  // evaluated witness evidence only after matching every byte of that corpus
  // and its definitions, and separately replay all implementation observations.
  const registry = JSON.parse(readFileSync("formal/profiles.json", "utf8")) as { profiles: Array<{ id: string; witnessSources?: string[] }> };
  const execution = JSON.parse(readFileSync("formal/execution.json", "utf8")) as { libraries: string[] };
  const inputs = [...new Set(["formal/profiles.json", "formal/coverage-witnesses.json", "formal/execution.json",
    `formal/dialcache-${profile}-conformance.qnt`, "formal/conformance-observations.qnt",
    profile === "effects" ? "test/formal-effects.test.ts" : "test/formal-features.test.ts",
    "test/formal/coverage-evidence.ts",
    ...(profile === "effects" ? [] : ["test/formal/runtime-witnesses.ts", "test/formal/recovery-shadow-witnesses.ts"]),
    ...execution.libraries,
    ...(registry.profiles.find(entry => entry.id === profile)?.witnessSources ?? []),
  ])].map(path => ({ path, sha256: hash(path) }));
  const corpus = traces.map(({ path }) => ({ name: basename(path), sha256: hash(path) }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  if (new Set(corpus.map(({ name }) => name)).size !== corpus.length) throw new Error("Witness corpus contains duplicate file names");
  writeFileSync(resolve(directory, `${profile}.json`), JSON.stringify({ schemaVersion: 1,
    profile, traces: traces.length, required, seen: [...seen].sort(), inputs, corpus }, null, 2) + "\n");
}
