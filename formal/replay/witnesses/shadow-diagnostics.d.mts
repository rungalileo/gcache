import type { PublicPrefixWitnessRule } from "./public-prefix.mjs";
export const shadowDiagnosticsWitnessRules: readonly PublicPrefixWitnessRule[];
export function shadowDiagnosticsWitnesses(paths: readonly string[]): Set<string>;
