import type { Fixture, Input, Observation } from "../../test/formal/behavior-driver.js";
export const actions: readonly string[];
export const observedFields: readonly string[];
export interface Event { event: string; location: string; detail: string; amount: number }
export type State = Record<"now"|"wall"|"readStarted"|"decodeStarted"|"tracked"|"reply"|"replyAt"|"readBudget"|"baseReadBudget"|"phase"|"activeLoader"|"activeRead"|"deadline"|"refill"|"acceptedAt"|"acceptedWall"|"observerFailed"|"readAborts"|"observedFence"|"writeTimestamp"|"storedTimestamp"|"watermark"|"loaders"|"reads"|"writes"|"invalidations"|"loads"|"dumps"|"policyCalls",number>&{calls:number[];sources:number[];readStates:number[];readBudgets:number[];events:Event[]};
export interface Step { action:string;choice?:number;state:State }
export interface Trace { path:string;steps:Step[] }
export function parseTrace(raw:unknown,path:string):Trace;
export function fixtureFor(mode:number):Fixture;
export function inputsFor(step:Pick<Step,"action"|"choice">,observed:Observation,environment:{wallMs:number}):Input[];
export function project(observed:Observation):Record<string,unknown>;
export function expectedObservations(trace:Trace):Record<string,unknown>[];
