import type { Policy } from "../../test/formal/behavior-driver.js";
export declare const actionNames: readonly ["init", "bumpSource", "outsideCall", "requestLocalPair", "localCall", "coalescedLocalPair", "remoteCall", "invalidateRemote", "remoteReadFailureCall"];
export type ActionName = typeof actionNames[number];
export declare const observationFields: readonly ["sourceVersion", "lastResult", "outsideLoaderCalls", "requestLoaderCalls", "localLoaderCalls", "coalescedLoaderCalls", "remoteLoaderCalls", "redisReads", "redisWrites"];
export type Observation = Pick<Snapshot, typeof observationFields[number]>;
export interface Snapshot {
  sourceVersion: number;
  lastResult: number;
  outsideLoaderCalls: number;
  requestLoaderCalls: number;
  localLoaderCalls: number;
  coalescedLoaderCalls: number;
  remoteLoaderCalls: number;
  localCached: boolean;
  localValue: number;
  coalescedCached: boolean;
  coalescedValue: number;
  remoteReadable: boolean;
  remoteValue: number;
  redisReads: number;
  redisWrites: number;
}
export interface TraceState {
  action: ActionName;
  state: Snapshot;
}
export interface Trace {
  path: string;
  states: TraceState[];
}

export interface Identity {
  keyType: string;
  id: string;
  useCase: string;
  tracked: boolean;
}
export type Counter = "outsideLoaderCalls" | "requestLoaderCalls" | "localLoaderCalls"
  | "coalescedLoaderCalls" | "remoteLoaderCalls";
export type CoreCommand =
  | { op: "advanceWall"; ms: number }
  | { op: "bumpSource" }
  | { op: "invalidate"; identity: Identity }
  | {
    op: "call";
    identity: Identity;
    policy: Policy;
    mode: "outside" | "single" | "request-pair" | "coalesced-pair";
    counter: Counter;
    readFailure: boolean;
  };
export function parseItfTrace(raw: unknown, path: string): Trace;
export function coreCommands(action: ActionName): CoreCommand[];
export function expectedCoreObservation(state: Snapshot): Observation;
export function assertCoreObservation(state: Snapshot, observed: Observation): void;
