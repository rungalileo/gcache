export interface RecoveryReadWitnessRule {
  name: string;
  regression: string;
  commands: string[];
  outcome: Record<string, unknown>;
}
export const recoveryReadWitnessRules: readonly RecoveryReadWitnessRule[];
export function recoveryReadWitnesses(paths: readonly string[]): Set<string>;
