import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Manifest = {
  check: { maxSamples: number; maxSteps: number; outputDirectory: string };
  libraries: string[];
  models: Array<{
    path: string;
    invariants: string[];
    regressions: string[];
    replayRegressions?: string[];
    profile?: string;
    generate?: { maxSamples: number; maxSteps: number; traces: number; outputDirectory: string };
    vectorExport?: { generator: string; artifact: string; kind: string; cases: number; sources: string[] };
  }>;
};
type Command = { command: string; args: string[]; outputDirectory?: string; expectedTraces?: number; explicitInputs?: boolean; expectedFiles?: string[] };
const manifest = () => JSON.parse(readFileSync(new URL("../formal/execution.json", import.meta.url), "utf8")) as Manifest;
const moduleUrl = new URL("../formal/execution.mjs", import.meta.url).href;
const runner = fileURLToPath(new URL("../formal/run-models.mjs", import.meta.url));
const { root, scanDeclarations, validateExecution } = await import(moduleUrl) as {
  root: string;
  scanDeclarations(source: string): Map<string, string>;
  validateExecution(value: unknown, options?: { readSource(path: string): string }): unknown;
};
const { checkSemanticCoverage } = await import(new URL("../formal/check-semantic-coverage.mjs", import.meta.url).href) as {
  checkSemanticCoverage(value: unknown): unknown;
};
// Exercise pure metadata checks directly: large catalogs must not depend on
// synchronous stdin pipes. The CLI dry-run check below still tests the launcher.
const validate = (value: unknown) => validateExecution(value);

