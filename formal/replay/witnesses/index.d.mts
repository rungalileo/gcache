import type { Trace as EffectsTrace } from "../effects.mjs";
import type { Trace as FeatureTrace } from "../features.mjs";
import type { LocalClockTrace } from "../local-clock.mjs";
export type FeatureHistory = FeatureTrace & { states: Array<Record<string, unknown>> };
export type WitnessCorpus = FeatureHistory[] | EffectsTrace[] | LocalClockTrace[];
export interface WitnessCheck {
  profile: string;
  traces: number;
  seen: Set<string>;
  required: string[];
  missing: string[];
}
export const witnessProfiles: readonly string[];
export function loadCorpus(profile: string, paths: readonly string[]): WitnessCorpus;
export function evaluateCorpus(profile: string, corpus: WitnessCorpus, paths: readonly string[]): Set<string>;
export function evaluateWitnesses(profile: string, paths: readonly string[]): Set<string>;
export function requiredActions(profile: string): string[];
export function readWitnessRegistry(path?: string | URL): Record<string, string[]>;
export function requiredWitnesses(profile: string, registry?: Record<string, string[]>): string[];
export function checkWitnesses(profile: string, paths: readonly string[], registry?: Record<string, string[]>): WitnessCheck;
