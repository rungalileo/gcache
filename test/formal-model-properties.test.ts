import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const { validatePropertyResult } = await import(new URL("../formal/check-model-properties.mjs", import.meta.url).href) as {
  validatePropertyResult(result: unknown, exitCode: number, expectation: string): void;
};
const { modelPropertyChallenges } = await import(new URL("../formal/model-property-challenges.mjs", import.meta.url).href) as {
  modelPropertyChallenges: Array<{ id: string; source: string; model: string; invariant: string; before: string; after: string }>;
};

describe("model property challenge evidence", () => {
  it("accepts a successful baseline and a compiling initial-state invariant counterexample", () => {
    expect(() => validatePropertyResult({ status: "ok", errors: [], trace: [{}] }, 0, "baseline")).not.toThrow();
    expect(() => validatePropertyResult({ status: "violation", errors: [], trace: [{}] }, 1, "mutant")).not.toThrow();
  });
  it("rejects survivors, unexpected exits and broken baselines", () => {
    expect(() => validatePropertyResult({ status: "ok", errors: [], trace: [{}] }, 0, "mutant")).toThrow(/survived/);
    expect(() => validatePropertyResult({ status: "violation", errors: [], trace: [{}] }, 2, "mutant")).toThrow(/invariant violation/);
    expect(() => validatePropertyResult({ status: "violation", errors: [], trace: [{}] }, 1, "baseline")).toThrow(/Unmodified/);
  });
  it("never credits evaluator failures or missing counterexamples", () => {
    for (const result of [null, {}, { status: "violation", errors: ["type error"], trace: [{}] },
      { status: "violation", errors: [], trace: [] }, { status: "violation", trace: [{}] }]) {
      expect(() => validatePropertyResult(result, 1, "mutant")).toThrow(/not property evidence/);
    }
    expect(() => validatePropertyResult({ status: "ok", errors: [], trace: [{}] }, 0, "unknown")).toThrow(/Unknown/);
  });
  it("keeps unique compiling-fault anchors and named independent target properties", () => {
    expect(new Set(modelPropertyChallenges.map(challenge => challenge.id)).size).toBe(modelPropertyChallenges.length);
    for (const challenge of modelPropertyChallenges) {
      const source = readFileSync(new URL(`../${challenge.source}`, import.meta.url), "utf8");
      const model = readFileSync(new URL(`../${challenge.model}`, import.meta.url), "utf8");
      expect(source.split(challenge.before), challenge.id).toHaveLength(2);
      expect(challenge.after, challenge.id).not.toBe(challenge.before);
      expect(model, challenge.id).toMatch(new RegExp(`\\bval ${challenge.invariant}\\b`));
    }
  });
});
