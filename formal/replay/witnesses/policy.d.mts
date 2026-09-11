import type { FeatureHistory } from "./index.mjs";
export function clockWitnesses(name: "policy" | "recovery", histories: readonly FeatureHistory[]): Set<string>;
export function policyWitnesses(histories: readonly FeatureHistory[]): Set<string>;
