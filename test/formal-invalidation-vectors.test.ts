import { describe, expect, it } from "vitest";
import {
  readGeneratedInvalidationVectors, validateGeneratedInvalidationVectors, vectorsFromTrace,
  type InvalidationVectorState,
} from "../formal/generate-invalidation-vectors.mjs";

// Re-wrap the committed Quint input/output as ITF solely to challenge the
// representation converter. These controls never add behavioral or mutation
// credit and never compute an invalidation outcome independently of Quint.
const corpus = readGeneratedInvalidationVectors();
const integer = (n: number) => ({ "#bigint": String(n) });
const text = (value: string) => Array.from(value, char => integer(char.codePointAt(0)!));
const redis = (value: InvalidationVectorState) => ({
  kind: integer(value.kind === "absent" ? 0 : value.kind === "string" ? 1 : 2),
  value: text(value.kind === "string" ? value.value : ""),
  values: value.kind === "list" ? value.values.map(text) : [], ttlMs: integer(value.ttlMs),
});
function trace() {
  return { states: [{ input: { name: "init" }, s: undefined }, ...corpus.vectors.map((vector, index) => {
    const [label, priorLabel] = vector.name.slice(`Quint ${String(index).padStart(3, "0")}: `.length).split(" / ");
    return { input: { name: "invalidate", caseId: integer(index), label, priorLabel,
      existing: redis(vector.existing), futureBuffer: text(vector.futureBufferMs), invalidatedAt: text(vector.invalidatedAtMs) },
    s: { outcome: integer(vector.expected.error ? 2 : 1), after: redis(vector.expected.state), remaining: { "#set": [] as Array<ReturnType<typeof integer>> } } };
  })] };
}

describe("Quint invalidation vector export controls", () => {
  it("preserves all actual Quint input/output fields through representation conversion", () => {
    expect(vectorsFromTrace(trace())).toEqual(corpus.vectors);
  });
  it("rejects a missing input combination", () => {
    const raw = trace(); raw.states.pop();
    expect(() => vectorsFromTrace(raw)).toThrow(/Incomplete/);
  });
  it("rejects duplicate case identity even when history length matches", () => {
    const raw = trace(); Object.assign(raw.states[2]!.input, { caseId: integer(0) });
    expect(() => vectorsFromTrace(raw)).toThrow(/duplicate/);
  });
  it("requires an exhausted model input inventory", () => {
    const raw = trace(); raw.states.at(-1)!.s!.remaining = { "#set": [integer(1)] };
    expect(() => vectorsFromTrace(raw)).toThrow(/every declared/);
  });
  it("rejects pending outcomes without an actual transition result", () => {
    const raw = trace(); raw.states[1]!.s!.outcome = integer(0);
    expect(() => vectorsFromTrace(raw)).toThrow(/Invalid or duplicate/);
  });
  it("rejects precision loss while converting a recorded TTL", () => {
    const raw = trace(); raw.states[1]!.s!.after.ttlMs = { "#bigint": "9007199254740993" };
    expect(() => vectorsFromTrace(raw)).toThrow(/Unsafe/);
  });
  it("exports a recorded model result without recalculating its cutoff", () => {
    const raw = trace(); raw.states[1]!.s!.after.value = text("123456");
    expect(vectorsFromTrace(raw)[0]!.expected.state).toEqual({ kind: "string", value: "123456", ttlMs: 7200000 });
  });
  it("rejects stale source provenance without running Quint", () => {
    const stale = structuredClone(corpus);
    stale.provenance.sourceSha256[stale.provenance.model] = "0".repeat(64);
    expect(() => validateGeneratedInvalidationVectors(stale)).toThrow(/Stale Quint/);
  });
  it("rejects truncated committed artifacts without running Quint", () => {
    const incomplete = structuredClone(corpus); incomplete.vectors.pop();
    expect(() => validateGeneratedInvalidationVectors(incomplete)).toThrow(/Incomplete/);
  });
});
