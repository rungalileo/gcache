import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type Step = {
  label: string;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  stdoutFile?: string;
  requireEmptyStdout?: boolean;
  remove?: string[];
  requireFile?: string;
  failureHint?: string;
};
type Options = { directory?: string; environment?: NodeJS.ProcessEnv; runnerNode?: string; nodeVersion?: string };
const { validationPlan, executeSteps, checkPrerequisites } = await import(
  new URL("../formal/validation.mjs", import.meta.url).href,
) as {
  validationPlan(target: string, options?: Options): Step[];
  executeSteps(steps: Step[], options?: Options & { log?: (message: string) => void }): Promise<void>;
  checkPrerequisites(target: string, options?: Options): void;
};

describe("shared validation runner", () => {
  let directory: string;
  let child: string;
  let environment: NodeJS.ProcessEnv;
  const put = (path: string, text: string) => writeFileSync(join(directory, path), text);
  const events = () => readFileSync(join(directory, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as {
    label: string; cwd: string; selected: Record<string, string>; path: string; retained: string;
  });
  const fakeTool = (name: string, body: string) => {
    const path = join(directory, "bin", name);
    writeFileSync(path, `#!${process.execPath}\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const run = (steps: Step[]) => executeSteps(steps, { directory, environment, log: () => undefined });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "dialcache-validation-"));
    for (const path of ["bin", "formal", "dist", "node_modules/typescript"]) mkdirSync(join(directory, path), { recursive: true });
    child = join(directory, "child.mjs");
    put("child.mjs", `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.RUNNER_EVENTS, JSON.stringify({ label: process.argv[2], cwd: process.cwd(),
  selected: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('DIALCACHE_') || key === 'QUINT_SEED')),
  path: process.env.PATH, retained: process.env.RUNNER_RETAINED }) + '\\n');
if (process.argv[4]) process.stdout.write(process.argv[4]);
process.exit(Number(process.argv[3] ?? 0));\n`);
    environment = { ...process.env, RUNNER_EVENTS: join(directory, "events.jsonl"), RUNNER_RETAINED: "caller-owned",
      DIALCACHE_MBT_TRACE_FILE: "/unrelated/one-file.json", DIALCACHE_FEATURE_TRACE_DIR: "/unrelated/corpus",
      DIALCACHE_PROTOCOL_CORPUS: "fixed", DIALCACHE_WITNESS_EVIDENCE_DIR: "/unrelated/witnesses", QUINT_SEED: "0xbad" };
    delete environment.NODE22_BIN;
    put("package.json", '{"packageManager":"pnpm@10.33.0"}');
    put("node_modules/typescript/package.json", "{}");
    put("formal/generated-fixtures.lock.json", '{"quintVersion":"0.32.0"}');
    fakeTool("corepack", 'console.log("10.33.0")');
    fakeTool("go", 'console.log("go version go1.27.1 test/test")');
    fakeTool("quint", 'console.log("0.32.0")');
    fakeTool("java", 'console.log("openjdk 21.0.11")');
    fakeTool("tar", 'console.log("bsdtar 3.5.3")');
    fakeTool("docker", 'console.log("running")');
    environment.PATH = `${join(directory, "bin")}${delimiter}${process.env.PATH ?? ""}`;
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("removes inherited replay selectors but passes the planned full-corpus environment to real children", async () => {
    const complete = validationPlan("formal", { directory, environment }).find(step => step.label === "Replay complete Go corpus with race detection")!;
    await run([
      { label: "default", command: process.execPath, args: [child, "default"] },
      { label: "full", command: process.execPath, args: [child, "full"], env: complete.env! },
    ]);
    const [ordinary, full] = events();
    expect(ordinary).toMatchObject({ cwd: realpathSync(directory), selected: {}, retained: "caller-owned" });
    expect(full!.selected).toEqual({
      DIALCACHE_MBT_TRACE_DIR: join(directory, ".formal-traces/conformance"),
      DIALCACHE_EFFECTS_TRACE_DIR: join(directory, ".formal-traces/effects"),
      DIALCACHE_FEATURE_TRACE_DIR: join(directory, ".formal-traces/features"),
      DIALCACHE_WITNESS_EVIDENCE_DIR: join(directory, ".formal-traces/go-parity-witnesses"),
    });
  });

  it("stops at a failing child and preserves its partial native report without running later steps", async () => {
    const steps: Step[] = [
      { label: "first", command: process.execPath, args: [child, "first"] },
      { label: "failed native replay", command: process.execPath, args: [child, "failure", "7", "partial report\n"], stdoutFile: ".formal-traces/report.jsonl", failureHint: "Run the prerequisite first." },
      { label: "must not run", command: process.execPath, args: [child, "after"] },
    ];
    await expect(run(steps)).rejects.toThrow(/failed native replay failed \(exit 7\).*Run the prerequisite first/);
    expect(events().map(event => event.label)).toEqual(["first", "failure"]);
    expect(readFileSync(join(directory, ".formal-traces/report.jsonl"), "utf8")).toBe("partial report\n");
  });

  it("rejects formatting output even when the formatting command exits successfully", async () => {
    await expect(run([{ label: "formatting", command: process.execPath, args: [child, "format", "0", "go/cache.go\n"], requireEmptyStdout: true }]))
      .rejects.toThrow(/files requiring formatting:\ngo\/cache.go/);
  });

  it("orders generation and shared witness evaluation before both port replays without duplicate wire generation", () => {
    const plan = validationPlan("formal", { directory });
    const position = (script: string, argument: string) => plan.findIndex(step => step.args?.[0] === script && step.args.includes(argument));
    const tsPrepare = position("formal/conformance.mjs", "typescript");
    const goPrepare = position("formal/conformance.mjs", "go");
    const tsCompletion = position("formal/conformance.mjs", ".formal-traces/ts-completion.json");
    const witnesses = position("formal/witnesses.mjs", "evaluate");
    expect(position("formal/run-models.mjs", "check")).toBeLessThan(position("formal/run-models.mjs", "generate"));
    expect(position("formal/run-models.mjs", "generate")).toBeLessThan(witnesses);
    expect(witnesses).toBeLessThan(tsPrepare);
    expect(tsPrepare).toBeLessThan(tsCompletion);
    expect(tsCompletion).toBeLessThan(goPrepare);
    expect(plan.filter(step => step.args?.[0] === "formal/run-models.mjs" && step.args[1] === "generate")).toHaveLength(1);
    expect(plan.filter(step => step.args?.[0] === "formal/witnesses.mjs")).toHaveLength(1);
    expect(plan.some(step => step.args?.[0] === "formal/generate-artifacts.mjs")).toBe(false);
    expect(plan[0]!.args).toEqual(["formal/run-models.mjs", "check"]);
    expect(plan[1]!.remove).toEqual([".formal-traces/ts-completion.json", ".formal-traces/go-completion.json"]);
    // The aggregate is exactly the four lanes in order, so a CI job running
    // one lane executes the same steps as the local sequential run.
    expect(plan).toEqual(["formal-check", "formal-generate", "formal-ts", "formal-go"].flatMap(target => validationPlan(target, { directory })));
  });

  it("keeps the model check as its own lane that produces nothing the port lanes consume", () => {
    // The check (typechecks, bounded runs, regressions and challenges) is
    // evidence about Quint; generation is the only producer downstream reads.
    expect(validationPlan("formal-check", { directory })).toEqual([
      { label: "Check every scheduled Quint model", command: process.execPath, args: ["formal/run-models.mjs", "check"] },
    ]);
    const generate = validationPlan("formal-generate", { directory });
    expect(generate.some(step => step.args?.[0] === "formal/run-models.mjs" && step.args[1] === "check")).toBe(false);
    expect(generate.some(step => step.args?.[0] === "formal/check-model-properties.mjs")).toBe(false);
    for (const target of ["formal-ts", "formal-go", "mutations"]) {
      expect(validationPlan(target, { directory }).some(step => step.args?.[0] === "formal/run-models.mjs")).toBe(false);
    }
    // ci keeps requiring the check through the aggregate; nothing else adds a second one.
    expect(validationPlan("ci", { directory }).filter(step => step.args?.[0] === "formal/run-models.mjs" && step.args[1] === "check")).toHaveLength(1);
  });

  it("ends generation with the shared witness evaluation and starts each replay lane from a prepared context", () => {
    const generate = validationPlan("formal-generate", { directory });
    expect(generate.at(-1)!.args).toEqual(["formal/witnesses.mjs", "evaluate", "--profile", "all"]);
    expect(generate.map(step => step.args?.slice(0, 2))).toEqual([undefined, ["formal/run-models.mjs", "generate"],
      ["formal/generated-fixtures.mjs", "--check"], ["formal/witnesses.mjs", "evaluate"]]);
    expect(generate.some(step => step.args?.[0] === "formal/conformance.mjs")).toBe(false);
    expect(generate.some(step => step.command === "corepack" || step.command === "go")).toBe(false);
    const ts = validationPlan("formal-ts", { directory });
    expect(ts[0]!.remove).toEqual([".formal-traces/ts-completion.json"]);
    expect(ts[1]!.args).toEqual(["formal/conformance.mjs", "prepare", "typescript", ".formal-traces/ts-context.json"]);
    expect(ts.at(-1)!.args).toEqual(["formal/conformance.mjs", "check", ".formal-traces/ts-completion.json", ".formal-traces/ts-context.json"]);
    expect(ts.some(step => step.args?.[0] === "formal/witnesses.mjs" || step.args?.[0] === "formal/run-models.mjs")).toBe(false);
  });

  it("lets Go parity and both mutation measurements run off the generated corpus without completion checks", () => {
    const isCompletionCheck = (step: Step) => step.args?.[0] === "formal/conformance.mjs" && step.args[1] === "check";
    const go = validationPlan("formal-go", { directory });
    expect(go[0]!.remove).toEqual([".formal-traces/go-completion.json"]);
    expect(go.some(step => step.args?.some(argument => argument.startsWith(".formal-traces/ts-")))).toBe(false);
    expect(go.filter(isCompletionCheck).map(step => step.args)).toEqual([["formal/conformance.mjs", "check", ".formal-traces/go-completion.json", ".formal-traces/go-context.json"]]);
    expect(go.some(step => step.args?.[0] === "formal/witnesses.mjs" || step.args?.[0] === "formal/run-models.mjs")).toBe(false);
    for (const [target, script] of [["mutations-ts", "formal/measure-semantics.mjs"], ["mutations-go", "formal/measure-go-semantics.mjs"]] as const) {
      expect(validationPlan(target, { directory }).map(step => step.args)).toEqual([[script]]);
    }
    const all = validationPlan("mutations", { directory });
    expect(all.map(step => step.args?.[0])).toEqual(["formal/measure-semantics.mjs", "formal/measure-go-semantics.mjs"]);
    expect(all.some(isCompletionCheck)).toBe(false);
    expect(all.some(step => step.remove || step.args?.[0] === "formal/run-models.mjs")).toBe(false);
  });

  it("requires Quint only for generation and recomputation, not for replay or mutation lanes", () => {
    fakeTool("quint", 'console.error("quint: not installed"); process.exit(1)');
    for (const target of ["formal-check", "formal-generate", "formal", "fixtures-check", "explore", "ci"]) {
      expect(() => checkPrerequisites(target, { directory, environment, nodeVersion: "v24.20.0" })).toThrow(/Cannot run quint/);
    }
    for (const target of ["formal-ts", "formal-go", "mutations-ts", "mutations-go", "mutations"]) {
      expect(() => checkPrerequisites(target, { directory, environment, nodeVersion: "v24.20.0" })).not.toThrow();
    }
    fakeTool("go", 'console.error("go: not installed"); process.exit(1)');
    for (const target of ["formal-ts", "mutations-ts"]) {
      expect(() => checkPrerequisites(target, { directory, environment, nodeVersion: "v24.20.0" })).not.toThrow();
    }
    for (const target of ["formal-go", "mutations-go"]) {
      expect(() => checkPrerequisites(target, { directory, environment, nodeVersion: "v24.20.0" })).toThrow(/Cannot run go/);
    }
  });

  it("fails full-CI prerequisites before execution when the exact floor runtime is missing or wrong", () => {
    expect(() => checkPrerequisites("ci", { directory, environment, nodeVersion: "v24.20.0" })).toThrow(/Set NODE22_BIN=/);
    environment.NODE22_BIN = fakeTool("node22", 'console.log("v22.16.0")');
    expect(() => checkPrerequisites("ci", { directory, environment, nodeVersion: "v24.20.0" })).toThrow(/exact Node 22.15.0/);
    environment.NODE22_BIN = fakeTool("node22", 'console.log("v22.15.0")');
    expect(() => checkPrerequisites("ci", { directory, environment, nodeVersion: "v24.20.0" })).not.toThrow();
  });

  it("isolates Java and symbolic checks from corpus generation and exploration", () => {
    fakeTool("java", 'console.log("openjdk 17.0.12")');
    for (const target of ["model-check", "ci"]) {
      expect(() => checkPrerequisites(target, { directory, environment, nodeVersion: "v24.20.0" })).toThrow(/requires Java 21/);
    }
    for (const target of ["check-ts", "formal", "formal-check", "formal-generate", "formal-ts", "explore"]) {
      expect(() => checkPrerequisites(target, { directory, environment, nodeVersion: "v24.20.0" })).not.toThrow();
      expect(validationPlan(target, { directory }).some(step => step.args?.[0] === "formal/check-symbolic-models.mjs")).toBe(false);
    }
    expect(validationPlan("ci", { directory }).filter(step => step.args?.[0] === "formal/check-symbolic-models.mjs")).toHaveLength(1);
    fakeTool("java", 'console.log("openjdk 21.0.11 2026-04-21 LTS")');
    expect(() => checkPrerequisites("model-check", { directory, environment, nodeVersion: "v24.20.0" })).not.toThrow();
    // The pinned Apalache archive is unpacked with tar; only the symbolic lane needs it.
    fakeTool("tar", 'console.error("tar: not available"); process.exit(1)');
    for (const target of ["model-check", "ci"]) {
      expect(() => checkPrerequisites(target, { directory, environment, nodeVersion: "v24.20.0" })).toThrow(/requires tar to unpack the pinned Apalache archive/);
    }
    for (const target of ["check-ts", "formal", "formal-check", "formal-generate", "formal-ts", "explore"]) {
      expect(() => checkPrerequisites(target, { directory, environment, nodeVersion: "v24.20.0" })).not.toThrow();
    }
  });

  it("allows the standalone floor target on Node 22.15 and propagates its PATH without reintroducing selectors", async () => {
    const floor = fakeTool("node22", `if (process.argv[2] === '--version') console.log('v22.15.0');
else {
  process.argv[2] = process.argv[2] === '--eval' ? 'floor-zstd' : 'floor-package';
  process.argv.length = 3;
  await import(${JSON.stringify(child)});
}`);
    expect(() => checkPrerequisites("package-floor", { directory, environment, runnerNode: floor, nodeVersion: "v22.15.0" })).not.toThrow();
    put("dist/index.js", "export {};\n");
    await run(validationPlan("package-floor", { directory, environment, runnerNode: floor, nodeVersion: "v22.15.0" }));
    expect(events().map(event => event.label)).toEqual(["floor-zstd", "floor-package"]);
    for (const event of events()) {
      expect(event.path.split(delimiter)[0]).toBe(dirname(floor));
      expect(event.selected).toEqual({});
    }
  });

  it("rejects unsupported runtime and tool versions with setup instructions", () => {
    expect(() => checkPrerequisites("check", { directory, environment, nodeVersion: "v22.15.0" })).toThrow(/requires Node 24/);
    fakeTool("corepack", 'console.log("9.0.0")');
    expect(() => checkPrerequisites("check-ts", { directory, environment, nodeVersion: "v24.20.0" })).toThrow(/pinned pnpm 10.33.0/);
    fakeTool("corepack", 'console.log("10.33.0")');
    fakeTool("go", 'console.log("go version go1.26.0 test/test")');
    expect(() => checkPrerequisites("check-go", { directory, environment, nodeVersion: "v24.20.0" })).toThrow(/Go 1.27.1/);
  });
});

describe("full formal workflow shape", () => {
  type Step = { name?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, string> };
  type Job = { needs?: string | string[]; steps: Step[] };
  const lanes = ["typescript-parity", "go-parity", "typescript-mutations", "go-mutations"];
  const needsOf = (job: Job) => (job.needs === undefined ? [] : [job.needs].flat());
  let jobs: Record<string, Job>;

  beforeEach(async () => {
    // yaml is not a project dependency and vitest does not declare it: it is in
    // the lockfile only transitively (testcontainers via docker-compose, and
    // vite's optional peer), and pnpm hoists every transitive package into
    // node_modules/.pnpm/node_modules, which a require rooted at vitest's real
    // store path walks up into while a bare import from this file cannot.
    // Name the remedy if a dependency bump ever drops it from the tree.
    let yamlPath: string;
    try {
      yamlPath = createRequire(createRequire(import.meta.url).resolve("vitest/package.json")).resolve("yaml");
    } catch {
      throw new Error("The workflow shape tests parse YAML; add yaml as a devDependency now that no other package brings it in.");
    }
    const { parse } = await import(pathToFileURL(yamlPath).href) as { parse(text: string): { jobs: Record<string, Job> } };
    jobs = parse(readFileSync(new URL("../.github/workflows/formal-full.yaml", import.meta.url), "utf8")).jobs;
  });

  it("runs the model check beside generation so the port and mutation lanes wait only for the corpus", () => {
    expect(needsOf(jobs["check-models"]!)).toEqual([]);
    expect(needsOf(jobs.generate!)).toEqual([]);
    expect(jobs["check-models"]!.steps.map(step => step.run).filter(Boolean)).toEqual(["make formal-check"]);
    expect(jobs.generate!.steps.map(step => step.run).filter(Boolean)).toEqual(["make formal-generate"]);
    for (const lane of lanes) expect(needsOf(jobs[lane]!), lane).toEqual(["generate"]);
  });

  it("requires the model check in the aggregate and retains its report in the long-lived summary", () => {
    const aggregate = jobs["formal-full"]!;
    expect(needsOf(aggregate)).toEqual(expect.arrayContaining(["check-models", "generate", ...lanes]));
    const gate = aggregate.steps.find(step => step.run?.includes("_RESULT"))!;
    expect(gate.env).toMatchObject({ CHECK_MODELS_RESULT: "${{ needs.check-models.result }}" });
    expect(gate.run).toMatch(/test "\$CHECK_MODELS_RESULT" = success/);
    const evidence = jobs["check-models"]!.steps.find(step => step.uses?.startsWith("actions/upload-artifact"))!.with!;
    expect(evidence.name).toBe("model-check-evidence");
    expect(evidence.path!.trim().split("\n").map(line => line.trim())).toEqual([".formal-traces/verification/", ".formal-traces/model-properties/"]);
    expect(aggregate.steps.some(step => step.uses?.startsWith("actions/download-artifact") && step.with?.name === "model-check-evidence")).toBe(true);
    const summary = aggregate.steps.find(step => step.uses?.startsWith("actions/upload-artifact"))!.with!;
    expect(summary.path).toContain("formal-summary/model-check/model-properties/report.json");
  });
});
