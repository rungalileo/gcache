import assert from "node:assert/strict";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { vi } from "vitest";

import { ReplayCoordinator, settlement } from "../../formal/replay/coordinator.mjs";
import type { CoreCommand } from "../../formal/replay/core.mjs";
import { parseJSON } from "../../formal/replay/validation.mjs";
import { DialCache, DialCacheKeyConfig } from "../../src/index.js";
import { FakeRedis } from "../fake-redis.js";
import { BehaviorDriver, emptyObservation, type Fixture, type Input, type Observation } from "./behavior-driver.js";

// Every controlled driver starts its wall clock here. Frame timestamps, marker
// cutoffs and adapter replies are computed relative to this epoch.
export const wallEpochMs = Date.parse("2026-09-08T12:00:00.000Z");

export function smokeTracePath(profile: string): string {
  return resolve(`formal/${profile === "core" ? "conformance" : profile}-smoke.itf.json`);
}

// A native driver as the coordinator sees it: it applies fixture-independent
// commands, reports its own observation and clock, and never receives
// expected model state.
interface CoordinatedDriver {
  apply(command: Record<string, unknown>): Promise<void>;
  observe(): unknown;
  wallMs(): number;
  dispose(): Promise<void>;
}

type Prepared = { session: string; fixture: Record<string, unknown>; setup: Array<Record<string, unknown>>; steps: number };
type Observed = { complete: false; index: number; inputs: Array<Record<string, unknown>> } | { complete: true; steps: number };

// Replays one trace end to end through the shared coordinator with the real
// language driver for its profile, exactly as a native port does over JSONL:
// prepare, apply setup, then observe/apply until the coordinator acknowledges
// completion. Observations cross a JSON roundtrip so undefined members vanish
// the way they do on the wire.
export async function replayThroughCoordinator(profile: string, path: string, coordinator = new ReplayCoordinator()): Promise<{ steps: number }> {
  let id = 0;
  const request = <T>(fields: Record<string, unknown>): T =>
    coordinator.dispatch(parseJSON(JSON.stringify({ version: 1, id: ++id, ...fields }))) as T;
  const prepared = request<Prepared>({ op: "prepare", profile, path });
  const driver = driverFor(profile, prepared.fixture as unknown as Fixture);
  let complete = false;
  try {
    for (const command of prepared.setup) await driver.apply(command);
    for (let index = 0; ; index++) {
      const result = request<Observed>({
        op: "observe", session: prepared.session, index, settlement,
        observed: parseJSON(JSON.stringify(driver.observe())), environment: { wallMs: driver.wallMs() },
      });
      if (result.complete) {
        complete = true;
        return { steps: result.steps };
      }
      for (const command of result.inputs) await driver.apply(command);
    }
  } finally {
    // The coordinator drops a session on its own failure; release it after a
    // driver failure so the coordinator can be reused for another trace.
    if (!complete) { try { request({ op: "discard", session: prepared.session }); } catch { /* Already released. */ } }
    await driver.dispose();
  }
}

function driverFor(profile: string, fixture: Fixture): CoordinatedDriver {
  if (profile === "core") return new CoordinatedCoreDriver();
  if (profile === "local-clock") return new CoordinatedLocalClockDriver();
  return new CoordinatedBehaviorDriver(fixture);
}

// Feature profiles and effects: the shared BehaviorDriver under fake timers
// pinned to the wall epoch, as in test/formal-features.test.ts and
// test/formal-effects.test.ts. The driver drains causally ready work itself.
class CoordinatedBehaviorDriver implements CoordinatedDriver {
  private readonly driver: BehaviorDriver;
  constructor(fixture: Fixture) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(wallEpochMs));
    this.driver = new BehaviorDriver(fixture);
  }
  apply(command: Record<string, unknown>): Promise<void> { return this.driver.apply(command as Input); }
  observe(): Observation { return this.driver.snapshot(); }
  wallMs(): number { return Date.now(); }
  async dispose(): Promise<void> {
    try { await this.driver.dispose(); } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  }
}

