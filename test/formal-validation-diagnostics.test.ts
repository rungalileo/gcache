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

  it("falls back to the plain tail and never promotes a passing test's panic-like text to a failure", async () => {
    // Exit status alone fails the step; the excerpt must not invent a failed test.
    const raw = [
      { Action: "run", Test: "TestRecovers" },
      { Action: "output", Test: "TestRecovers", Output: "    recover_test.go:12: panic: recovered deliberately\n" },
      { Action: "pass", Test: "TestRecovers" },
    ].map(event => JSON.stringify(event)).join("\n") + "\nworker startup\nconnection refused at 127.0.0.1:6379\n";
    input(raw);
    await expect(run([child("exit", 3)])).rejects.toThrow(/failed \(exit 3\)/);
    const diagnostic = messages.join("\n");
    expect(diagnostic).toContain("connection refused at 127.0.0.1:6379");
    expect(diagnostic).not.toContain("Failed:");
    expect(diagnostic).not.toContain('"Action"');
    expect(diagnostic).not.toContain("[run TestRecovers]");
    expect(diagnostic).not.toContain("[pass TestRecovers]");
  });

  it("selects a real failure while ignoring panic-like output of a passing test", async () => {
    const raw = [
      { Action: "output", Test: "TestRecovers", Output: "    recover_test.go:12: panic: recovered deliberately\n" },
      { Action: "pass", Test: "TestRecovers" },
      { Action: "output", Test: "TestReal", Output: "    real_test.go:40: expected 3 writes; observed 2\n" },
      { Action: "fail", Test: "TestReal" },
      { Action: "fail", Package: "example/native" },
    ].map(event => JSON.stringify(event)).join("\n") + "\n";
    input(raw);
    await expect(run([child("exit", 1)])).rejects.toThrow(/failed \(exit 1\)/);
    const diagnostic = messages.join("\n");
    expect(diagnostic).toContain("Failed: TestReal");
    expect(diagnostic).toContain("real_test.go:40: expected 3 writes; observed 2");
    expect(diagnostic).not.toContain("recovered deliberately");
    expect(diagnostic).not.toContain("Failed: TestRecovers");
  });

  it("keeps compiler diagnostics from Go build-output events keyed by ImportPath", async () => {
    const importPath = "example/native [example/native.test]";
    const raw = [
      { Action: "build-output", ImportPath: importPath, Output: "# example/native [example/native.test]\n" },
      { Action: "build-output", ImportPath: importPath, Output: "./feature_replay_test.go:88:14: undefined: missingSymbol\n" },
      { Action: "build-output", ImportPath: importPath, Output: "./feature_replay_test.go:91:3: too many arguments in call to replay\n" },
      { Action: "build-fail", ImportPath: importPath },
      { Action: "output", Package: "example/native", Output: "FAIL\texample/native [build failed]\n" },
      { Action: "fail", Package: "example/native" },
    ].map(event => JSON.stringify(event)).join("\n") + "\n";
    input(raw);
    await expect(run([child("exit", 1)])).rejects.toThrow(/failed \(exit 1\)/);
    const diagnostic = messages.join("\n");
    expect(diagnostic).toContain(`Failed: ${importPath}`);
    expect(diagnostic).toContain("./feature_replay_test.go:88:14: undefined: missingSymbol");
    expect(diagnostic).toContain("./feature_replay_test.go:91:3: too many arguments in call to replay");
    expect(diagnostic).toContain("Failed: example/native");
    expect(diagnostic).toContain("[build failed]");
  });

  it("gives each failing subtest its own excerpt budget and counts the overflow", async () => {
    const events: unknown[] = [];
    const noisy = (name: string) => {
      for (let i = 0; i < 60; i++) events.push({ Action: "output", Test: name, Output: `    noise_test.go:${i}: setup line ${i} for ${name}\n` });
      events.push({ Action: "output", Test: name, Output: `    assert_test.go:9: ${name} final assertion mismatch\n` });
      events.push({ Action: "fail", Test: name });
    };
    noisy("TestGrid/alpha");
    noisy("TestGrid/beta");
    noisy("TestGrid/gamma");
    for (let i = 0; i < 24; i++) events.push({ Action: "fail", Test: `TestOverflow/${i}` });
    events.push({ Action: "fail", Package: "example/native" });
    input(events.map(event => JSON.stringify(event)).join("\n") + "\n");
    await expect(run([child("exit", 1)])).rejects.toThrow(/failed \(exit 1\)/);
    const diagnostic = messages.join("\n");
    for (const name of ["TestGrid/alpha", "TestGrid/beta", "TestGrid/gamma"]) {
      expect(diagnostic).toContain(`Failed: ${name}`);
      expect(diagnostic).toContain(`${name} final assertion mismatch`);
      // Older buffered noise ages out of the per-test buffer; the head is not retained.
      expect(diagnostic).not.toContain(`setup line 0 for ${name}`);
    }
    // 3 + 24 + 1 = 28 failures against a cap of 24: the last four are only counted.
    expect(diagnostic).toContain("… 4 more failed tests");
    expect(diagnostic).not.toContain("Failed: example/native");
    expect(diagnostic.length).toBeLessThan(14_000);
  });

  it("keeps the head of a race report instead of only its trailer", async () => {
    const events: unknown[] = [];
    const test = "TestConcurrentFill";
    for (let i = 0; i < 50; i++) events.push({ Action: "output", Test: test, Output: `    fill_test.go:${i}: iteration ${i}\n` });
    events.push({ Action: "output", Test: test, Output: "==================\n" });
    events.push({ Action: "output", Test: test, Output: "WARNING: DATA RACE\n" });
    events.push({ Action: "output", Test: test, Output: "Write at 0x00c0001a2b40 by goroutine 12:\n" });
    events.push({ Action: "output", Test: test, Output: "  example/native.(*Cache).publish()\n" });
    events.push({ Action: "output", Test: test, Output: "      /work/go/cache.go:311 +0x1f4\n" });
    events.push({ Action: "output", Test: test, Output: "Previous read at 0x00c0001a2b40 by goroutine 7:\n" });
    events.push({ Action: "output", Test: test, Output: "  example/native.(*Cache).read()\n" });
    for (let i = 0; i < 45; i++) events.push({ Action: "output", Test: test, Output: `  frame ${i}: runtime.goexit()\n` });
    events.push({ Action: "output", Test: test, Output: "==================\n" });
    events.push({ Action: "output", Test: test, Output: "    testing.go:1490: race detected during execution of test\n" });
    events.push({ Action: "fail", Test: test });
    input(events.map(event => JSON.stringify(event)).join("\n") + "\n");
    await expect(run([child("exit", 1)])).rejects.toThrow(/failed \(exit 1\)/);
    const diagnostic = messages.join("\n");
    expect(diagnostic).toContain(`Failed: ${test}`);
    expect(diagnostic).toContain("WARNING: DATA RACE");
    expect(diagnostic).toContain("Write at 0x00c0001a2b40 by goroutine 12:");
    expect(diagnostic).toContain("/work/go/cache.go:311");
    expect(diagnostic).toContain("Previous read at 0x00c0001a2b40 by goroutine 7:");
    expect(diagnostic).not.toContain("iteration 49");
    // Marker + 5 header lines + 45 frames + 2 trailer lines = 53 buffered from the marker; 40 kept, 13 counted.
    expect(diagnostic).toContain(`… 13 more lines for ${test}`);
    expect(diagnostic).not.toContain("race detected during execution of test");
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
