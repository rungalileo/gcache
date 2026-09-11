export function parseJSON(text: string): unknown;
export function assertSubset(actual: unknown, required: Record<string, unknown>): void;
export function replayLines(input: AsyncIterable<Uint8Array | string>, limit?: number): AsyncGenerator<string>;
