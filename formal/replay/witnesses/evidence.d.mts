export interface WitnessDigest { path?: string; name?: string; sha256: string }
export interface WitnessEvidence {
  schemaVersion: 1;
  profile: string;
  traces: number;
  required: string[];
  seen: string[];
  inputs: Array<{ path: string; sha256: string }>;
  corpus: Array<{ name: string; sha256: string }>;
}
export function witnessInputs(profile: string, directory?: string): string[];
export function witnessEvidence(profile: string, seen: Iterable<string>, required: Iterable<string>, paths: readonly string[], directory?: string): WitnessEvidence;
export function writeWitnessEvidence(outputDirectory: string, evidence: WitnessEvidence): string;
