import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const moduleUrl = new URL("../formal/check-semantic-coverage.mjs", import.meta.url).href;
const { checkSemanticCoverage, checkProfiles } = await import(moduleUrl) as {
  checkSemanticCoverage(value: unknown): unknown;
  checkProfiles(value: unknown): unknown;
};
const inventory = JSON.parse(readFileSync(new URL("../formal/semantic-cases.json", import.meta.url), "utf8")) as {
  cases: Array<{ id: string; rule: string; scenarios: string[]; models: string[]; vectors: string[]; generated: Array<{ profile: string; witness: string }>; quintReplays?: string[]; generatedVectors?: Array<{ artifact: string; group?: string; name: string }>; gap?: string }>;
};
const check = (value: unknown) => JSON.stringify(checkSemanticCoverage(value));

describe("semantic coverage accounting", () => {
  it("rejects incompatible profile registries and schema drift", () => {
    const registry = JSON.parse(readFileSync(new URL("../formal/profiles.json", import.meta.url), "utf8"));
    expect(() => checkProfiles(registry)).not.toThrow();
    expect(() => checkProfiles({ ...registry, protocolSchemaVersion: 99 })).toThrow();
    expect(() => checkProfiles({ ...registry, profiles: registry.profiles.slice(1) })).toThrow();
    expect(() => checkProfiles({ ...registry, specificationVersion: "unrecognized" })).toThrow();
  });
  it("resolves contract, scenario, model, vector and witness references", () => {
    const result = JSON.parse(check(inventory));
    expect(result.contracts).toBe(69);
    expect(result.cases.total).toBe(inventory.cases.length);
  });
  it("rejects duplicate cases and missing executable evidence without an explicit gap", () => {
    const duplicate = structuredClone(inventory);
    duplicate.cases.push(duplicate.cases[0]!);
    expect(() => check(duplicate)).toThrow();
    const missing = structuredClone(inventory);
    Object.assign(missing.cases[0]!, { scenarios: [], generated: [], vectors: [], models: [] });
    expect(() => check(missing)).toThrow();
  });
  it("rejects a trace action masquerading as a required behavioral witness", () => {
    const broken = structuredClone(inventory);
    broken.cases[0]!.generated = [{ profile: "shadow", witness: "action:beginCall" }];
    expect(() => check(broken)).toThrow();
  });
  it("rejects dangling scenario and model references", () => {
    const scenario = structuredClone(inventory);
    scenario.cases[0]!.scenarios = ["nonexistent case"];
    expect(() => check(scenario)).toThrow();
    const model = structuredClone(inventory);
    model.cases[0]!.models = ["formal/dialcache-core.qnt:unknownInvariant"];
    expect(() => check(model)).toThrow();
  });
  it("rejects a valid case inventory that silently drops a positive scenario", () => {
    const broken = structuredClone(inventory);
    for (const c of broken.cases) c.scenarios = c.scenarios.filter(name => name !== "disabled calls bypass policy and caches");
    expect(() => check(broken)).toThrow(/Portable scenarios missing from case inventory/);
  });
  it("rejects a protocol group with valid but incomplete vector references", () => {
    const broken = structuredClone(inventory);
    const vectors = JSON.parse(readFileSync(new URL("../formal/protocol-vectors.json", import.meta.url), "utf8"));
    for (const c of broken.cases) c.vectors = c.vectors.map(name => name === "protocol/keyVectors/*"
      ? `protocol/keyVectors/${vectors.keyVectors[0].name}` : name);
    expect(() => check(broken)).toThrow(/Protocol vector missing from case inventory/);
  });
  it("requires every portable case to keep a Quint check and implementation replay", () => {
    const noCheck = structuredClone(inventory);
    Object.assign(noCheck.cases[0]!, { models: [], quintReplays: [], generatedVectors: undefined });
    expect(() => check(noCheck)).toThrow(/requires a scheduled Quint check/);
    const fixedOnly = structuredClone(inventory);
    Object.assign(fixedOnly.cases[0]!, { generated: [], quintReplays: [], generatedVectors: undefined });
    expect(() => check(fixedOnly)).toThrow(/requires Quint-driven implementation replay/);
  });
  it("rejects replay names that are not exported cited Quint tests", () => {
    const broken = structuredClone(inventory);
    broken.cases[0]!.quintReplays = ["policy/doesNotExistTest"];
    expect(() => check(broken)).toThrow(/cited scheduled exported regression/);
  });
  it("rejects missing, wrong-model and duplicate generated vector references", () => {
    for (const change of [
      (c: (typeof inventory.cases)[number]) => { c.generatedVectors![0]!.name = "missing vector"; },
      (c: (typeof inventory.cases)[number]) => { c.models = ["formal/dialcache-core.qnt:closedScopeHasNoRequestValue"]; },
      (c: (typeof inventory.cases)[number]) => { c.generatedVectors!.push(c.generatedVectors![0]!); },
    ]) {
      const broken = structuredClone(inventory);
      change(broken.cases.find(c => c.id === "W01.key-identity")!);
      expect(() => check(broken)).toThrow(/generated vector needs a cited model and exported case/);
    }
  });

});
