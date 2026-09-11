import { readFileSync } from "node:fs";
import { record } from "./itf.js";

export interface PublicCheckpoint {
  step: number;
  observation: Record<string, unknown>;
  diagnostics?: Record<string, unknown>;
}
export interface PublicPrefixWitnessRule {
  name: string;
  regression: string;
  commands: string[];
  checkpoints: PublicCheckpoint[];
}
export const witnessCommand = (name: string, choice = -1) => `${name}:${choice}`;
export const publicCheckpoint = (step: number, observation: Record<string, unknown>, diagnostics?: Record<string, unknown>): PublicCheckpoint =>
  ({ step, observation, ...(diagnostics === undefined ? {} : { diagnostics }) });
export const publicPrefixRule = (name: string, regression: string, commands: string[], ...checkpoints: PublicCheckpoint[]): PublicPrefixWitnessRule =>
  ({ name, regression, commands, checkpoints });

function decoded(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decoded);
  if (value === null || typeof value !== "object") return value;
  const object = record(value, "public witness");
  if (Object.hasOwn(object, "#bigint")) {
    const encoded = object["#bigint"];
    if (Object.keys(object).length !== 1 || typeof encoded !== "string" || !/^-?\d+$/.test(encoded)
      || !Number.isSafeInteger(Number(encoded))) throw new Error("Invalid public witness integer");
    return Number(encoded);
  }
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, decoded(item)]));
}
function contains(observed: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => JSON.stringify(observed[key]) === JSON.stringify(value));
}

// Read declared inputs and public observations only. A rule requires every
// checkpoint in its replayable prefix; later matching values cannot hide a
// violation at the boundary being claimed. No private state or filename earns
// credit, and this classifier never supplies an implementation's inputs.
export function publicPrefixWitnesses(paths: readonly string[], rules: readonly PublicPrefixWitnessRule[]): Set<string> {
  const seen = new Set<string>();
  for (const path of paths) {
    const raw = record(JSON.parse(readFileSync(path, "utf8")), path);
    if (!Array.isArray(raw.states)) throw new Error("Missing public witness states");
    const commands: string[] = [];
    const observations = raw.states.map(rawState => {
      const state = record(rawState, path);
      const input = record(decoded(state.input), path);
      if (typeof input.name !== "string" || typeof input.choice !== "number") throw new Error("Missing explicit public witness input");
      commands.push(witnessCommand(input.name, input.choice));
      const publicState = record(state.s, path);
      return { observation: record(decoded(publicState.o), path), diagnostics: decoded(publicState.d) };
    });
    for (const rule of rules) {
      if (commands.length < rule.commands.length || !rule.commands.every((value, index) => value === commands[index])) continue;
      if (rule.checkpoints.every(check => {
        const actual = observations[check.step]!;
        return contains(actual.observation, check.observation) && (check.diagnostics === undefined
          || (actual.diagnostics !== undefined && contains(record(actual.diagnostics, path), check.diagnostics)));
      })) seen.add(rule.name);
    }
  }
  return seen;
}
