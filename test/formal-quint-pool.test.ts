import { describe, expect, it } from "vitest";

type Buffered = { status: number | null; signal: string | null; error?: Error & { code?: string }; stdout: string; stderr: string; durationMs: number };
const { resolveConcurrency, runPool, spawnBuffered, formatGroup, executionChains, executionPlan, CommandFailure } = {
  ...await import(new URL("../formal/quint-pool.mjs", import.meta.url).href),
  ...await import(new URL("../formal/run-models.mjs", import.meta.url).href),
} as {
  resolveConcurrency(env: Record<string, string | undefined>, available?: number, memory?: number): number;
  runPool<T>(tasks: Array<() => Promise<T> | T>, options?: { concurrency?: number }): Promise<T[]>;
  spawnBuffered(command: string, args: string[], options?: { cwd?: string; timeoutMs?: number }): Promise<Buffered>;
  formatGroup(title: string, ...texts: string[]): string;
  executionChains(commands: Array<{ command: string; args: string[] }>): Array<Array<{ command: string; args: string[] }>>;
  executionPlan(mode: "check" | "generate"): Array<{ command: string; args: string[] }>;
  CommandFailure: new (message: string, result: { status?: number | null; signal?: string | null }) => Error & { status?: number | null };
};

// A task whose completion the test controls; `settle` resolves or rejects it.
function deferred<T>() {
  let settle!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { settle = res; reject = rej; });
  return { promise, settle, reject };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe("Quint process pool", () => {
  it("reads QUINT_JOBS as a positive integer and otherwise uses the available parallelism, never below one", () => {
    expect(resolveConcurrency({}, 4)).toBe(4);
    expect(resolveConcurrency({}, 0)).toBe(1);
    expect(resolveConcurrency({ QUINT_JOBS: "3" }, 16)).toBe(3);
    expect(resolveConcurrency({ QUINT_JOBS: "1" }, 16)).toBe(1);
    for (const invalid of ["0", "-2", "1.5", "abc", "", " 4", "4 ", "0x10", "1e3"]) {
      expect(() => resolveConcurrency({ QUINT_JOBS: invalid }, 16), JSON.stringify(invalid)).toThrow(/QUINT_JOBS must be a positive integer/);
    }
  });

  it("caps the default worker count at one per 2 GiB of memory and leaves QUINT_JOBS uncapped", () => {
    const GiB = 2 ** 30;
    expect(resolveConcurrency({}, 12, 16 * GiB)).toBe(8);
    expect(resolveConcurrency({}, 4, 16 * GiB)).toBe(4);
    expect(resolveConcurrency({}, 18, 64 * GiB)).toBe(18);
    expect(resolveConcurrency({}, 8, 1 * GiB)).toBe(1);
    expect(resolveConcurrency({ QUINT_JOBS: "12" }, 12, 16 * GiB)).toBe(12);
  });

  it("returns results indexed by task even when later tasks finish first", async () => {
    const order: number[] = [];
    const results = await runPool([
      async () => { await new Promise(resolve => setTimeout(resolve, 30)); order.push(0); return "slow"; },
      async () => { order.push(1); return "fast"; },
      () => { order.push(2); return "sync"; },
    ], { concurrency: 3 });
    expect(results).toEqual(["slow", "fast", "sync"]);
    expect(order).toEqual([1, 2, 0]);
    expect(await runPool([], { concurrency: 4 })).toEqual([]);
  });

  it("keeps at most the configured number of tasks in flight", async () => {
    const gates = Array.from({ length: 7 }, () => deferred<void>());
    let inFlight = 0, peak = 0, started = 0;
    const tasks = gates.map((gate, index) => async () => {
      started++; inFlight++; peak = Math.max(peak, inFlight);
      await gate.promise;
      inFlight--;
      return index;
    });
    const pool = runPool(tasks, { concurrency: 3 });
    await tick();
    expect(started).toBe(3);
    gates[1]!.settle(); await tick();
    expect(started).toBe(4);
    expect(inFlight).toBe(3);
    for (const gate of gates) gate.settle();
    expect(await pool).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(peak).toBe(3);
    await expect(runPool([() => 1], { concurrency: 0 })).rejects.toThrow(/Invalid pool concurrency/);
  });

  it("stops launching after the first failure, lets in-flight tasks finish and reports that first failure", async () => {
    const gates = Array.from({ length: 6 }, () => deferred<void>());
    const started: number[] = [], finished: number[] = [];
    const tasks = gates.map((gate, index) => async () => {
      started.push(index);
      await gate.promise;
      finished.push(index);
      return index;
    });
    const pool = runPool(tasks, { concurrency: 2 });
    const outcome = pool.then(() => "resolved", (error: Error) => error.message);
    await tick();
    expect(started).toEqual([0, 1]);
    gates[1]!.reject(new Error("first failure")); await tick();
    // Task 0 is still running; nothing new starts and the pool has not settled.
    expect(started).toEqual([0, 1]);
    expect(finished).toEqual([]);
    gates[0]!.reject(new Error("second failure")); await tick();
    expect(await outcome).toBe("first failure");
    expect(started).toEqual([0, 1]);
    gates.slice(2).forEach(gate => gate.settle());
    await tick();
    expect(started).toEqual([0, 1]);
  });

  it("buffers a child's output, reports spawn errors without rejecting and enforces a timeout", async () => {
    const ok = await spawnBuffered(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"]);
    expect(ok).toMatchObject({ status: 3, signal: null, stdout: "out", stderr: "err" });
    expect(ok.error).toBeUndefined();
    expect(ok.durationMs).toBeGreaterThan(0);
    const missing = await spawnBuffered("dialcache-no-such-binary-for-tests", []);
    expect(missing.error?.code).toBe("ENOENT");
    expect(missing.status).not.toBe(0);
    const slow = await spawnBuffered(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { timeoutMs: 100 });
    expect(slow.error?.code).toBe("ETIMEDOUT");
    expect(slow.signal).toBe("SIGTERM");
    const failure = new CommandFailure("quint run failed", { status: 2, signal: null });
    expect(failure).toBeInstanceOf(Error);
    expect(failure.status).toBe(2);
  });

  it("prints a command's log as one closed group block", () => {
    expect(formatGroup("quint run model", "line one\n", "line two")).toBe("::group::quint run model\nline one\nline two\n::endgroup::");
    expect(formatGroup("quint typecheck model", "", undefined as unknown as string)).toBe("::group::quint typecheck model\n::endgroup::");
  });

  it("puts every job of the real plans into exactly one per-model chain, in plan order, without the challenge run", () => {
    for (const mode of ["check", "generate"] as const) {
      const plan = executionPlan(mode);
      const chains = executionChains(plan);
      const chained = chains.flat();
      const challengeRuns = plan.filter(job => job.command === "node" && job.args[0] === "formal/check-model-properties.mjs");
      expect(challengeRuns.length).toBe(mode === "check" ? 1 : 0);
      expect(chained.length).toBe(plan.length - challengeRuns.length);
      expect(new Set(chained).size).toBe(chained.length);
      expect(chained.filter(job => challengeRuns.includes(job))).toEqual([]);
      for (const chain of chains) {
        expect(new Set(chain.map(job => job.command === "quint" ? job.args[1] : job.args.join(" "))).size).toBe(1);
        const positions = chain.map(job => plan.indexOf(job));
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
      }
    }
  });

  it("chains a model's jobs in plan order, isolates node exports and leaves the challenge run out", () => {
    const plan = [
      { command: "quint", args: ["typecheck", "formal/a.qnt"] },
      { command: "quint", args: ["run", "formal/a.qnt", "--seed=1"] },
      { command: "quint", args: ["test", "formal/a.qnt"] },
      { command: "quint", args: ["typecheck", "formal/b.qnt"] },
      { command: "node", args: ["formal/generate-key-vectors.mjs", "--check"] },
      { command: "quint", args: ["run", "formal/b.qnt", "--mbt"] },
      { command: "node", args: ["formal/check-model-properties.mjs"] },
    ];
    expect(executionChains(plan)).toEqual([
      [plan[0], plan[1], plan[2]],
      [plan[3], plan[5]],
      [plan[4]],
    ]);
  });
});
