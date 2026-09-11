import type { PublicPrefixWitnessRule } from "./public-prefix.mjs";
export const sourceBudgetsWitnessRules: readonly PublicPrefixWitnessRule[];
export function sourceBudgetsWitnesses(paths: readonly string[]): Set<string>;
