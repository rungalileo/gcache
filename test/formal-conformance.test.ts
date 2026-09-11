import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CacheLayer, DialCache, DialCacheKeyConfig, type DialCacheConfig } from "../src/index.js";
import { record, itfInteger } from "./formal/itf.js";
import { FakeRedis } from "./fake-redis.js";

const actionNames = [
  "init", "bumpSource", "outsideCall", "requestLocalPair", "localCall",
  "coalescedLocalPair", "remoteCall", "invalidateRemote", "remoteReadFailureCall",
] as const;
type ActionName = typeof actionNames[number];

// Only these model fields are observable through the public API/environment.
// Cache-presence/value fields stay in Quint to predict future observations;
// a loader invocation alone is not evidence that a local value was published.
const observationFields = [
  "sourceVersion", "lastResult", "outsideLoaderCalls", "requestLoaderCalls",
  "localLoaderCalls", "coalescedLoaderCalls", "remoteLoaderCalls", "redisReads", "redisWrites",
] as const;
type Observation = Pick<Snapshot, typeof observationFields[number]>;

interface Snapshot {
  sourceVersion: number;
  lastResult: number;
  outsideLoaderCalls: number;
  requestLoaderCalls: number;
  localLoaderCalls: number;
  coalescedLoaderCalls: number;
  remoteLoaderCalls: number;
  localCached: boolean;
  localValue: number;
  coalescedCached: boolean;
  coalescedValue: number;
  remoteReadable: boolean;
  remoteValue: number;
  redisReads: number;
  redisWrites: number;
}

interface TraceState {
  action: ActionName;
  state: Snapshot;
}

interface Trace {
  path: string;
  states: TraceState[];
}

const localOnly = () =>
  new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.LOCAL]: 60 },
    ramp: { [CacheLayer.LOCAL]: 100 },
  });

const remoteOnly = () =>
  new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.REMOTE]: 60 },
    ramp: { [CacheLayer.REMOTE]: 100 },
  });

const requestOnly = () => new DialCacheKeyConfig({ requestLocal: true });

class ConformanceDriver {
  readonly redis = new FakeRedis();
  readonly dialcache: DialCache;

  constructor(config: DialCacheConfig = {}) {
    this.dialcache = new DialCache({ ...config, redis: { client: this.redis } });
  }

  sourceVersion = 1;
  lastResult = 0;
  outsideLoaderCalls = 0;
  requestLoaderCalls = 0;
  localLoaderCalls = 0;
  coalescedLoaderCalls = 0;
  remoteLoaderCalls = 0;

  private wallClockMs = Date.parse("2026-09-08T12:00:00.000Z");

  async apply(action: ActionName): Promise<void> {
    if (action === "init") return;

    // Give sequential protocol actions distinct wall-clock timestamps. This is
    // an environment scheduling choice, not a DialCache semantic guarantee.
    this.wallClockMs += 1;
    vi.setSystemTime(this.wallClockMs);

    switch (action) {
      case "bumpSource":
        this.sourceVersion += 1;
        return;
      case "outsideCall":
        this.lastResult = await this.dialcache.getOrLoad(
          async () => {
            this.outsideLoaderCalls += 1;
            return this.sourceVersion;
          },
          {
            keyType: "user_id",
            useCase: "ConformanceOutside",
            key: "123",
            defaultConfig: localOnly(),
          },
        );
        return;
      case "requestLocalPair": {
        const options = {
          keyType: "user_id",
          useCase: "ConformanceRequest",
          key: "123",
          defaultConfig: requestOnly(),
        } as const;
        const values = await this.dialcache.enable(async () => {
          const first = await this.dialcache.getOrLoad(async () => {
            this.requestLoaderCalls += 1;
            return this.sourceVersion;
          }, options);
          const second = await this.dialcache.getOrLoad(async () => {
            this.requestLoaderCalls += 1;
            return this.sourceVersion;
          }, options);
          return [first, second] as const;
        });
        expect(values[1]).toBe(values[0]);
        this.lastResult = values[1];
        return;
      }
      case "localCall":
        this.lastResult = await this.dialcache.enable(async () =>
          await this.dialcache.getOrLoad(async () => {
            this.localLoaderCalls += 1;
            return this.sourceVersion;
          }, {
            keyType: "user_id",
            useCase: "ConformanceLocal",
            key: "123",
            defaultConfig: localOnly(),
          }),
        );
        return;
      case "coalescedLocalPair": {
        const gate = deferred<void>();
        const options = {
          keyType: "user_id",
          useCase: "ConformanceCoalesced",
          key: "123",
          defaultConfig: localOnly(),
        } as const;
        const values = await this.dialcache.enable(async () => {
          const leader = this.dialcache.getOrLoad(async () => {
            this.coalescedLoaderCalls += 1;
            await gate.promise;
            return this.sourceVersion;
          }, options);
          const follower = this.dialcache.getOrLoad(async () => {
            this.coalescedLoaderCalls += 1;
            return this.sourceVersion;
          }, options);
          // Drain ready work while the loader remains blocked. This does not
          // advance deadlines and does not encode a count of Promise turns in
          // the portable action. Ports drain their own executor here.
          await vi.advanceTimersByTimeAsync(0);
          gate.resolve();
          return await Promise.all([leader, follower]);
        });
        expect(values[1]).toBe(values[0]);
        this.lastResult = values[1];
        return;
      }
      case "remoteCall":
        this.lastResult = await this.remoteCall();
        return;
      case "invalidateRemote":
        await this.dialcache.invalidateRemote("user_id", "123");
        return;
      case "remoteReadFailureCall":
        this.redis.failGet = true;
        try {
          this.lastResult = await this.remoteCall();
        } finally {
          this.redis.failGet = false;
        }
        return;
    }
    const unsupported: never = action;
    throw new Error(`Unsupported conformance action: ${unsupported}`);
  }

