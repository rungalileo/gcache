export interface EffectsPublicState {
  calls: number[];
  reads: number;
  loaders: number;
  loads: number;
  dumps: number;
  writes: number;
  events: Array<{ event: string; location: string; detail: string; amount: number }>;
}
export interface EffectsAuthorityRule {
  name: string;
  regression: string;
  commands: string[];
  consequence: (state: EffectsPublicState) => boolean;
}
export const effectsAuthorityRules: readonly EffectsAuthorityRule[];
export function effectsAuthorityWitnesses(paths: readonly string[]): Set<string>;
