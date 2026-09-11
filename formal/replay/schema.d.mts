export const schema: Record<string, unknown>;
/** Member path of the first violation (rooted at `root`), or undefined when the value matches the definition. */
export function schemaViolation(value: unknown, definition: string, root?: string): string | undefined;
export function assertSchema(value: unknown, definition: string): void;
