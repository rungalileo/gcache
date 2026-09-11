export interface EnvelopeSelection { outcome: string; storedBytes: number; marker: number }
export interface EnvelopeVector { name: string; inputHex: string; escapedHex: string; decodedHex: string; outcome: string }
export interface EnvelopeDecodeVector {
  name: string; inputHex: string; maxDecompressedBytes: number; newWritesEnabled: boolean;
  codecFixture: { succeeds: boolean; decodedHex: string };
  outcome: string; payloadType: "string" | "binary"; payloadHex?: string; payloadUtf8?: string;
}
export interface EnvelopeWriteVector {
  name: string; payloadType: "string" | "binary"; payloadHex?: string; payloadUtf8?: string;
  thresholdBytes: number; maxDecompressedBytes: number; originalBytes: number; rawStoredBytes: number;
  escapedHex: string; codecBytes: { typescript: number; go: number };
  expectedByBinding: { typescript: EnvelopeSelection; go: EnvelopeSelection };
}
export interface EnvelopeGroups {
  envelopeVectors: EnvelopeVector[];
  compressedDecodeVectors: EnvelopeDecodeVector[];
  compressionWriteVectors: EnvelopeWriteVector[];
}
export interface GeneratedEnvelopeCorpus extends EnvelopeGroups {
  schemaVersion: 3; provenance: { model: string; sourceSha256: Record<string, string> };
}
export function readGeneratedEnvelopeVectors(): GeneratedEnvelopeCorpus;
export function validateGeneratedEnvelopeVectors(value: unknown): GeneratedEnvelopeCorpus;
export function vectorsFromTrace(trace: unknown): EnvelopeGroups;
export const expectedCases: number;
export const model: string;
export const generator: string;
export const artifact: string;
export const invariants: string[];
