import { describe, expect, it } from "vitest";

const url = new URL("../formal/generate-frame-vectors.mjs", import.meta.url).href;
const { expectedCases, vectorsFromTrace, readGeneratedFrameVectors } = await import(url) as {
  expectedCases: number;
  vectorsFromTrace(trace: unknown): Record<string, Array<Record<string, unknown>>>;
  readGeneratedFrameVectors(): Record<string, unknown>;
};
const integer = (value: number | string) => ({ "#bigint": String(value) });
const input = (id: number) => ({
  command: "encode", id: integer(id), binary: true, units: [], bytes: [integer(255)],
  timestamp: { numeratorHigh: integer(0), numeratorLow: integer(1), denominator: integer(1), special: "" },
  tracked: false, present: true, watermarkPresent: false, watermark: [],
});
const result = () => ({ kind: "frame", payloadType: "", bytes: [integer(10), integer(20)], scalars: [] as ReturnType<typeof integer>[], timestamp: integer(0), reason: "", fence: integer(-1), duration: integer(0) });
// Deliberately not a real frame expectation: the converter must transcribe its
// input observation, never repair it by running a native encoder. Semantic
// correctness is checked by Quint and the separate implementation replays.
const trace = () => ({ states: [
  { input: { ...input(-1), command: "init" }, result: result() },
  ...Array.from({ length: expectedCases }, (_, id) => ({ input: input(id), result: result() })),
] });

describe("Quint frame vector export boundary", () => {
  it("transcribes expected bytes without replacing them with a native codec result", () => {
    const converted = vectorsFromTrace(trace());
    expect(converted.frameVectors).toHaveLength(expectedCases);
    expect(converted.frameVectors![0]).toMatchObject({ payloadHex: "ff", frameHex: "0a14", createdAtMs: 1 });
  });
  it("transcribes the modeled payload type instead of interpreting the input encoding byte", () => {
    const raw = trace(), decoded = raw.states[1]!;
    decoded.input.command = "decode";
    decoded.input.bytes = [1, 0, 0, 0, 0, 0, 0, 0, 1, 0].map(integer);
    decoded.result.kind = "hit";
    decoded.result.payloadType = "binary";
    decoded.result.bytes = [];
    expect(vectorsFromTrace(raw).untrackedDecodeVectors![0]).toMatchObject({
      expected: { kind: "hit", payloadType: "binary", payloadHex: "" },
    });
    decoded.input.bytes[9] = integer(1);
    decoded.result.payloadType = "string";
    expect(vectorsFromTrace(raw).untrackedDecodeVectors![0]).toMatchObject({
      expected: { kind: "hit", payloadType: "string", payloadUtf8: "" },
    });
    decoded.result.payloadType = "inferred";
    expect(() => vectorsFromTrace(raw)).toThrow(/Invalid modeled payload type/);
  });
  it("requires the whole input inventory and initialization", () => {
    const missing = trace(); missing.states.pop();
    expect(() => vectorsFromTrace(missing)).toThrow(/Incomplete frame vector history/);
    const duplicate = trace(); duplicate.states[2]!.input.id = integer(0);
    expect(() => vectorsFromTrace(duplicate)).toThrow(/duplicate frame case/);
    const uninitialized = trace(); uninitialized.states[0]!.input.command = "encode";
    expect(() => vectorsFromTrace(uninitialized)).toThrow(/initialization/);
  });
  it("rejects malformed commands, fields and representation bytes", () => {
    const unknown = trace(); unknown.states[1]!.input.command = "invented";
    expect(() => vectorsFromTrace(unknown)).toThrow(/Unknown primitive command/);
    const extra = trace(); Object.assign(extra.states[1]!.input, { expectedBytes: [] });
    expect(() => vectorsFromTrace(extra)).toThrow(/complete primitive request/);
    const bytes = trace(); bytes.states[1]!.result.bytes = [integer(256)];
    expect(() => vectorsFromTrace(bytes)).toThrow(/Invalid bytes/);
  });
  it("rejects fractional encodings and precision loss rather than rounding model input", () => {
    const fractional = trace(); fractional.states[1]!.input.id = integer("0.5");
    expect(() => vectorsFromTrace(fractional)).toThrow(/Malformed ITF integer/);
    const unsafe = trace(); unsafe.states[1]!.input.timestamp.numeratorLow = integer("9007199254740993");
    expect(() => vectorsFromTrace(unsafe)).toThrow(/Inexact native vector integer/);
  });
  it("requires current source provenance for ordinary replay without Quint", () => {
    expect(readGeneratedFrameVectors()).toMatchObject({ schemaVersion: 3, provenance: { model: "formal/dialcache-frame-vectors.qnt" } });
  });
});
