import type { PublicPrefixWitnessRule } from "./public-prefix.mjs";
export const recoveryAdmissionWitnessRules: readonly PublicPrefixWitnessRule[];
export function recoveryAdmissionWitnesses(paths: readonly string[]): Set<string>;
