export type InvalidationVectorState =
  | { kind: "absent"; ttlMs: -2 }
  | { kind: "string"; value: string; ttlMs: number }
  | { kind: "list"; values: string[]; ttlMs: number };
export interface GeneratedInvalidationVector {
  name: string;
  existing: InvalidationVectorState;
  futureBufferMs: string;
  invalidatedAtMs: string;
  expected: { error?: true; state: InvalidationVectorState };
}
export interface GeneratedInvalidationCorpus {
  schemaVersion: 2;
  provenance: { model: string; sourceSha256: Record<string, string> };
  vectors: GeneratedInvalidationVector[];
}
export function readGeneratedInvalidationVectors(): GeneratedInvalidationCorpus;
export function validateGeneratedInvalidationVectors(value: unknown): GeneratedInvalidationCorpus;
export function vectorsFromTrace(trace: unknown): GeneratedInvalidationVector[];
export function generateInvalidationVectors(mode: "--check" | "--write"): void;
export const expectedCases: number;
export const model: string;
export const generator: string;
export const artifact: string;
export const invariants: string[];
