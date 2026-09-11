import type { PublicPrefixWitnessRule } from "./public-prefix.mjs";
export const localFailureWitnessRules: readonly PublicPrefixWitnessRule[];
export function localFailureWitnesses(paths: readonly string[]): Set<string>;
