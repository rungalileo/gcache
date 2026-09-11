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
export function witnessCommand(name: string, choice?: number): string;
export function publicCheckpoint(step: number, observation: Record<string, unknown>, diagnostics?: Record<string, unknown>): PublicCheckpoint;
export function publicPrefixRule(name: string, regression: string, commands: string[], ...checkpoints: PublicCheckpoint[]): PublicPrefixWitnessRule;
export function publicPrefixWitnesses(paths: readonly string[], rules: readonly PublicPrefixWitnessRule[]): Set<string>;
