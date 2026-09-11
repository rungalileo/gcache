import { record } from "../itf.mjs";
import { decodeIntegers, explicitInput, readTrace, traceStates, witnessCommand } from "./trace.mjs";

export { witnessCommand };
export const publicCheckpoint = (step, observation, diagnostics) =>
  ({ step, observation, ...(diagnostics === undefined ? {} : { diagnostics }) });
export const publicPrefixRule = (name, regression, commands, ...checkpoints) =>
  ({ name, regression, commands, checkpoints });

function contains(observed, expected) {
  return Object.entries(expected).every(([key, value]) => JSON.stringify(observed[key]) === JSON.stringify(value));
}

// Read declared inputs and public observations only. A rule requires every
// checkpoint in its replayable prefix; later matching values cannot hide a
// violation at the boundary being claimed. No private state or filename earns
// credit, and this classifier never supplies an implementation's inputs.
export function publicPrefixWitnesses(paths, rules) {
  const seen = new Set();
  for (const path of paths) {
    const commands = [];
    const observations = traceStates(readTrace(path), path).map(rawState => {
      const state = record(rawState, path);
      const input = explicitInput(state, path);
      commands.push(witnessCommand(input.name, input.choice));
      const publicState = record(state.s, path);
      return { observation: record(decodeIntegers(publicState.o, path), path), diagnostics: decodeIntegers(publicState.d, path) };
    });
    for (const rule of rules) {
      if (commands.length < rule.commands.length || !rule.commands.every((value, index) => value === commands[index])) continue;
      if (rule.checkpoints.every(check => {
        const actual = observations[check.step];
        return contains(actual.observation, check.observation) && (check.diagnostics === undefined
          || (actual.diagnostics !== undefined && contains(record(actual.diagnostics, path), check.diagnostics)));
      })) seen.add(rule.name);
    }
  }
  return seen;
}
