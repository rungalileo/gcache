import { describe, expect, it } from "vitest";
import {
  readGeneratedEnvelopeVectors, validateGeneratedEnvelopeVectors, vectorsFromTrace,
  type EnvelopeSelection,
} from "../formal/generate-envelope-vectors.mjs";

const corpus = readGeneratedEnvelopeVectors();
const integer = (value: number) => ({ "#bigint": String(value) });
const bytes = (hex: string) => Array.from(Buffer.from(hex, "hex"), integer);
const units = (value: string) => Array.from({ length: value.length }, (_, i) => integer(value.charCodeAt(i)));
const scalars = (value: string) => Array.from(value, char => integer(char.codePointAt(0)!));
const selection = (value: EnvelopeSelection) => ({ outcome: value.outcome, storedBytes: integer(value.storedBytes), marker: integer(value.marker) });
function blank() {
  return {
    input: { command: "init", id: integer(-1), label: "", binary: true, bytes: bytes(""), units: units(""),
      thresholdBytes: integer(1), maximum: integer(536870912), codecTsBytes: integer(0), codecGoBytes: integer(0),
      decoderSucceeds: false, decodedBytes: bytes(""), writeEnabled: true },
    result: { escaped: bytes(""), originalBytes: integer(0),
      read: { binary: true, bytes: bytes(""), scalars: scalars(""), outcome: "pending" },
      typescript: selection({ outcome: "pending", storedBytes: 0, marker: -1 }),
      go: selection({ outcome: "pending", storedBytes: 0, marker: -1 }) },
  };
}
// Re-wrap committed Quint inputs/results to challenge only representation
// conversion. These controls contribute no behavioral or mutation credit and
// never derive wrapper outcomes from fixture bytes or codec lengths.
function trace() {
  const states = [blank()];
  for (const vector of corpus.envelopeVectors) {
    const state = blank();
    Object.assign(state.input, { command: "envelope", id: integer(states.length-1), bytes: bytes(vector.inputHex) });
    state.result.escaped = bytes(vector.escapedHex);
    state.result.read = { binary: true, bytes: bytes(vector.decodedHex), scalars: [], outcome: vector.outcome };
    states.push(state);
  }
  for (const vector of corpus.compressedDecodeVectors) {
    const state = blank();
    Object.assign(state.input, { command: "decode", id: integer(states.length-1), bytes: bytes(vector.inputHex),
      maximum: integer(vector.maxDecompressedBytes), writeEnabled: vector.newWritesEnabled,
      decoderSucceeds: vector.codecFixture.succeeds, decodedBytes: bytes(vector.codecFixture.decodedHex) });
    state.result.read = { binary: vector.payloadType === "binary", bytes: bytes(vector.payloadHex ?? ""),
      scalars: scalars(vector.payloadUtf8 ?? ""), outcome: vector.outcome };
    states.push(state);
  }
  for (const vector of corpus.compressionWriteVectors) {
    const state = blank();
    Object.assign(state.input, { command: "write", id: integer(states.length-1), label: vector.name.split(" write ")[1]!,
      binary: vector.payloadType === "binary", bytes: bytes(vector.payloadHex ?? ""), units: units(vector.payloadUtf8 ?? ""),
      thresholdBytes: integer(vector.thresholdBytes), maximum: integer(vector.maxDecompressedBytes),
      codecTsBytes: integer(vector.codecBytes.typescript), codecGoBytes: integer(vector.codecBytes.go) });
    state.result.escaped = bytes(vector.escapedHex);
    state.result.originalBytes = integer(vector.originalBytes);
    state.result.typescript = selection(vector.expectedByBinding.typescript);
    state.result.go = selection(vector.expectedByBinding.go);
    states.push(state);
  }
  return { states };
}

describe("Quint envelope vector export controls", () => {
  it("preserves the actual Quint input/output inventory through conversion", () => {
    expect(vectorsFromTrace(trace())).toEqual({ envelopeVectors: corpus.envelopeVectors,
      compressedDecodeVectors: corpus.compressedDecodeVectors, compressionWriteVectors: corpus.compressionWriteVectors });
  });
  it("rejects a missing input combination", () => {
    const raw = trace(); raw.states.pop();
    expect(() => vectorsFromTrace(raw)).toThrow(/Incomplete/);
  });
  it("rejects duplicate input identities at the same history length", () => {
    const raw = trace(); raw.states[2]!.input.id = integer(0);
    expect(() => vectorsFromTrace(raw)).toThrow(/duplicate/);
  });
  it("rejects pending reads without an observable result", () => {
    const raw = trace(); raw.states[16]!.result.read.outcome = "pending";
    expect(() => vectorsFromTrace(raw)).toThrow(/Unfinished/);
  });
  it("requires completed selections for both native codec inputs", () => {
    const raw = trace(); raw.states.at(-1)!.result.go.outcome = "pending";
    expect(() => vectorsFromTrace(raw)).toThrow(/Unfinished/);
  });
  it("rejects unsafe native byte counts", () => {
    const raw = trace(); raw.states.at(-1)!.input.codecTsBytes = { "#bigint": "9007199254740993" };
    expect(() => vectorsFromTrace(raw)).toThrow(/Inexact/);
  });
  it("does not recompute the model's selected byte count", () => {
    const raw = trace(); raw.states.at(-1)!.result.go.storedBytes = integer(12345);
    expect(vectorsFromTrace(raw).compressionWriteVectors.at(-1)!.expectedByBinding.go.storedBytes).toBe(12345);
  });
  it("does not replace the model's Unicode scalars with a host decode", () => {
    const raw = trace(); raw.states[16]!.result.read.scalars = [integer(90)];
    raw.states[16]!.result.read.binary = false;
    expect(vectorsFromTrace(raw).compressedDecodeVectors[0]!.payloadUtf8).toBe("Z");
  });
  it("rejects stale source provenance without invoking Quint", () => {
    const stale = structuredClone(corpus); stale.provenance.sourceSha256[stale.provenance.model] = "0".repeat(64);
    expect(() => validateGeneratedEnvelopeVectors(stale)).toThrow(/Stale/);
  });
  it("rejects an incomplete committed vector group", () => {
    const incomplete = structuredClone(corpus); incomplete.compressedDecodeVectors.pop();
    expect(() => validateGeneratedEnvelopeVectors(incomplete)).toThrow(/Incomplete/);
  });
});
