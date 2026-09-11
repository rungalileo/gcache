import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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

  it("orders generation, TypeScript witness completion and Go preparation without duplicate wire generation", () => {
    const plan = validationPlan("formal", { directory });
    const position = (script: string, argument: string) => plan.findIndex(step => step.args?.[0] === script && step.args.includes(argument));
    const tsPrepare = position("formal/conformance.mjs", "typescript");
    const goPrepare = position("formal/conformance.mjs", "go");
    const tsCompletion = position("formal/conformance.mjs", ".formal-traces/ts-completion.json");
    expect(position("formal/run-models.mjs", "check")).toBeLessThan(position("formal/run-models.mjs", "generate"));
    expect(position("formal/run-models.mjs", "generate")).toBeLessThan(tsPrepare);
    expect(tsPrepare).toBeLessThan(tsCompletion);
    expect(tsCompletion).toBeLessThan(goPrepare);
    expect(plan.filter(step => step.args?.[0] === "formal/run-models.mjs" && step.args[1] === "generate")).toHaveLength(1);
    expect(plan.some(step => step.args?.[0] === "formal/generate-artifacts.mjs")).toBe(false);
    expect(plan[0]!.remove).toEqual([".formal-traces/ts-completion.json", ".formal-traces/go-completion.json"]);
  });

  it("requires current reports before mutations and never silently runs formal generation", async () => {
    const ts = validationPlan("mutations-ts", { directory });
    const go = validationPlan("mutations-go", { directory });
    const all = validationPlan("mutations", { directory });
    expect(ts[0]!.args).toContain(".formal-traces/ts-completion.json");
    expect(ts.some(step => step.args?.includes(".formal-traces/go-completion.json"))).toBe(false);
    expect(go[0]!.args).toContain(".formal-traces/ts-completion.json");
    expect(go[1]!.args).toContain(".formal-traces/go-completion.json");
    expect(all[0]!.args).toContain(".formal-traces/ts-completion.json");
    expect(all[1]!.args).toContain(".formal-traces/go-completion.json");
    expect(all.some(step => step.args?.includes("formal/run-models.mjs"))).toBe(false);
    put("formal/conformance.mjs", "process.exit(2);\n");
    put("formal/measure-semantics.mjs", `import ${JSON.stringify(child)};\n`);
    await expect(run(ts)).rejects.toThrow(/Run make formal first/);
    expect(() => events()).toThrow(/ENOENT/);
  });

  it("fails full-CI prerequisites before execution when the exact floor runtime is missing or wrong", () => {
    expect(() => checkPrerequisites("ci", { directory, environment, nodeVersion: "v24.20.0" })).toThrow(/Set NODE22_BIN=/);
    environment.NODE22_BIN = fakeTool("node22", 'console.log("v22.16.0")');
    expect(() => checkPrerequisites("ci", { directory, environment, nodeVersion: "v24.20.0" })).toThrow(/exact Node 22.15.0/);
    environment.NODE22_BIN = fakeTool("node22", 'console.log("v22.15.0")');
    expect(() => checkPrerequisites("ci", { directory, environment, nodeVersion: "v24.20.0" })).not.toThrow();
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
