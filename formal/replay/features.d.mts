import type { Observation, Input } from "../../test/formal/behavior-driver.js";
import type { Profile } from "../../test/formal/feature-profile.js";
export type Projected = Omit<Observation, "calls"> & { calls: number[] };
export interface Diagnostics { warnings: number; ages: number[]; coalesced: string[]; fallbackErrors: string[]; configErrors?: number; futureOffsets?: Array<{ layer: string; offsetMs: number }> }
export interface ReadIO { budgets: number[]; aborted: number[]; sourceErrors: number[] }
export interface Marker { cutoffMs: number; ttlMs: number }
export interface Step { policyErrors?: Array<{ layer: string; errorType: string }>; compression?: string[]; markers?: Marker[]; io?: ReadIO; action: string; choice: number; expected: Projected; diagnostics?: Diagnostics }
export interface Trace { path: string; steps: Step[] }

export const profiles: Record<string, Profile>;
export function parseTrace(raw: unknown, path: string, profile: Profile): Trace;
export function projectObservation(profile: Profile, observed: Observation): Record<string, unknown>;
export function expectedObservation(step: Step): Record<string, unknown>;
export function featureInput(profile: Profile, action: string, choice: number, observed: Observation, environment: { wallMs: number }): Input;
export function assertFeatureObservation(profile: Profile, step: Step, observed: Observation): void;

export const successValues: readonly unknown[];
