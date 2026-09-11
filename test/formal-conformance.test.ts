import {
  coreCommands, parseItfTrace, expectedCoreObservation, assertCoreObservation,
  type CoreCommand, type Counter, type ActionName, type Observation, type Trace,
} from "../formal/replay/core.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DialCache, DialCacheKeyConfig, type DialCacheConfig } from "../src/index.js";
import { record } from "./formal/itf.js";
import { FakeRedis } from "./fake-redis.js";

class ConformanceDriver {
  readonly redis = new FakeRedis();
  readonly dialcache: DialCache;
  private sourceVersion = 1;
  private lastResult = 0;
  private readonly counters: Record<Counter, number> = {
    outsideLoaderCalls: 0,
    requestLoaderCalls: 0,
    localLoaderCalls: 0,
    coalescedLoaderCalls: 0,
    remoteLoaderCalls: 0,
  };
  private wallClockMs = Date.parse("2026-09-08T12:00:00.000Z");

  constructor(config: DialCacheConfig = {}) {
    this.dialcache = new DialCache({ ...config, redis: { client: this.redis } });
  }

  async apply(action: ActionName): Promise<void> {
    for (const input of coreCommands(action)) await this.applyInput(input);
  }

  private async applyInput(input: CoreCommand): Promise<void> {
    if (input.op === "advanceWall") {
      this.wallClockMs += input.ms;
      vi.setSystemTime(this.wallClockMs);
      return;
    }
    if (input.op === "bumpSource") {
      this.sourceVersion++;
      return;
    }
    if (input.op === "invalidate") {
      await this.dialcache.invalidateRemote(input.identity.keyType, input.identity.id);
      return;
    }

    const options = {
      keyType: input.identity.keyType,
      key: input.identity.id,
      useCase: input.identity.useCase,
      trackForInvalidation: input.identity.tracked,
      defaultConfig: new DialCacheKeyConfig(input.policy),
    };
    const call = (wait?: Promise<void>) => this.dialcache.getOrLoad(async () => {
      this.counters[input.counter]++;
      if (wait !== undefined) await wait;
      return this.sourceVersion;
    }, options);
    const pair = async (concurrent: boolean) => {
      if (!concurrent) {
        const first = await call();
        const second = await call();
        expect(second).toBe(first);
        return second;
      }
      const gate = deferred<void>();
      const leader = call(gate.promise);
      const follower = call();
      // Drain only causally ready work while the actual source remains held.
      await vi.advanceTimersByTimeAsync(0);
      gate.resolve();
      const values = await Promise.all([leader, follower]);
      expect(values[1]).toBe(values[0]);
      return values[1]!;
    };

    this.redis.failGet = input.readFailure;
    try {
      if (input.mode === "outside") {
        this.lastResult = await call();
      } else {
        this.lastResult = await this.dialcache.enable(() => input.mode === "single"
          ? call()
          : pair(input.mode === "coalesced-pair"));
      }
    } finally {
      this.redis.failGet = false;
    }
  }

