import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const { validateRecipes, verifyFixtures, project, stateDelta, constrainAction } = await import(
  new URL("../formal/generated-fixtures.mjs", import.meta.url).href,
) as {
  validateRecipes(book: unknown): unknown;
  verifyFixtures(): { artifacts: number; histories: number };
  project(value: unknown, mask: unknown): unknown;
  stateDelta(before: unknown, after: unknown): unknown;
  constrainAction(source: string, declaration: unknown, sourceMap: unknown, choice: number): string;
};
const book = () => JSON.parse(readFileSync("formal/fixture-recipes.json", "utf8"));

describe("reproducible Quint fixtures", () => {
  it("binds every committed fixture to its recipes, models and exporter without requiring Quint", () => {
    expect(verifyFixtures()).toEqual({ artifacts: 26, histories: 126 });
  });
  it("rejects missing fixtures, duplicate identities and expected-state recipes", () => {
    const missing = book(); missing.artifacts.pop();
    expect(() => validateRecipes(missing)).toThrow(/inventory/);
    const duplicate = book(); duplicate.artifacts.push(duplicate.artifacts[0]);
    expect(() => validateRecipes(duplicate)).toThrow(/duplicate/);
    const prediction = book(); prediction.artifacts[0].recipes[0].expected = { returned: 1 };
    expect(() => validateRecipes(prediction)).toThrow(/expected state/);
    const privateState = book(); privateState.projections[privateState.artifacts[0].recipes[0].projection] = { value: 42 };
    expect(() => validateRecipes(privateState)).toThrow(/field names only/);
  });
  it("projects only existing output and encodes changes without inventing observations", () => {
    expect(project({ returned: 1, privatePhase: 2 }, { returned: true })).toEqual({ returned: 1 });
    expect(() => project({}, { returned: true })).toThrow(/missing/);
    expect(stateDelta({ o: { calls: [1], reads: 1 } }, { o: { calls: [1, 2], reads: 1 } })).toEqual({ o: { calls: [1, 2] } });
    expect(() => stateDelta({ o: 1 }, {})).toThrow(/remove/);
  });
  it("narrows the original choice domain and preserves guards and assignments", () => {
    const source = "nondet choice = Set(1, 2).oneOf(); all { s < 3, s' = choice }";
    const domainStart = source.indexOf("Set"), domainEnd = source.indexOf(".oneOf");
    const choice = { name: "choice", qualifier: "nondet", expr: { opcode: "oneOf", args: [{ id: 2 }] } };
    const declaration = { kind: "def", qualifier: "action", expr: { id: 1, kind: "let", opdef: choice } };
    const sourceMap = { map: { "1": [0, { index: 0 }, { index: source.length - 1 }], "2": [0, { index: domainStart }, { index: domainEnd - 1 }] } };
    expect(constrainAction(source, declaration, sourceMap, 2)).toContain("Set(1, 2)).intersect(Set(2)).oneOf(); all { s < 3, s' = choice }");
    expect(() => constrainAction(source, declaration, sourceMap, -1)).toThrow(/Missing/);
    expect(() => constrainAction(source, { ...declaration, expr: { ...declaration.expr, second: choice } }, sourceMap, 1)).toThrow(/ambiguous/);
    expect(() => constrainAction(source, { ...declaration, qualifier: "run" }, sourceMap, 1)).toThrow(/public action/);
  });
});
