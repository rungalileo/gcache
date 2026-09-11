import { describe, expect, it } from "vitest";

const url = new URL("../formal/generate-key-vectors.mjs", import.meta.url).href;
const { expectedCases, vectorsFromTrace, readGeneratedKeyVectors, validateGeneratedKeyVectors } = await import(url) as {
  expectedCases: number;
  vectorsFromTrace(trace: unknown): Record<string, Array<Record<string, unknown>>>;
  readGeneratedKeyVectors(): Record<string, unknown>;
  validateGeneratedKeyVectors(corpus: unknown): unknown;
};
const integer = (n: number | string) => ({ "#bigint": String(n) });
const units = (text: string) => Array.from({ length: text.length }, (_, index) => integer(text.charCodeAt(index)));
const pair = (name: string, value: string) => ({ name: units(name), value: units(value) });
const argument = (name: string, kind: number, text: string, high = 0, low = 0, negative = false) => ({
  name: units(name), kind: integer(kind), text: units(text), integer: integer(0),
  magnitude: [integer(high), integer(low)], negative,
});
function state(id: number) {
  const kind = id < 420 ? 0 : id < 433 ? 1 : 2;
  return {
    input: {
      name: id < 0 ? "init" : kind === 0 ? "key" : kind === 1 ? "normalize" : "cohort",
      caseId: integer(id), kind: integer(kind), label: "converter control",
      key: { namespace: units("urn"), keyType: units("id"), id: units("1"), useCase: units("Get"), tracked: false, args: [] as ReturnType<typeof pair>[] },
      arguments: [] as ReturnType<typeof argument>[], discriminator: kind === 2 ? units("local") : [],
    },
    s: {
      key: { valid: id < 328 || id >= 433, logical: units("model output"), valueKey: units("model value key"), watermark: [] as ReturnType<typeof integer>[] },
      normalized: [] as ReturnType<typeof pair>[], hash: integer(1), below: false, equal: false, above: true,
    },
  };
}
// These deliberately artificial observations test the representation boundary.
// Only actual Quint exports are used for implementation conformance credit.
const trace = () => ({ states: [state(-1), ...Array.from({ length: expectedCases }, (_, id) => state(id))] });

describe("Quint key vector export boundary", () => {
  it("transcribes model keys and hash numerators without executing native algorithms", () => {
    const converted = vectorsFromTrace(trace());
    expect(converted.keyVectors![0]).toMatchObject({ logicalKey: "model output", valueKey: "model value key" });
    expect(converted.rampVectors![0]).toMatchObject({ hashNumerator: 1, sample: (1 / 4294967296) * 100 });
  });
  it("preserves lone surrogate code units for actual language-boundary rejection", () => {
    const raw = trace(); raw.states[329]!.input.key.id = [integer(55296)];
    expect(vectorsFromTrace(raw).invalidKeyVectors![0]).toMatchObject({ input: { id: "\ud800" }, inputUtf16: { id: [55296] } });
  });
  it("reconstructs exact native bigint inputs from signed limbs, independently of output text", () => {
    const raw = trace();
    raw.states[421]!.input.arguments = [argument("n", 6, "", 9007199254, 740991123, true)];
    raw.states[421]!.s.normalized = [pair("n", "observed text")];
    expect(vectorsFromTrace(raw).normalizeArgsVectors![0]).toMatchObject({
      bigintArgs: { n: "-9007199254740991123" }, expected: [["n", "observed text"]],
    });
  });
  it("preserves own prototype-like record names", () => {
    const raw = trace(); raw.states[421]!.input.arguments = [argument("__proto__", 1, "own")];
    const converted = vectorsFromTrace(raw).normalizeArgsVectors![0]!.input as Record<string, unknown>;
    expect(Object.hasOwn(converted, "__proto__")).toBe(true);
    expect(converted.__proto__).toBe("own");
    raw.states[421]!.input.arguments = [argument("__proto__", 6, "", 9007199, 254740992)];
    const bigints = vectorsFromTrace(raw).normalizeArgsVectors![0]!.bigintArgs as Record<string, unknown>;
    expect(Object.hasOwn(bigints, "__proto__")).toBe(true);
    expect(bigints.__proto__).toBe("9007199254740992");
  });
  it("requires initialization, every input, and the declared order", () => {
    const missing = trace(); missing.states.pop();
    expect(() => vectorsFromTrace(missing)).toThrow(/Incomplete/);
    const reordered = trace(); reordered.states[2]!.input.caseId = integer(0);
    expect(() => vectorsFromTrace(reordered)).toThrow(/reordered/);
    const uninitialized = trace(); uninitialized.states[0]!.input.name = "key";
    expect(() => vectorsFromTrace(uninitialized)).toThrow(/initialization/);
  });
  it("rejects missing observations and unknown commands or fields", () => {
    const incomplete = trace(); Reflect.deleteProperty(incomplete.states[1]!.s, "normalized");
    expect(() => vectorsFromTrace(incomplete)).toThrow(/Incomplete key observation/);
    const unknown = trace(); unknown.states[1]!.input.name = "invented";
    expect(() => vectorsFromTrace(unknown)).toThrow(/Unexpected/);
    const extra = trace(); Object.assign(extra.states[1]!.input, { expectedKey: "invented" });
    expect(() => vectorsFromTrace(extra)).toThrow(/Invalid or reordered/);
  });
  it("rejects invalid code units, fractional integers and imprecise numeric inputs", () => {
    const invalid = trace(); invalid.states[1]!.input.key.id = [integer(65536)];
    expect(() => vectorsFromTrace(invalid)).toThrow(/Invalid UTF-16/);
    const fractional = trace(); fractional.states[1]!.input.caseId = integer("0.5");
    expect(() => vectorsFromTrace(fractional)).toThrow(/Invalid ITF integer/);
    const unsafe = trace(); unsafe.states[421]!.input.arguments = [argument("n", 5, "", 9007199, 254740992)];
    expect(() => vectorsFromTrace(unsafe)).toThrow(/Unsafe numeric input/);
    const badLimb = trace(); badLimb.states[421]!.input.arguments = [argument("n", 6, "", 1, 1000000000)];
    expect(() => vectorsFromTrace(badLimb)).toThrow(/Invalid numeric magnitude/);
  });
  it("requires current provenance and complete committed groups", () => {
    const current = readGeneratedKeyVectors();
    expect(current).toMatchObject({ schemaVersion: 3, provenance: { model: "formal/dialcache-key-protocol.qnt" } });
    const stale = structuredClone(current);
    (stale.provenance as { sourceSha256: Record<string, string> }).sourceSha256["formal/dialcache-key-protocol.qnt"] = "0".repeat(64);
    expect(() => validateGeneratedKeyVectors(stale)).toThrow(/Stale Quint/);
    const truncated = structuredClone(current); (truncated.keyVectors as unknown[]).pop();
    expect(() => validateGeneratedKeyVectors(truncated)).toThrow(/Incomplete committed/);
  });
});
