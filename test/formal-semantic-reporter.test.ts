import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps assertion failures distinct from collection and unhandled failures", () => {
  const workspace = mkdtempSync(join(tmpdir(), "dialcache-semantic-reporter-"));
  const dependencies = fileURLToPath(new URL("../node_modules", import.meta.url));
  const reporter = fileURLToPath(new URL("../formal/semantic-reporter.mjs", import.meta.url));
  try {
    symlinkSync(dependencies, join(workspace, "node_modules"), "dir");
    writeFileSync(join(workspace, "vitest.config.mjs"), 'export default { test: { include: ["probe.test.mjs"] } };');
    const run = (source: string) => {
      writeFileSync(join(workspace, "probe.test.mjs"), source);
      const result = spawnSync(process.execPath, [join(dependencies, "vitest/vitest.mjs"), "run",
        "--reporter=json", `--reporter=${reporter}`, "--outputFile=tests.json"], {
        cwd: workspace, encoding: "utf8", timeout: 15_000,
        env: { ...process.env, DIALCACHE_SEMANTIC_RUN_META: join(workspace, "meta.json") },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      return JSON.parse(readFileSync(join(workspace, "meta.json"), "utf8")) as { reason: string; collectionErrors: string[]; unhandledErrors: string[] };
    };
    const assertion = run('import { it, expect } from "vitest"; it("wrong value", () => expect(1).toBe(2));');
    expect(assertion).toEqual({ reason: "failed", collectionErrors: [], unhandledErrors: [] });
    const infrastructure = run(`import { beforeAll, describe, it } from "vitest";
      describe("broken suite", () => { beforeAll(() => { throw new Error("collection probe"); }); it("never executes", () => {}); });
      it("unhandled work", async () => { setTimeout(() => { throw new Error("unhandled probe"); }, 0); await new Promise(resolve => setTimeout(resolve, 30)); });`);
    expect(infrastructure.reason).toBe("failed");
    expect(infrastructure.collectionErrors).toContain("collection probe");
    expect(infrastructure.unhandledErrors).toContain("unhandled probe");
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}, 30_000);