  snapshot(): Observation {
    return {
      sourceVersion: this.sourceVersion,
      lastResult: this.lastResult,
      ...this.counters,
      redisReads: this.redis.getCalls + this.redis.mGetCalls,
      redisWrites: this.redis.setCalls,
    };
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function readItfTrace(path: string): Trace {
  return parseItfTrace(JSON.parse(readFileSync(path, "utf8")), path);
}

function loadTraces(generatedDir: string | undefined): Trace[] {
  if (generatedDir === undefined) return [readItfTrace(resolve("formal/conformance-smoke.itf.json"))];
  const root = resolve(generatedDir);
  const paths = readdirSync(root).filter((name) => name.endsWith(".itf.json")).sort();
  if (paths.length === 0) throw new Error(`${root}: no .itf.json conformance traces found`);
  const execution = JSON.parse(readFileSync(resolve("formal/execution.json"), "utf8")) as {
    models: Array<{ profile?: string; replayRegressions?: string[] }>;
  };
  const regressions = execution.models.find(model => model.profile === "core")?.replayRegressions ?? [];
  return [
    ...paths.map((name) => readItfTrace(resolve(root, name))),
    ...regressions.map(name => readItfTrace(resolve(root, "..", "regressions", "core", `${name}.itf.json`))),
  ];
}

async function replay(trace: Trace, driver = new ConformanceDriver()): Promise<void> {
  for (const [index, step] of trace.states.entries()) {
    const context = `trace ${trace.path} step ${index} action ${step.action}`;
    // Expected state is used only for comparison. It never enters the driver.
    const expected = expectedCoreObservation(step.state);
    try {
      await driver.apply(step.action);
      assertCoreObservation(step.state, driver.snapshot());
    } catch (cause) {
      throw new Error([
        context,
        `expected model observation: ${JSON.stringify(expected)}`,
        `actual implementation observation: ${JSON.stringify(driver.snapshot())}`,
        `replay: DIALCACHE_MBT_TRACE_FILE=${JSON.stringify(trace.path)} corepack pnpm exec vitest run test/formal-conformance.test.ts`,
      ].join("\n"), { cause });
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T12:00:00.000Z"));
  // DialCache imports this clock from node:perf_hooks, separately from the
  // global clock replaced by fake timers. No deadlines elapse in this profile.
  vi.spyOn(performance, "now").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Quint model-based conformance", () => {
  const file = process.env.DIALCACHE_MBT_TRACE_FILE;
  const traces = file === undefined
    ? loadTraces(process.env.DIALCACHE_MBT_TRACE_DIR)
    : [readItfTrace(resolve(file))];
  for (const trace of traces) {
    it(`replays ${trace.path}`, async () => await replay(trace));
  }
});

describe("conformance harness trust boundary", () => {
  const smokePath = resolve("formal/conformance-smoke.itf.json");
  const smoke = readItfTrace(smokePath);

  it("accepts explicit commands without MBT metadata", async () => {
    const trace = JSON.parse(readFileSync(smokePath, "utf8")) as { states: Record<string, unknown>[] };
    for (const state of trace.states) {
      delete state["mbt::actionTaken"];
      delete state["mbt::nondetPicks"];
    }
    await replay(parseItfTrace(trace, "explicit-core.itf.json"));
  });

  it("detects lost local caching through a later public call", async () => {
    const driver = new ConformanceDriver({
      cacheConfigProvider: () => new DialCacheKeyConfig({ ramp: { local: 0 } }),
    });
    await expect(replay(smoke, driver)).rejects.toThrow(/step 5 action localCall/);
  });

  it("detects lost coalescing while the source is blocked", async () => {
    const driver = new ConformanceDriver({
      cacheConfigProvider: () => new DialCacheKeyConfig({ coalesce: false }),
    });
    await expect(replay(smoke, driver)).rejects.toThrow(/action coalescedLocalPair/);
  });

  it("detects a lost Redis write even when the adapter reports success", async () => {
    const driver = new ConformanceDriver();
    vi.spyOn(driver.redis, "write").mockImplementation(async () => { driver.redis.setCalls += 1; });
    await expect(replay(smoke, driver)).rejects.toThrow(/step 9 action remoteCall/);
  });

  it("detects lost invalidation through a later tracked call", async () => {
    const driver = new ConformanceDriver();
    vi.spyOn(driver.redis, "invalidate").mockImplementation(async () => { driver.redis.setCalls += 1; });
    await expect(replay(smoke, driver)).rejects.toThrow(/step 11 action remoteCall/);
  });

  it.each([
    ["empty trace", (trace: { states: unknown[] }) => { trace.states = []; }],
    ["missing explicit input", (trace: { states: unknown[] }) => {
      delete record(trace.states[1], "test").input;
    }],
    ["unexpected explicit choice", (trace: { states: unknown[] }) => {
      record(record(trace.states[1], "test").input, "test").choice = { "#bigint": "0" };
    }],
    ["unknown action", (trace: { states: unknown[] }) => {
      record(trace.states[1], "test")["mbt::actionTaken"] = "unsupportedAction";
    }],
    ["missing initialization", (trace: { states: unknown[] }) => { trace.states.shift(); }],
    ["repeated initialization", (trace: { states: unknown[] }) => {
      record(trace.states[1], "test")["mbt::actionTaken"] = "init";
    }],
    ["unsupported action arguments", (trace: { states: unknown[] }) => {
      record(trace.states[1], "test")["mbt::nondetPicks"] = { input: 1 };
    }],
    ["missing observation", (trace: { states: unknown[] }) => {
      delete record(record(trace.states[1], "test").s, "test").redisReads;
    }],
    ["unsafe integer", (trace: { states: unknown[] }) => {
      record(record(trace.states[1], "test").s, "test").redisReads = { "#bigint": "9007199254740993" };
    }],
  ])("rejects %s", (_name, corrupt) => {
    const trace = JSON.parse(readFileSync(smokePath, "utf8")) as { states: unknown[] };
    corrupt(trace);
    expect(() => parseItfTrace(trace, "bad.itf.json")).toThrow(/bad.itf.json/);
  });

  it("rejects a directory without generated traces", () => {
    expect(() => loadTraces(resolve("src"))).toThrow(/no .itf.json conformance traces/);
  });
});
