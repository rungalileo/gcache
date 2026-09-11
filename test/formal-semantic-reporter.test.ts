import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const moduleUrl = new URL("../formal/semantic-reporter.mjs", import.meta.url).href;
const { evaluateSemanticTestReport } = await import(moduleUrl) as {
  evaluateSemanticTestReport(data: unknown, execution: unknown, exitCode: number | null): {
    state: string; passed: number; failed: number; failingTests: string[];
  };
};

it("requires executed assertions and distinguishes detection from infrastructure failures", () => {
  const workspace = mkdtempSync(join(tmpdir(), "dialcache-semantic-reporter-"));
  const dependencies = fileURLToPath(new URL("../node_modules", import.meta.url));
  const reporter = fileURLToPath(new URL("../formal/semantic-reporter.mjs", import.meta.url));
  try {
    symlinkSync(dependencies, join(workspace, "node_modules"), "dir");
    writeFileSync(join(workspace, "vitest.config.mjs"), 'export default { test: { include: ["probe.test.mjs"] } };');
    const run = (source: string, pattern?: string) => {
      writeFileSync(join(workspace, "probe.test.mjs"), source);
      rmSync(join(workspace, "tests.json"), { force: true });
      rmSync(join(workspace, "meta.json"), { force: true });
      const result = spawnSync(process.execPath, [join(dependencies, "vitest/vitest.mjs"), "run",
        ...(pattern ? [`--testNamePattern=${pattern}`] : []),
        "--reporter=json", `--reporter=${reporter}`, "--outputFile=tests.json"], {
        cwd: workspace, encoding: "utf8", timeout: 15_000,
        env: { ...process.env, DIALCACHE_SEMANTIC_RUN_META: join(workspace, "meta.json") },
      });
      expect(result.error).toBeUndefined();
      const data: unknown = JSON.parse(readFileSync(join(workspace, "tests.json"), "utf8"));
      const execution = JSON.parse(readFileSync(join(workspace, "meta.json"), "utf8")) as {
        reason: string; collectionErrors: string[]; unhandledErrors: string[];
      };
      return { status: result.status, execution, evaluate: () => evaluateSemanticTestReport(data, execution, result.status) };
    };
    const passingSource = 'import { it, expect } from "vitest"; it("correct value", () => expect(1).toBe(1));';
    const baseline = run(passingSource);
    expect(baseline.status).toBe(0);
    expect(baseline.evaluate()).toEqual({ state: "survived", passed: 1, failed: 0, failingTests: [] });

    const assertion = run('import { it, expect } from "vitest"; it("wrong value", () => expect(1).toBe(2));');
    expect(assertion.status).toBe(1);
    expect(assertion.execution).toEqual({ reason: "failed", collectionErrors: [], unhandledErrors: [] });
    expect(assertion.evaluate()).toEqual({ state: "detected", passed: 0, failed: 1, failingTests: ["wrong value"] });

    const infrastructure = run(`import { beforeAll, describe, it } from "vitest";
      describe("broken suite", () => { beforeAll(() => { throw new Error("collection probe"); }); it("never executes", () => {}); });
      it("unhandled work", async () => { setTimeout(() => { throw new Error("unhandled probe"); }, 0); await new Promise(resolve => setTimeout(resolve, 30)); });`);
    expect(infrastructure.status).toBe(1);
    expect(infrastructure.execution.reason).toBe("failed");
    expect(infrastructure.execution.collectionErrors).toContain("collection probe");
    expect(infrastructure.execution.unhandledErrors).toContain("unhandled probe");
    expect(infrastructure.evaluate).toThrow(/infrastructure\/import error, not evidence of detection/);

    for (const empty of [run(passingSource, "^no-matching-test$"),
      run('import { it } from "vitest"; it.skip("skipped assertion", () => { throw new Error("must remain skipped"); });')]) {
      expect(empty.status).toBe(0);
      expect(empty.execution).toEqual({ reason: "passed", collectionErrors: [], unhandledErrors: [] });
      expect(empty.evaluate).toThrow(/infrastructure\/import error.*passed=0, failed=0/);
    }
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}, 30_000);
