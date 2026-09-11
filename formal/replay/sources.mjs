import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// One registry entry binds this entire shared executable boundary. Checking the
// directory closure prevents a newly imported mapping from silently escaping
// isolated witness fingerprints before the full completion gate is reached.
export function replaySources(directory = ".") {
  const registry = JSON.parse(readFileSync(resolve(directory, "formal/profiles.json"), "utf8"));
  const actual = [];
  function visit(relative) {
    for (const entry of readdirSync(resolve(directory, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (/\.(mjs|mts|json)$/.test(entry.name)) actual.push(path);
    }
  }
  visit("formal/replay");
  actual.sort();
  const declared = registry.replaySources;
  if (!Array.isArray(declared) || declared.length === 0 || JSON.stringify(declared) !== JSON.stringify(actual)) {
    throw new Error("Shared replay source inventory differs from formal/replay; review profiles.json replaySources");
  }
  return actual;
}
