import type { Trace } from "../effects.mjs";
export function effectsWitnesses(traces: readonly Trace[]): Set<string>;
