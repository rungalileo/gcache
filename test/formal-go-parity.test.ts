import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Ledger = {
  status: string;
  inventory: { sourceDeclarations: number; requiredWitnesses: number; casesWithQuintRegressionReplay: number };
  sourceInventory: Array<{
    path: string;
    sha256: string;
    declarations: unknown[];
    candidateGoFiles: string[];
    mappingReview: { goBindings: Array<{ path: string; sha256: string; symbols: string[] }> };
  }>;
  profiles: Array<{ id: string; version: number; status: string; scheduledRegressions: string[]; witnessSources: string[] }>;
  cases: Array<{ id: string; status: string; quintReplays: string[]; generatedVectors: Array<{ artifact: string; group?: string; name: string }> }>;
  vectorExports: Array<{ model: string; artifactSha256: string }>;
  sourceDeclarationScope: {
    limitations: string;
    nativeBindingAdaptations: Array<{ id: string; rationale: string }>;
  };
  reviewedTestAndDocumentationAudit: { limitations: string };
};

const ledger = () => JSON.parse(readFileSync(new URL("../formal/go-parity.json", import.meta.url), "utf8")) as Ledger;
const checker = new URL("../formal/check-go-parity.mjs", import.meta.url).href;
// Keep the large ledger in-process: a synchronous child reading a piped JSON
// input can stall on host pipe transfer. These assertions test the exported
// accounting checker, so a subprocess adds no behavioral coverage.
const { checkGoParity: validate } = await import(checker) as {
  checkGoParity(input: Ledger): unknown;
};

describe("Go parity ledger freshness", () => {
  it("validates reviewed inventory without claiming executed parity", () => {
    expect(validate(ledger())).toMatchObject({
      kind: "accounting-and-freshness", sourceFiles: 27, declarations: 772,
      reviewedTestsAndDocs: 44, semanticCases: 262, profiles: 15, vectorModels: 4,
      meaning: "Fresh reviewed mappings and inventory snapshots; execution evidence remains separately assessed.",
    });
  });

  it("rejects stale TypeScript and Go source hashes", () => {
    const typescript = ledger();
    typescript.sourceInventory[0]!.sha256 = "0".repeat(64);
    expect(() => validate(typescript)).toThrow(/source hash changed/);
    const go = ledger();
    go.sourceInventory[0]!.mappingReview.goBindings[0]!.sha256 = "0".repeat(64);
    expect(() => validate(go)).toThrow(/reviewed Go implementation changed/);
  });

  it("rejects a missing Go file or renamed referenced symbol", () => {
    const missingFile = ledger();
    missingFile.sourceInventory[0]!.candidateGoFiles[0] = "go/missing.go";
    missingFile.sourceInventory[0]!.mappingReview.goBindings[0]!.path = "go/missing.go";
    expect(() => validate(missingFile)).toThrow(/missing or invalid repository path go\/missing.go/);
    const missingSymbol = ledger();
    missingSymbol.sourceInventory[0]!.mappingReview.goBindings[0]!.symbols[0] = "MissingPolicySymbol";
    expect(() => validate(missingSymbol)).toThrow(/no longer declares MissingPolicySymbol/);
  });

  it("rejects dropped declarations even when the count is adjusted", () => {
    const input = ledger();
    input.sourceInventory[0]!.declarations.pop();
    input.inventory.sourceDeclarations--;
    expect(() => validate(input)).toThrow(/declaration inventory\/navigation changed/);
  });

  it("rejects stale profile and semantic case inventories", () => {
    const profile = ledger();
    profile.profiles[0]!.version++;
    expect(() => validate(profile)).toThrow(/profile version\/model\/smoke differs/);
    const cases = ledger();
    cases.cases.pop();
    expect(() => validate(cases)).toThrow(/Semantic case inventory\/order differs/);
    const witnesses = ledger();
    witnesses.profiles.find(row => row.witnessSources.length > 0)!.witnessSources.pop();
    expect(() => validate(witnesses)).toThrow(/witness source inventory is stale/);
  });

  it("requires explicit native binding rationale without upgrading prose edits to evidence", () => {
    const missing = ledger();
    missing.sourceDeclarationScope.nativeBindingAdaptations[0]!.rationale = "";
    expect(() => validate(missing)).toThrow(/native binding rationale missing/);
    const prose = ledger();
    const statuses = prose.cases.map(row => row.status);
    prose.sourceDeclarationScope.limitations += " Additional editorial clarification does not execute a test.";
    prose.reviewedTestAndDocumentationAudit.limitations += " Evidence is assessed separately.";
    expect(validate(prose)).toMatchObject({ kind: "accounting-and-freshness" });
    expect(prose.cases.map(row => row.status)).toEqual(statuses);
  });

  it("rejects omitted scheduled Quint regression evidence", () => {
    const input = ledger();
    input.cases.find(row => row.quintReplays.length > 0)!.quintReplays.pop();
    expect(() => validate(input)).toThrow(/model-driven replay\/vector references are stale/);
    const schedule = ledger();
    schedule.profiles.find(row => row.scheduledRegressions.length > 0)!.scheduledRegressions.pop();
    expect(() => validate(schedule)).toThrow(/scheduled regression histories are stale/);
  });

  it("rejects omitted generated primitive vectors and stale artifact identity", () => {
    const input = ledger();
    input.cases.find(row => row.generatedVectors.length > 0)!.generatedVectors.pop();
    expect(() => validate(input)).toThrow(/model-driven replay\/vector references are stale/);
    const artifact = ledger();
    artifact.vectorExports[0]!.artifactSha256 = "0".repeat(64);
    expect(() => validate(artifact)).toThrow(/artifact fingerprint is stale/);
    const inventory = ledger();
    inventory.vectorExports.pop();
    expect(() => validate(inventory)).toThrow(/Generated vector model inventory\/order differs/);
  });

  it("distinguishes referenced witnesses from the complete required gate", () => {
    const input = ledger(); input.inventory.requiredWitnesses--;
    expect(() => validate(input)).toThrow(/Required\/referenced witness inventory is stale/);
  });

  it("does not promote executable schedules to completed run evidence", () => {
    const input = ledger(); input.profiles[0]!.status = "passed-shared-corpus";
    expect(() => validate(input)).toThrow(/must not claim a completed replay/);
  });
});
