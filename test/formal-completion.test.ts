import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const { checkCompletion, fingerprint, conformanceInventory, defaultSources } = await import(new URL("../formal/conformance.mjs", import.meta.url).href);
const { nativeBinding, parseTypeScriptReport } = await import(new URL("../formal/conformance-adapters.mjs", import.meta.url).href);
type Entry = { id: string; category: string; profile?: string; path?: string; name?: string; feature?: string; group?: string };
const inventory = conformanceInventory() as Entry[];
const context = () => ({ schemaVersion: 1, language: "third-port", runId: "e702fcba-42cc-4fbc-9a57-7ac556162d96", createdAt: 1,
  specification: { "formal/model.qnt": "a".repeat(64) }, implementation: { "third-port/cache": "b".repeat(64) },
  corpus: { "trace.itf.json": "c".repeat(64) }, inventory: [{ id: "sampled/core/0", category: "sampled" }, { id: "witness/effects", category: "witness" }] });
const completed = (ctx = context()) => ({ schemaVersion: 1, language: ctx.language, runId: ctx.runId, contextSha256: fingerprint(ctx),
  startedAt: 2, finishedAt: 3, status: "passed", nativeReportSha256: "d".repeat(64), results: ctx.inventory.map(c => ({ id: c.id, status: "passed" })) });
const check = (report: unknown, ctx = context()) => checkCompletion(report, ctx, { current: false });

function nativeReport() {
  const suites = new Map<string, { name: string; status: string; startTime: number; endTime: number; message: string; assertionResults: Array<{ ancestorTitles: string[]; title: string; fullName: string; status: string; failureMessages: string[] }> }>();
  for (const entry of inventory) {
    const [file, fullName] = nativeBinding(entry, "typescript") as [string, string];
    if (!suites.has(file)) suites.set(file, { name: `/test/${file}`, status: "passed", startTime: 2, endTime: 3, message: "", assertionResults: [] });
    suites.get(file)!.assertionResults.push({ ancestorTitles: [], title: fullName, fullName, status: "passed", failureMessages: [] });
  }
  return { success: true, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0, numPendingTestSuites: 0,
    numTotalTests: inventory.length, numPassedTests: inventory.length, startTime: 1, testResults: [...suites.values()] };
}

describe("portable completion contract", () => {
  it("binds Go's shared definitions, fixtures and consumed witness evidence", () => {
    const inputs = new Set(defaultSources("go") as string[]);
    const profiles = JSON.parse(readFileSync("formal/profiles.json", "utf8")) as { profiles: Array<{ id: string; witnessSources?: string[] }> };
    const lock = JSON.parse(readFileSync("formal/generated-fixtures.lock.json", "utf8")) as { artifacts: Record<string, string> };
    const shared = ["src/prometheus.ts", "test/formal/coverage-evidence.ts", "test/formal/runtime-witnesses.ts", "test/formal/recovery-shadow-witnesses.ts",
      ...profiles.profiles.flatMap(profile => profile.witnessSources ?? []), ...Object.keys(lock.artifacts)];
    for (const path of shared.filter(path => !path.startsWith("formal/"))) expect(inputs.has(path), path).toBe(true);
    for (const profile of profiles.profiles.filter(profile => profile.id !== "core")) {
      expect(inputs.has(`.formal-traces/go-parity-witnesses/${profile.id}.json`), profile.id).toBe(true);
    }
  });
  it("accepts an additional language without adding language-specific test names", () => {
    expect(check(completed())).toMatchObject({ language: "third-port", status: "passed", cases: 2 });
  });
  it("rejects missing, extra, duplicate, failed and skipped case results", () => {
    const missing = completed(); missing.results.pop(); expect(() => check(missing)).toThrow(/Missing/);
    const extra = completed(); extra.results.push(extra.results[0]!); expect(() => check(extra)).toThrow(/extra/);
    const duplicate = completed(); duplicate.results[1] = duplicate.results[0]!; expect(() => check(duplicate)).toThrow(/duplicate/);
    for (const status of ["failed", "skipped", "running"]) {
      const report = completed(); report.results[0]!.status = status; expect(() => check(report)).toThrow(/Failed/);
    }
  });
  it("rejects a different port, run, implementation or corpus identity", () => {
    for (const key of ["language", "runId", "contextSha256"] as const) {
      const report = completed(); report[key] = "different"; expect(() => check(report)).toThrow(/context/);
    }
    const source = context(); source.implementation["third-port/cache"] = "e".repeat(64);
    expect(() => check(completed(), source)).toThrow(/context/);
    const corpus = context(); corpus.corpus["trace.itf.json"] = "f".repeat(64);
    expect(() => check(completed(), corpus)).toThrow(/context/);
  });
  it("rejects a historical native run relabeled with a newly prepared context", () => {
    const ctx = { ...context(), createdAt: 5 };
    expect(() => check(completed(ctx), ctx)).toThrow(/stale/);
    expect(() => check({ ...completed(), finishedAt: 1 })).toThrow(/stale/);
    expect(() => check({ ...completed(), nativeReportSha256: "" })).toThrow(/fingerprint/);
  });
  it("requires the full inventory from actual TypeScript assertion records", () => {
    expect(parseTypeScriptReport(JSON.stringify(nativeReport()), inventory).results).toHaveLength(inventory.length);
    for (const category of ["sampled", "regression", "scenario", "protocol", "witness"]) {
      const report = nativeReport(), entry = inventory.find(c => c.category === category)!;
      const [file, name] = nativeBinding(entry, "typescript") as [string, string];
      const suite = report.testResults.find(s => s.name.endsWith(file))!;
      suite.assertionResults = suite.assertionResults.filter(a => a.fullName !== name);
      report.numTotalTests--; report.numPassedTests--;
      expect(() => parseTypeScriptReport(JSON.stringify(report), inventory)).toThrow(/Missing/);
    }
  });
  it("cannot turn skipped, duplicate or collection-failed TypeScript runs into passes", () => {
    const skipped = nativeReport(); skipped.testResults[0]!.assertionResults[0]!.status = "pending";
    expect(() => parseTypeScriptReport(JSON.stringify(skipped), inventory)).toThrow(/skipped/);
    const duplicate = nativeReport(); duplicate.testResults[0]!.assertionResults.push(duplicate.testResults[0]!.assertionResults[0]!);
    expect(() => parseTypeScriptReport(JSON.stringify(duplicate), inventory)).toThrow(/Duplicate/);
    const collection = nativeReport(); collection.testResults[0]!.status = "failed";
    expect(() => parseTypeScriptReport(JSON.stringify(collection), inventory)).toThrow(/suite/);
  });
});
