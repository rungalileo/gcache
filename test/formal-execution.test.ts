import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Challenge = { id: string; contract: string; source: string; model: string; invariant: string; before: string; after: string; measures?: string };
type Manifest = {
  check: { maxSamples: number; maxSteps: number; outputDirectory: string };
  libraries: string[];
  challenges: Challenge[];
  models: Array<{
    path: string;
    invariants: string[];
    regressions: string[];
    replayRegressions?: string[];
    profile?: string;
    challengeWaiver?: string;
    generate?: { maxSamples: number; maxSteps: number; traces: number; outputDirectory: string };
    vectorExport?: { generator: string; artifact: string; kind: string; cases: number; sources: string[] };
  }>;
};
type Command = { command: string; args: string[]; outputDirectory?: string; expectedTraces?: number; explicitInputs?: boolean; expectedFiles?: string[]; profile?: string };
const manifest = () => JSON.parse(readFileSync(new URL("../formal/execution.json", import.meta.url), "utf8")) as Manifest;
const moduleUrl = new URL("../formal/execution.mjs", import.meta.url).href;
const runner = fileURLToPath(new URL("../formal/run-models.mjs", import.meta.url));
const { root, scanDeclarations, scanDeclarationBodies, classifyRuns, validateExecution } = await import(moduleUrl) as {
  root: string;
  scanDeclarations(source: string): Map<string, string>;
  scanDeclarationBodies(source: string): Map<string, { kind: string; body: string[] }>;
  classifyRuns(declarations: Map<string, { kind: string; body: string[] }>): { publicOnly: string[]; patching: string[] };
  validateExecution(value: unknown, options?: { readSource(path: string): string }): Record<string, number>;
};
const { checkSemanticCoverage } = await import(new URL("../formal/check-semantic-coverage.mjs", import.meta.url).href) as {
  checkSemanticCoverage(value: unknown): unknown;
};
const { bindExportedTrace } = await import(new URL("../formal/run-models.mjs", import.meta.url).href) as {
  bindExportedTrace(profile: string, text: string, path: string): void;
};
// Exercise pure metadata checks directly: large catalogs must not depend on
// synchronous stdin pipes. The CLI dry-run check below still tests the launcher.
const validate = (value: unknown) => validateExecution(value);