describe("formal execution schedule", () => {
  it("accounts for all models, selected invariants, regressions, and generated traces without Quint", () => {
    expect(validate(manifest())).toEqual({ models: 26, libraries: 3, profiles: 15, invariants: 189, regressions: 388,
      generatedTraces: 5280, exportedRegressionTraces: 165, vectorModels: 4, generatedVectors: 1631 });
  });

  it("rejects omitted models and dropped or renamed regressions", () => {
    const missingModel = manifest();
    missingModel.models.shift();
    expect(() => validate(missingModel)).toThrow(/file inventory changed/);
    const hiddenModel = manifest();
    hiddenModel.libraries.push(hiddenModel.models.shift()!.path);
    expect(() => validate(hiddenModel)).toThrow(/stateful model/);
    const missingTest = manifest();
    missingTest.models[0]!.regressions.pop();
    expect(() => validate(missingTest)).toThrow(/regression schedule/);
    const renamedTest = manifest();
    renamedTest.models[0]!.regressions[0] = "renamedWithoutSuffix";
    expect(() => validate(renamedTest)).toThrow(/Test suffix/);
  });

  it("rejects invalid exploration bounds and unsafe generation output paths", () => {
    for (const bound of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = manifest();
      invalid.check.maxSteps = bound;
      expect(() => validate(invalid)).toThrow(/positive bound/);
    }
    const tooManyTraces = manifest();
    const generation = tooManyTraces.models.find(model => model.generate)!.generate!;
    generation.traces = generation.maxSamples + 1;
    expect(() => validate(tooManyTraces)).toThrow(/trace count exceeds/);
    const unsafe = manifest();
    unsafe.models.find(model => model.generate)!.generate!.outputDirectory = ".formal-traces/features/../../formal";
    expect(() => validate(unsafe)).toThrow(/unsafe or duplicate/);
  });

  it("requires replay regressions to be scheduled tests with explicit input declarations", () => {
    const unscheduled = manifest();
    unscheduled.models.find(model => model.replayRegressions)!.replayRegressions = ["inventedTest"];
    expect(() => validate(unscheduled)).toThrow(/replay regressions need declared input and scheduled tests/);
    const duplicate = manifest();
    const model = duplicate.models.find(model => model.replayRegressions)!;
    model.replayRegressions!.push(model.replayRegressions![0]!);
    expect(() => validate(duplicate)).toThrow(/replay regressions inventory/);
    const real = manifest();
    expect(() => validateExecution(real, { readSource: path =>
      readFileSync(root + path, "utf8").replace(/\bvar input\b/g, "var hiddenInput"),
    })).toThrow(/replay regressions need declared input and scheduled tests/);
  });

  it("keeps vector artifacts separate from profile histories and validates their provenance boundary", () => {
    for (const changed of [
      (v: NonNullable<Manifest["models"][number]["vectorExport"]>) => { v.generator = "formal/../outside.mjs"; },
      (v: NonNullable<Manifest["models"][number]["vectorExport"]>) => { v.artifact = ".formal-traces/derived.json"; },
      (v: NonNullable<Manifest["models"][number]["vectorExport"]>) => { v.kind = "unknown"; },
      (v: NonNullable<Manifest["models"][number]["vectorExport"]>) => { v.sources.pop(); },
      (v: NonNullable<Manifest["models"][number]["vectorExport"]>) => { v.sources.push("src/key.ts"); },
    ]) {
      const invalid = manifest();
      changed(invalid.models.find(model => model.vectorExport)!.vectorExport!);
      expect(() => validate(invalid)).toThrow(/invalid vector export boundary/);
    }
    for (const cases of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = manifest();
      invalid.models.find(model => model.vectorExport)!.vectorExport!.cases = cases;
      expect(() => validate(invalid)).toThrow(/positive bound/);
    }
    const overlap = manifest();
    overlap.models.find(model => model.generate)!.vectorExport = overlap.models.find(model => model.vectorExport)!.vectorExport!;
    expect(() => validate(overlap)).toThrow(/invalid vector export boundary/);
    const duplicate = manifest();
    const vectors = duplicate.models.filter(model => model.vectorExport);
    vectors[1]!.vectorExport!.artifact = vectors[0]!.vectorExport!.artifact;
    expect(() => validate(duplicate)).toThrow(/Duplicate vector generator or artifact/);
  });

  it("scans declarations across whitespace while ignoring comments, strings, and nested values", () => {
    const source = `module example {
      // val falseEvidence = true
      /* run falseTest = init.expect(true) */
      pure val text = "run forgedTest = { val forged = true }"
      val\n        invariant = true
      action init = { val nested = true nested }
      run /* intervening comment */\n        witnessTest = init.expect(invariant)
    }`;
    expect([...scanDeclarations(source)]).toEqual([
      ["text", "val"], ["invariant", "val"], ["init", "action"], ["witnessTest", "run"],
    ]);
    expect(() => scanDeclarations("module broken { /* unfinished")).toThrow(/Unterminated/);
    expect(() => scanDeclarations('module broken { val text = "unfinished')).toThrow(/Unterminated/);
    expect(() => scanDeclarations("module broken {} { val forged = true }")).toThrow(/outside the Quint module/);
  });

  it("accepts formatted real declarations and rejects a scheduled invariant hidden in a comment", () => {
    const real = manifest();
    expect(validateExecution(real, { readSource: path =>
      readFileSync(root + path, "utf8").replace(/\b(val|run)\s+/g, "$1\n    "),
    })).toEqual(validate(real));
    expect(() => validateExecution(real, { readSource: path => {
      const source = readFileSync(root + path, "utf8");
      return path === real.models[0]!.path
        ? source.replace("val " + real.models[0]!.invariants[0], "// val " + real.models[0]!.invariants[0])
        : source;
    } })).toThrow(/scheduled invariant is not a declared val/);
  });

  it("rejects semantic evidence that names an existing but unscheduled helper", () => {
    const catalog = JSON.parse(readFileSync(new URL("../formal/semantic-cases.json", import.meta.url), "utf8"));
    catalog.cases[0].models = ["formal/dialcache-core.qnt:callScopeLive"];
    expect(() => checkSemanticCoverage(catalog)).toThrow(/not scheduled for execution/);
  });

  it("preserves ordered execution, per-profile budgets, seed override, and the model challenge", () => {
    const dryRun = (mode: string) => JSON.parse(execFileSync(process.execPath, [runner, mode, "--dry-run"], {
      env: { ...process.env, QUINT_SEED: "0x1234" }, stdio: ["pipe", "pipe", "pipe"],
    }).toString()) as Command[];
    const check = dryRun("check");
    expect(check.filter(job => job.args[0] === "typecheck").map(job => job.args[1])).toEqual(manifest().models.map(model => model.path));
    expect(check.filter(job => job.args[0] === "test").map(job => job.args[1])).toEqual(
      manifest().models.filter(model => model.regressions.length).map(model => model.path),
    );
    const challenge = check.findIndex(job => job.command === "node");
    expect(check[challenge - 1]!.args.slice(0, 2)).toEqual(["test", "formal/dialcache-coalescing-liveness.qnt"]);
    expect(check[challenge]!.args).toEqual(["formal/check-model-properties.mjs"]);
    for (const job of check.filter(job => job.args[0] === "run")) {
      expect(job.args).toEqual(expect.arrayContaining(["--backend=rust", "--n-threads=1", "--seed=0x1234", "--max-samples=2000", "--max-steps=40"]));
    }
    const generated = dryRun("generate");
    const vectors = generated.filter(job => job.command === "node");
    expect(vectors.map(job => job.args)).toEqual(
      manifest().models.filter(model => model.vectorExport).map(model => [model.vectorExport!.generator, "--check"]),
    );
    // A vector export verifies a committed artifact. It must never inherit the
    // sampled-directory cleanup contract or rewrite expected vectors in CI.
    for (const job of vectors) {
      expect(job.outputDirectory).toBeUndefined();
      expect(job.expectedTraces).toBeUndefined();
      expect(job.args).not.toContain("--write");
    }
    const sampled = generated.filter(job => job.args[0] === "run");
    expect(sampled.map(job => [job.outputDirectory, job.expectedTraces])).toEqual(
      manifest().models.filter(model => model.generate).map(model => [model.generate!.outputDirectory, model.generate!.traces]),
    );
    const regressions = generated.filter(job => job.args[0] === "test");
    expect(regressions).toHaveLength(manifest().models.filter(model => model.replayRegressions).length);
    for (const job of regressions) {
      const model = manifest().models.find(model => model.path === job.args[1])!;
      expect(job.outputDirectory).toBe(`.formal-traces/regressions/${model.profile}`);
      expect(job.expectedFiles).toEqual(model.replayRegressions!.map(name => `${name}.itf.json`));
      expect(job.expectedTraces).toBe(model.replayRegressions!.length);
      expect(job.explicitInputs).toBe(true);
      expect(job.args).toEqual(expect.arrayContaining(["--max-samples=1", "--seed=0x1234", `--match=^(${model.replayRegressions!.join("|")})$`]));
    }
    expect(generated[0]!.args).toEqual(expect.arrayContaining(["--max-samples=256", "--max-steps=30", "--seed=0x1234"]));
    expect(sampled.find(job => job.outputDirectory === ".formal-traces/features/layers")!.args).toEqual(expect.arrayContaining(["--max-samples=2048", "--max-steps=80"]));
  });
});
