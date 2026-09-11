export function readTrace(path: string): unknown;
export function traceStates(raw: unknown, context: string): unknown[];
export function explicitInput(state: unknown, context: string): { name: string; choice: number };
export function witnessCommand(name: string, choice?: number): string;
export function decodeIntegers(value: unknown, context: string): unknown;
export function integer(value: unknown, context: string): number;
export function privateStates(raw: unknown, context: string): Array<Record<string, unknown>>;