describe("formal execution schedule", () => {
  it("accounts for all models, selected invariants, regressions, generated traces and challenges without Quint", () => {
    expect(validate(manifest())).toEqual({ models: 32, libraries: 5, profiles: 15, invariants: 215, regressions: 401,
      generatedTraces: 5280, exportedRegressionTraces: 234, vectorModels: 4, generatedVectors: 1631,
      challenges: 64, distinctFaults: 62, challengedModels: 32, waivedModels: 0 });
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

  it("classifies profile runs as public-only or state-patching through fixtures, comments and strings", () => {
    const source = `module example {
      var s: int
      var input: { name: str, choice: int }
      action init = all { input' = { name: "init", choice: -1 }, s' = 0 }
      action publicStep = all { input' = { name: "publicStep", choice: -1 }, s' = s + 1 }
      action recorded(code: int): bool = all { input' = if (code == 0) { name: "a", choice: 0 } else { name: "b", choice: 1 }, s' = code }
      action patch(value: int): bool = all { input' = input, s' = value }
      action fixture = init.then(patch(5))
      def helper = s == 5
      action step = publicStep
      // run commentedTest = init.then(all { s' = 9 })
      run publicTest = init.then(publicStep).then(recorded(1)).expect(s == 1)
      run stringTest = init.then(publicStep).expect(s == 1 and "s' = 9" != "")
      run inlinePatchTest = init.then(all { input' = input, s' = 9 }).expect(s == 9)
      run fixtureTest = fixture.then(publicStep).expect(helper == false)
      run inlineStateOnlyTest = init.then(s' = 9).expect(s == 9)
    }`;
    expect(classifyRuns(scanDeclarationBodies(source))).toEqual({
      publicOnly: ["publicTest", "stringTest"],
      patching: ["inlinePatchTest", "fixtureTest", "inlineStateOnlyTest"],
    });
    const current = manifest();
    for (const model of current.models.filter(model => model.profile)) {
      const runs = classifyRuns(scanDeclarationBodies(readFileSync(root + model.path, "utf8")));
      expect([...runs.publicOnly].sort(), model.path).toEqual([...model.replayRegressions!].sort());
    }
    expect(current.models.find(model => model.profile === "effects")!.replayRegressions).toHaveLength(40);
    expect(current.models.find(model => model.profile === "shadow")!.replayRegressions).toHaveLength(7);
    expect(current.models.find(model => model.profile === "independent")!.replayRegressions).toHaveLength(6);
  });

  it("forces every public-only run to be exported and keeps state-patching runs out of replay", () => {
    const unexported = manifest();
    const core = unexported.models.find(model => model.profile === "core")!;
    const dropped = core.replayRegressions!.pop()!;
    expect(() => validate(unexported)).toThrow(new RegExp(`public-only runs are not exported as replay regressions: ${dropped}`));
    const patched = manifest();
    const effects = patched.models.find(model => model.profile === "effects")!;
    effects.replayRegressions!.push("followerKeepsAcceptedReadBudgetTest");
    expect(() => validate(patched)).toThrow(/state-patching runs cannot be replay regressions: followerKeepsAcceptedReadBudgetTest/);
  });

  it("rejects an exported regression whose choice leaves the driver domain at export time", () => {
    const smoke = readFileSync(root + "formal/local-failure-smoke.itf.json", "utf8");
    expect(() => bindExportedTrace("local-failure", smoke, "smoke")).not.toThrow();
    const trace = JSON.parse(smoke) as { states: Array<Record<string, any>> };
    const step = trace.states.find(state => state.input.name === "beginCall")!;
    step.input.choice["#bigint"] = "7";
    step["mbt::nondetPicks"].choice.value["#bigint"] = "7";
    expect(() => bindExportedTrace("local-failure", JSON.stringify(trace), "regression")).toThrow(/regression step \d+: unsupported explicit choice/);
    const renamed = JSON.parse(smoke) as { states: Array<Record<string, any>> };
    renamed.states.find(state => state.input.name === "beginCall")!.input.name = "inventedAction";
    expect(() => bindExportedTrace("local-failure", JSON.stringify(renamed), "regression")).toThrow(/unknown or misplaced action|conflicting action metadata/);
  });

  it("validates every challenge against contracts, scheduled invariants and unique anchors", () => {
    const unknownContract = manifest();
    unknownContract.challenges[0]!.contract = "C99";
    expect(() => validate(unknownContract)).toThrow(/unknown contract C99/);
    const duplicateId = manifest();
    duplicateId.challenges[1]!.id = duplicateId.challenges[0]!.id;
    expect(() => validate(duplicateId)).toThrow(/Invalid or duplicate challenge id/);
    const missingAnchor = manifest();
    missingAnchor.challenges[0]!.before = "this text is not in the model";
    expect(() => validate(missingAnchor)).toThrow(/mutation anchor must match exactly once/);
    const ambiguousAnchor = manifest();
    const rules = ambiguousAnchor.challenges.find(challenge => challenge.source === "formal/cache-rules.qnt")!;
    rules.before = "pure def";
    expect(() => validate(ambiguousAnchor)).toThrow(/mutation anchor must match exactly once/);
    const unscheduledInvariant = manifest();
    unscheduledInvariant.challenges[0]!.invariant = "unscheduledInvariant";
    expect(() => validate(unscheduledInvariant)).toThrow(/is not a scheduled invariant/);
    const foreignSource = manifest();
    foreignSource.challenges[0]!.source = "src/index.ts";
    expect(() => validate(foreignSource)).toThrow(/not a scheduled model or library/);
    const libraryModel = manifest();
    libraryModel.challenges[0]!.model = "formal/cache-rules.qnt";
    expect(() => validate(libraryModel)).toThrow(/challenged model is not scheduled/);
    const noop = manifest();
    noop.challenges[0]!.after = noop.challenges[0]!.before;
    expect(() => validate(noop)).toThrow(/mutation must change the source/);
    const repeated = manifest();
    const { measures: _ignored, ...first } = repeated.challenges[0]!;
    repeated.challenges.push({ ...first, id: "repeated-fault" });
    expect(() => validate(repeated)).toThrow(/repeated-fault: repeats the fault of .* without a measures note/);
    repeated.challenges.at(-1)!.measures = "Measures the same fault against a second invariant.";
    expect(validate(repeated).distinctFaults).toBe(validate(manifest()).distinctFaults);
    const strayNote = manifest();
    strayNote.challenges.find(challenge => !challenge.measures)!.measures = "not a repeat";
    expect(() => validate(strayNote)).toThrow(/a measures note is only for a repeated fault/);
  });

  it("requires a challenge for every scheduled model unless the model carries an explicit waiver", () => {
    const uncovered = manifest();
    const target = uncovered.models.find(model => model.path === "formal/dialcache-core.qnt")!;
    uncovered.challenges = uncovered.challenges.filter(challenge => challenge.model !== target.path);
    expect(() => validate(uncovered)).toThrow(/dialcache-core\.qnt: scheduled invariants have no model property challenge and no challengeWaiver/);
    target.challengeWaiver = "   ";
    expect(() => validate(uncovered)).toThrow(/challenge waiver must explain an unchallenged model/);
    target.challengeWaiver = "No compiling single-site fault is detectable by the scheduled invariants.";
    expect(validate(uncovered)).toMatchObject({ challengedModels: 31, waivedModels: 1 });
    const redundantWaiver = manifest();
    redundantWaiver.models[0]!.challengeWaiver = "Already challenged.";
    expect(() => validate(redundantWaiver)).toThrow(/challenge waiver must explain an unchallenged model/);
    const legacy = manifest();
    (legacy.models[2] as Record<string, unknown>).propertyChallenge = "formal/check-model-properties.mjs";
    expect(() => validate(legacy)).toThrow(/property challenges live in the manifest challenges catalog/);
  });

  it("keeps vector artifacts separate from profile histories and validates their provenance boundary", () => {
    for (const changed of [
      (v: NonNullable<Manifest["models"][number]["vectorExport"]>) => { v.generator = "formal/../outside.mjs"; },
      (v: NonNullable<Manifest["models"][number]["vectorExport"]>) => { v.artifact = ".formal-traces/derived.json"; },
      (v: NonNullable<Manifest["models"][number]["vectorExport"]>) => { v.kind = "unknown"; },
      (v: NonNullable<Manifest["models"][number]["vectorExport"]>) => { v.sources = v.sources.filter(path => path !== v.generator); },
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
    expect(scanDeclarationBodies(source).get("init")!.body).toEqual(["=", "{", "val", "nested", "=", "true", "nested", "}"]);
    expect(() => scanDeclarations("module broken { /* unfinished")).toThrow(/Unterminated/);
    expect(() => scanDeclarations('module broken { val text = "unfinished')).toThrow(/Unterminated/);
    expect(() => scanDeclarations("module broken {} { val forged = true }")).toThrow(/outside the Quint module/);
  });

  it("accepts formatted real declarations and rejects a scheduled invariant hidden in a comment", () => {
    const real = manifest();
    // Reformat declaration keywords that no challenge anchor spans; anchors
    // are deliberately checked against the same source text as declarations.
    expect(validateExecution(real, { readSource: path =>
      readFileSync(root + path, "utf8").replace(/\b(run|action)\s+/g, "$1\n    "),
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

  it("preserves ordered execution, per-profile budgets, seed override, and one closing challenge run", () => {
    const dryRun = (mode: string) => JSON.parse(execFileSync(process.execPath, [runner, mode, "--dry-run"], {
      env: { ...process.env, QUINT_SEED: "0x1234" }, stdio: ["pipe", "pipe", "pipe"],
    }).toString()) as Command[];
    const check = dryRun("check");
    expect(check.filter(job => job.args[0] === "typecheck").map(job => job.args[1])).toEqual(manifest().models.map(model => model.path));
    expect(check.filter(job => job.args[0] === "test").map(job => job.args[1])).toEqual(
      manifest().models.filter(model => model.regressions.length).map(model => model.path),
    );
    // The catalog mutates several models; it runs once after every model has
    // been checked unmodified, never interleaved with a model's own schedule.
    expect(check.filter(job => job.command === "node")).toEqual([{ command: "node", args: ["formal/check-model-properties.mjs"] }]);
    expect(check.at(-1)!.args).toEqual(["formal/check-model-properties.mjs"]);
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
      expect(job.profile).toBe(model.profile);
      expect(job.args).toEqual(expect.arrayContaining(["--max-samples=1", "--seed=0x1234", `--match=^(${model.replayRegressions!.join("|")})$`]));
    }
    expect(generated[0]!.args).toEqual(expect.arrayContaining(["--max-samples=256", "--max-steps=30", "--seed=0x1234"]));
    expect(sampled.find(job => job.outputDirectory === ".formal-traces/features/layers")!.args).toEqual(expect.arrayContaining(["--max-samples=2048", "--max-steps=80"]));
  });
});
