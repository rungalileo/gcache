import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Challenge = { id: string; contract: string; source: string; model: string; invariant: string; before: string; after: string; measures?: string };
const { validatePropertyResult, selectChallenges } = await import(new URL("../formal/check-model-properties.mjs", import.meta.url).href) as {
  validatePropertyResult(result: unknown, exitCode: number, expectation: string): void;
  selectChallenges(manifest: { challenges: Challenge[] }, only?: string): Challenge[];
};
const manifest = JSON.parse(readFileSync(new URL("../formal/execution.json", import.meta.url), "utf8")) as { challenges: Challenge[] };

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
  it("reads the catalog from the execution manifest and selects only known challenge ids", () => {
    expect(selectChallenges(manifest)).toBe(manifest.challenges);
    const [first, second] = manifest.challenges;
    expect(selectChallenges(manifest, `${second!.id},${first!.id}`)).toEqual([first, second]);
    expect(() => selectChallenges(manifest, `${first!.id},invented-fault`)).toThrow(/Unknown model property challenges: invented-fault/);
  });
  it("keeps unique compiling-fault anchors and named independent target properties", () => {
    expect(new Set(manifest.challenges.map(challenge => challenge.id)).size).toBe(manifest.challenges.length);
    for (const challenge of manifest.challenges) {
      const source = readFileSync(new URL(`../${challenge.source}`, import.meta.url), "utf8");
      const model = readFileSync(new URL(`../${challenge.model}`, import.meta.url), "utf8");
      expect(source.split(challenge.before), challenge.id).toHaveLength(2);
      expect(challenge.after, challenge.id).not.toBe(challenge.before);
      expect(model, challenge.id).toMatch(new RegExp(`\\bval ${challenge.invariant}\\b`));
    }
  });
});