  snapshot(): Observation {
    return {
      sourceVersion: this.sourceVersion,
      lastResult: this.lastResult,
      outsideLoaderCalls: this.outsideLoaderCalls,
      requestLoaderCalls: this.requestLoaderCalls,
      localLoaderCalls: this.localLoaderCalls,
      coalescedLoaderCalls: this.coalescedLoaderCalls,
      remoteLoaderCalls: this.remoteLoaderCalls,
      redisReads: this.redis.getCalls + this.redis.mGetCalls,
      redisWrites: this.redis.setCalls,
    };
  }

  private async remoteCall(): Promise<number> {
    return await this.dialcache.enable(async () =>
      await this.dialcache.getOrLoad(async () => {
        this.remoteLoaderCalls += 1;
        return this.sourceVersion;
      }, {
        keyType: "user_id",
        useCase: "ConformanceRemote",
        key: "123",
        trackForInvalidation: true,
        defaultConfig: remoteOnly(),
      }),
    );
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

function parseItfTrace(value: unknown, path: string): Trace {
  const parsed = record(value, path);
  if (!Array.isArray(parsed.states) || parsed.states.length < 2) {
    throw new Error(`${path}: expected init and at least one action`);
  }
  const states = parsed.states.map((value, index): TraceState => {
    const context = `${path} step ${index}`;
    const state = record(value, context);
    const action = state["mbt::actionTaken"];
    if (!actionNames.some((name) => name === action) || ((index === 0) !== (action === "init"))) {
      throw new Error(`${context}: unknown or misplaced action ${JSON.stringify(action)}`);
    }
    if (Object.keys(record(state["mbt::nondetPicks"], context)).length !== 0) {
      throw new Error(`${context}: this profile does not accept nondeterministic action arguments`);
    }
    const raw = record(state.s, context);
    const integerFields = [
      ...observationFields, "localValue", "coalescedValue", "remoteValue",
    ] as const;
    const booleanFields = ["localCached", "coalescedCached", "remoteReadable"] as const;
    if (Object.keys(raw).length !== integerFields.length + booleanFields.length) {
      throw new Error(`${context}: unexpected model state fields`);
    }
    const decoded: Record<string, number | boolean> = {};
    for (const field of integerFields) {
      decoded[field] = itfInteger(raw[field], `${context} ${field}`);
    }
    for (const field of booleanFields) {
      if (typeof raw[field] !== "boolean") throw new Error(`${context}: expected boolean ${field}`);
      decoded[field] = raw[field];
    }
    return { action: action as ActionName, state: decoded as unknown as Snapshot };
  });
  return { path, states };
}

function readItfTrace(path: string): Trace {
  return parseItfTrace(JSON.parse(readFileSync(path, "utf8")), path);
}

function loadTraces(generatedDir: string | undefined): Trace[] {
  if (generatedDir === undefined) return [readItfTrace(resolve("formal/conformance-smoke.itf.json"))];
  const root = resolve(generatedDir);
  const paths = readdirSync(root).filter((name) => name.endsWith(".itf.json")).sort();
  if (paths.length === 0) throw new Error(`${root}: no .itf.json conformance traces found`);
  return paths.map((name) => readItfTrace(resolve(root, name)));
}

async function replay(trace: Trace, driver = new ConformanceDriver()): Promise<void> {
  for (const [index, step] of trace.states.entries()) {
    const context = `trace ${trace.path} step ${index} action ${step.action}`;
    // Expected state is used only for comparison. It never enters the driver.
    const expected = Object.fromEntries(observationFields.map((field) => [field, step.state[field]]));
    try {
      await driver.apply(step.action);
      expect(driver.snapshot(), context).toEqual(expected);
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
