export interface Binding {
  trace: { path: string; steps: Array<{ action: string }> };
  fixture: Record<string, unknown>;
  setup: Array<Record<string, unknown>>;
  commands(index: number, observed: unknown, environment: { wallMs: number }): Array<Record<string, unknown>>;
  assert(index: number, observed: unknown): void;
}
export function profileActions(): Record<string, string[]>;
export function bindTrace(profile: string, raw: unknown, path: string): Binding;
