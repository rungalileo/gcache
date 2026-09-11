import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const { checkSymbolicModels, startSymbolicServer, symbolicPlan, validateSymbolicResult } = await import(
  new URL("../formal/check-symbolic-models.mjs", import.meta.url).href,
) as {
  symbolicPlan(manifest?: unknown): Array<{ model: string; args: string[]; maxSteps: number; timeoutMs: number }>;
  validateSymbolicResult(result: unknown, exitCode: number): void;
  checkSymbolicModels(options: { directory: string }): Promise<unknown>;
  startSymbolicServer(options: { launcher: string; jar: string; version: string; output: string; endpoint?: string }): Promise<{
    endpoint: string; evidence: { version: string; jar: string; jarSha256: string }; stop(): Promise<void>;
  }>;
};

function fixtureSolver(directory: string, version = "0.56.1") {
  const launcher = join(directory, "fixture-solver");
  const jar = join(directory, "fixture.jar");
  writeFileSync(jar, "controlled solver fixture");
  writeFileSync(launcher, `#!${process.execPath}
const http2 = require('node:http2');
if (process.env.APALACHE_JAR !== ${JSON.stringify(jar)}) process.exit(2);
const port = Number(process.argv.find(arg => arg.startsWith('--port=')).split('=')[1]);
const server = http2.createServer();
server.on('stream', stream => {
  stream.on('data', () => {});
  stream.on('end', () => {
    const field = (number, value) => Buffer.concat([Buffer.from([number * 8 + 2, value.length]), value]);
    const message = field(4, field(1, field(1, Buffer.from('fixture.proto'))));
    const header = Buffer.alloc(5);
    header.writeUInt32BE(message.length, 1);
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
    stream.end(Buffer.concat([header, message]));
  });
});
server.listen(port, '127.0.0.1', () => {
  console.log('# APALACHE version: ${version} | build: fixture');
  console.log('The Apalache server is running on port ' + port + '. Press Ctrl-C to stop.');
});
`, { mode: 0o755 });
  return { launcher, jar, version: "0.56.1", output: directory };
}

describe("symbolic verification evidence", () => {
  it("rejects simulator success, tool errors, counterexamples and incomplete verification output", () => {
    expect(() => validateSymbolicResult({ stage: "verifying", status: "ok", errors: [] }, 0)).not.toThrow();
    for (const [result, code] of [
      [{ stage: "running", status: "ok", errors: [] }, 0],
      [{ stage: "verifying", status: "violation", errors: [] }, 1],
      [{ stage: "verifying", status: "ok", errors: ["solver failure"] }, 0],
      [{ stage: "verifying", status: "ok" }, 0],
      [{ stage: "verifying", status: "ok", errors: [] }, 2],
      [{}, 0],
    ] as const) expect(() => validateSymbolicResult(result, code)).toThrow(/did not complete/);
  });

  it("takes properties and bounds from the execution inventory and pins the symbolic backend", () => {
    const plan = symbolicPlan();
    const rule = plan.find(job => job.model === "formal/dialcache-rule-checks.qnt")!;
    expect(rule).toBeDefined();
    expect(rule.maxSteps).toBe(1);
    expect(rule.timeoutMs).toBeGreaterThan(0);
    expect(rule.args).toContain("--apalache-version=0.56.1");
    expect(rule.args).toContain("recoveryBoundaryIsExclusive");
    expect(rule.args).toContain("fenceBoundaryIsExclusive");
    expect(rule.args).not.toContain("--random-transitions");
    expect(() => symbolicPlan({ models: [] })).toThrow(/scheduled symbolic/);
  });

  it("invalidates an earlier complete report before malformed or rejected manifest preflight", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dialcache-symbolic-preflight-"));
    const report = join(directory, ".formal-traces/symbolic/report.json");
    try {
      mkdirSync(join(directory, "formal"));
      mkdirSync(join(directory, ".formal-traces/symbolic"), { recursive: true });
      for (const manifest of ["{broken", JSON.stringify({ schemaVersion: 0 })]) {
        writeFileSync(report, JSON.stringify({ complete: true, checks: [{ status: "passed" }] }));
        writeFileSync(join(directory, "formal/execution.json"), manifest);
        await expect(checkSymbolicModels({ directory })).rejects.toThrow();
        expect(JSON.parse(readFileSync(report, "utf8"))).toMatchObject({ complete: false, checks: [] });
        expect(JSON.parse(readFileSync(report, "utf8")).error).toBeTruthy();
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects an existing endpoint and isolates its owned solver from another listening server", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dialcache-symbolic-server-"));
    const other = createServer();
    await new Promise<void>(resolve => other.listen(0, "127.0.0.1", resolve));
    const endpoint = `127.0.0.1:${(other.address() as { port: number }).port}`;
    let owned: Awaited<ReturnType<typeof startSymbolicServer>> | undefined;
    try {
      const options = fixtureSolver(directory);
      await expect(startSymbolicServer({ ...options, endpoint })).rejects.toThrow(/EADDRINUSE/);
      expect(other.listening).toBe(true);
      owned = await startSymbolicServer(options);
      expect(owned.endpoint).not.toBe(endpoint);
      expect(owned.evidence).toMatchObject({ version: "0.56.1", jar: options.jar });
      expect(owned.evidence.jarSha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      if (owned) await owned.stop();
      await new Promise<void>(resolve => other.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an owned server with the wrong actual startup version", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dialcache-symbolic-version-"));
    try {
      await expect(startSymbolicServer(fixtureSolver(directory, "0.55.0"))).rejects.toThrow(/version 0\.55\.0 differs/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
