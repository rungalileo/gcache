import type { Observation } from "../../test/formal/behavior-driver.js";
export type Projected=Omit<Observation,"calls">&{calls:number[]};
export interface LocalClockStep {action:string;choice:number;expected:Projected}
export interface LocalClockTrace {path:string;steps:LocalClockStep[]}
export function parseLocalClockTrace(raw:unknown,path:string):LocalClockTrace;
export function localClockInput(action:string,choice:number):Array<{op:string;instance?:number;ticks?:number;offered?:number}>;
export function assertLocalClockObservation(step:LocalClockStep,observed:Projected):void;
export const localClockActions:string[];