// Core: the flat-integer conformance driver from test/formal-conformance.test.ts,
// consuming the coordinator's explicit advanceWall/bumpSource/invalidate/call
// commands instead of action names.
class CoordinatedCoreDriver implements CoordinatedDriver {
  private readonly redis = new FakeRedis();
  private readonly dialcache: DialCache;
  private sourceVersion = 1;
  private lastResult = 0;
  private wallClockMs = wallEpochMs;
  private readonly counters: Record<string, number> = {
    outsideLoaderCalls: 0, requestLoaderCalls: 0, localLoaderCalls: 0, coalescedLoaderCalls: 0, remoteLoaderCalls: 0,
  };
  constructor() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(wallEpochMs));
    this.dialcache = new DialCache({ redis: { client: this.redis } });
  }
  async apply(command: Record<string, unknown>): Promise<void> {
    const input = command as unknown as CoreCommand;
    if (input.op === "advanceWall") {
      this.wallClockMs += input.ms;
      vi.setSystemTime(this.wallClockMs);
      return;
    }
    if (input.op === "bumpSource") { this.sourceVersion++; return; }
    if (input.op === "invalidate") {
      await this.dialcache.invalidateRemote(input.identity.keyType, input.identity.id);
      return;
    }
    const options = {
      keyType: input.identity.keyType, key: input.identity.id, useCase: input.identity.useCase,
      trackForInvalidation: input.identity.tracked, defaultConfig: new DialCacheKeyConfig(input.policy),
    };
    const call = (wait?: Promise<void>) => this.dialcache.getOrLoad(async () => {
      this.counters[input.counter] = (this.counters[input.counter] ?? 0) + 1;
      if (wait !== undefined) await wait;
      return this.sourceVersion;
    }, options);
    const pair = async (concurrent: boolean) => {
      if (!concurrent) {
        const first = await call();
        const second = await call();
        assert.equal(second, first);
        return second;
      }
      let release!: () => void;
      const gate = new Promise<void>(done => { release = done; });
      const leader = call(gate);
      const follower = call();
      // Drain only causally ready work while the actual source remains held.
      await vi.advanceTimersByTimeAsync(0);
      release();
      const values = await Promise.all([leader, follower]);
      assert.equal(values[1], values[0]);
      return values[1];
    };
    this.redis.failGet = input.readFailure;
    try {
      this.lastResult = input.mode === "outside" ? await call()
        : await this.dialcache.enable(() => input.mode === "single" ? call() : pair(input.mode === "coalesced-pair"));
    } finally {
      this.redis.failGet = false;
    }
  }
  observe(): Record<string, number> {
    return {
      sourceVersion: this.sourceVersion, lastResult: this.lastResult, ...this.counters,
      redisReads: this.redis.getCalls + this.redis.mGetCalls, redisWrites: this.redis.setCalls,
    };
  }
  wallMs(): number { return this.wallClockMs; }
  async dispose(): Promise<void> { vi.useRealTimers(); vi.restoreAllMocks(); }
}

// Local clock: default DialCache instances on the real scheduler with only the
// process clock mocked, as in test/formal/local-clock-profile.ts. The wall
// clock is the real one; no local-clock mapping consumes it.
class CoordinatedLocalClockDriver implements CoordinatedDriver {
  private ticks = 0;
  private readonly now = vi.spyOn(performance, "now").mockImplementation(() => this.ticks / 1000);
  private readonly actual = { ...emptyObservation(), calls: [] as number[] };
  private readonly caches: Array<{ call: (offered: number) => Promise<number> } | undefined> = [undefined, undefined];
  async apply(command: Record<string, unknown>): Promise<void> {
    const input = command as { op: string; instance?: number; ticks?: number; offered?: number };
    if (input.op === "constructInstance") {
      if (this.caches[input.instance!] !== undefined) throw new Error("Instance already constructed");
      const cache = new DialCache();
      const load = cache.cached(async (offered: number) => { this.actual.loaders++; return offered; }, {
        keyType: "clock", useCase: "QuintLocalGrid", cacheKey: () => "one",
        defaultConfig: new DialCacheKeyConfig({ ttlSec: { local: 1 } }),
      });
      this.caches[input.instance!] = { call: offered => cache.enable(() => load(offered)) };
    } else if (input.op === "advanceTicks") this.ticks += input.ticks!;
    else if (input.op === "call") {
      const cache = this.caches[input.instance!];
      if (cache === undefined) throw new Error("Call before instance construction");
      this.actual.calls.push(await cache.call(input.offered!));
    } else throw new Error(`Unknown local-clock command ${input.op}`);
  }
  observe(): unknown { return this.actual; }
  wallMs(): number { return Date.now(); }
  async dispose(): Promise<void> { this.now.mockRestore(); }
}
