import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../formal/check-feature-coverage.mjs", import.meta.url));
const inventory = JSON.parse(readFileSync(new URL("../formal/feature-coverage.json", import.meta.url), "utf8")) as {
  features: Array<{ id: string; cases: string[]; nativeCases: string[]; contracts: string[] }>;
  nativeCases: Array<{ id: string; go: Array<{ path: string; test: string; scope: string }>; typescript: Array<{ path: string; test: string; scope: string }> }>;
};
const check = (value: unknown) => execFileSync(process.execPath, [script, "--stdin"], {
  input: JSON.stringify(value), stdio: ["pipe", "pipe", "pipe"],
}).toString();

describe("feature and native case accounting", () => {
  it("accounts for every semantic case and validates native tests in both languages", () => {
    const result = JSON.parse(check(inventory));
    expect(result.features).toBe(inventory.features.length);
    expect(result.nativeCases).toBe(inventory.nativeCases.length);
  });
  it("rejects a feature map that silently omits one portable case", () => {
    const broken = structuredClone(inventory);
    for (const feature of broken.features) feature.cases = feature.cases.filter(id => id !== "C01.no-cache-plumbing");
    expect(() => check(broken)).toThrow(/Cases missing from feature inventory/);
  });
  it("rejects an unassigned native case even when its test references are valid", () => {
    const broken = structuredClone(inventory);
    for (const feature of broken.features) feature.nativeCases = feature.nativeCases.filter(id => id !== broken.nativeCases[0]!.id);
    expect(() => check(broken)).toThrow(/Native cases missing from feature inventory/);
  });
  it.each(["typescript", "go"] as const)("rejects a nonexistent %s test rather than crediting the file", language => {
    const broken = structuredClone(inventory);
    broken.nativeCases[0]![language][0]!.test = "TestThisDoesNotExist";
    expect(() => check(broken)).toThrow(/unknown (TypeScript|Go) test/);
  });
  it("rejects duplicate feature rows", () => {
    const broken = structuredClone(inventory);
    broken.features.push(broken.features[0]!);
    expect(() => check(broken)).toThrow(/Invalid feature/);
  });
});
