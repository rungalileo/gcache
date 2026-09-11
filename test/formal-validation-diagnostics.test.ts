import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type Step = { label: string; command: string; args: string[]; stdoutFile?: string };
const { executeSteps } = await import(new URL("../formal/validation.mjs", import.meta.url).href) as {
  executeSteps(steps: Step[], options: { directory: string; log(message: string): void }): Promise<void>;
};

describe("redirected native failure diagnostics", () => {
  let directory: string;
  let messages: string[];
  const report = "reports/native.jsonl";
  const child = (mode: string, code: number): Step => ({
    label: "native validation", command: process.execPath,
    args: [join(directory, "child.mjs"), mode, String(code)], stdoutFile: report,
  });
  const run = (steps: Step[]) => executeSteps(steps, { directory, log: message => messages.push(message) });
  const input = (bytes: string) => writeFileSync(join(directory, "input.txt"), bytes);

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "dialcache-report-diagnostics-"));
    messages = [];
    writeFileSync(join(directory, "child.mjs"), `import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
writeFileSync(1, readFileSync('input.txt'));
if (process.argv[2] === 'remove-report') unlinkSync('${report}');
if (process.argv[2] === 'signal') process.kill(process.pid, 'SIGTERM');
else process.exit(Number(process.argv[3]));
`);
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("shows an early failed Go subtest despite later passes and retains the exact raw report", async () => {
    const events: unknown[] = [];
    for (let i = 0; i < 100; i++) {
      events.push({ Action: "output", Test: `passing/${i}`, Output: "    setup_test.go:9: benign setup log\n" });
      events.push({ Action: "pass", Test: `passing/${i}` });
    }
    events.push({ Action: "output", Test: "TestRedisIntegration/cluster", Output: "    redis_integration_test.go:84: expected café; received empty reply\n" });
    events.push({ Action: "output", Test: "TestRedisIntegration/cluster", Output: "        adapter: primary timed out\n" });
    events.push({ Action: "fail", Test: "TestRedisIntegration/cluster" });
    for (let i = 0; i < 5000; i++) events.push({ Action: "pass", Test: `later-success/${i}` });
    events.push({ Action: "fail", Package: "example/native" });
    const raw = events.map(event => JSON.stringify(event)).join("\n") + "\n";
    input(raw);
    await expect(run([child("exit", 7), {
      label: "must not execute", command: process.execPath,
      args: ["--eval", "require('node:fs').writeFileSync('later-step', 'ran')"],
    }])).rejects.toThrow(/native validation failed \(exit 7\)/);
    const diagnostic = messages.join("\n");
    expect(diagnostic).toContain("Failed: TestRedisIntegration/cluster");
    expect(diagnostic).toContain("redis_integration_test.go:84: expected café; received empty reply");
    expect(diagnostic).toContain("adapter: primary timed out");
    expect(diagnostic).not.toContain("benign setup log");
    expect(diagnostic).not.toContain("later-success");
    expect(diagnostic).toContain(join(directory, report));
    expect(diagnostic.length).toBeLessThan(14_000);
    expect(readFileSync(join(directory, report), "utf8")).toBe(raw);
    expect(existsSync(join(directory, "later-step"))).toBe(false);
  });

  it("bounds malformed oversized output while preserving the original signal and report", async () => {
    const raw = "fatal error: controlled native crash " + "x".repeat(256 * 1024);
    input(raw);
    await expect(run([child("signal", 0)])).rejects.toThrow(/failed \(SIGTERM\)/);
    const diagnostic = messages.join("\n");
    expect(diagnostic).toContain("fatal error: controlled native crash");
    expect(diagnostic).toContain("truncated");
    expect(diagnostic.length).toBeLessThan(14_000);
    expect(readFileSync(join(directory, report), "utf8")).toBe(raw);
  });

  it("falls back to plain output without interpreting it as assertion evidence", async () => {
    input("worker startup\nconnection refused at 127.0.0.1:6379\n");
    await expect(run([child("exit", 3)])).rejects.toThrow(/failed \(exit 3\)/);
    expect(messages.join("\n")).toContain("connection refused at 127.0.0.1:6379");
    expect(messages.join("\n")).not.toContain("expected:");
  });

  it("does not replace the child failure if its diagnostic file becomes unavailable", async () => {
    input("partial report\n");
    await expect(run([child("remove-report", 9)])).rejects.toThrow(/failed \(exit 9\)/);
    expect(messages.join("\n")).toContain("unable to read:");
  });

  it("cannot print stale diagnostics when the current failed child emits no stdout", async () => {
    mkdirSync(join(directory, "reports"));
    writeFileSync(join(directory, report), "fatal error: stale previous report\n");
    input("");
    await expect(run([child("exit", 7)])).rejects.toThrow(/failed \(exit 7\)/);
    expect(messages.join("\n")).toContain("(no stdout captured)");
    expect(messages.join("\n")).not.toContain("stale previous report");
    expect(readFileSync(join(directory, report), "utf8")).toBe("");
  });

  it("keeps successful redirected reports out of the console", async () => {
    const raw = JSON.stringify({ Action: "pass", Test: "native-success" }) + "\n";
    input(raw);
    await run([child("exit", 0)]);
    expect(messages).toEqual(["→ native validation"]);
    expect(readFileSync(join(directory, report), "utf8")).toBe(raw);
  });
});
