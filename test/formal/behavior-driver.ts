import { emptyObservation } from "../../formal/replay/observation.mjs";
export { emptyObservation } from "../../formal/replay/observation.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

import { vi } from "vitest";

import {
  DialCache, DialCacheKey, DialCacheKeyConfig, FallbackTimeoutError,
  type DialCacheConfig, type RedisReadRequest, type RedisReadResult, type RedisReadContext,
  type RedisWriteRequest, type RedisInvalidationRequest, type Serializer,
} from "../../src/index.js";
import { encodeFrame, FakeRedis } from "../fake-redis.js";
import type { EffectsContractEvent } from "./effects-contract.js";
import { assertPublicationCausality, type CausalEvent } from "./causal-contract.js";
import { LocalCache } from "../../src/internal/local-cache.js";

export type Policy = ConstructorParameters<typeof DialCacheKeyConfig>[0];
export type Value = number | boolean | string | null;
export type Recovery = "allow" | "deny" | "error";
export type EventName = "readContext" | "readAbort" | "request" | "miss" | "disabled" | "error"
  | "coalesced" | "invalidation" | "shadowAge" | "recoveryAge" | "futureOffset"
  | "size" | "storedSize" | "compression" | "get" | "fallback" | "serialization"
  | "mismatchWarning" | "writeDispatch" | "marker";
export interface ObservedEvent { event: EventName; [field: string]: string | number | boolean | null }
// JSON-shaped adapter observations deliberately include malformed replies. A
// strongly typed port can reject these at its adapter boundary instead.
export type AdapterReply = null | number | string | boolean | { [field: string]: unknown };
export interface Fixture {
  localFaultInjection?: boolean;
  policy: Policy;
  tracked?: boolean;
  fallbackTimeoutMs?: number | null | "default";
  readTimeoutMs?: number | "default";
  localMaxSize?: number;
  shadowMaxInFlight?: number;
  recovery?: Recovery | "default";
  comparator?: "equal" | "unequal" | "error";
  comparisonMs?: number;
  sourceWorkMs?: number;
  shadowHook?: boolean;
  observerFailure?: boolean;
  remote?: boolean;
  probeSourceScope?: boolean;
  observe?: EventName[];
}
export interface Faults {
  localStorage: boolean;
  read: boolean; write: boolean; dump: boolean; load: boolean; policy: boolean; observer: boolean;
  holdReads: boolean; holdWrites: boolean; holdDumps: boolean; holdLoads: boolean; holdPolicies: boolean;
}
export type Input =
  | { op: "begin"; key?: string; useCase?: string; instance?: string; scope?: string; outside?: boolean; disabled?: boolean; recovery?: Recovery }
  | { op: "resolve"; loader: number; value?: Value }
  | { op: "reject"; loader: number; error?: "timeout" }
  | { op: "advance"; ms: number; deliverTimers?: boolean }
  | { op: "shiftWall"; ms: number }
  | { op: "seed"; useCase?: string; key?: string; value?: Value; ageMs?: number; frameHex?: string; payloadText?: string; payloadHex?: string; ttlMs?: number }
  | { op: "invalidate"; key?: string; futureBufferMs?: number }
  | { op: "observeMarker"; key?: string }
  | { op: "adapterReply"; value: AdapterReply }
  | { op: "policy"; value: Policy | null }
  | { op: "faults"; value: Partial<Faults> }
  | { op: "release"; effect: "read" | "write" | "dump" | "load" | "policy"; index: number; fail?: boolean }
  | { op: "openScope"; id: string; parent?: string; disabled?: boolean; instance?: string }
  | { op: "closeScope"; id: string };

export type CallResult = { status: "pending" } | { status: "value"; value: Value | { absent: true } }
  | { status: "error"; error: string };
export interface Observation {
  events?: ObservedEvent[];
  calls: CallResult[];
  loaders: number;
  reads: number;
  writes: number;
  invalidations: number;
  maintenance: string[];
  loads: number;
  dumps: number;
  policyCalls: number;
  classifications: number;
  comparisons: number;
  sourceScopes: boolean[];
  writeTtls: number[];
  shadow: string[];
  recovery: string[];
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return {
    promise, get settled() { return settled; },
    resolve(value: T) { if (settled) throw new Error("Effect already settled"); settled = true; resolvePromise(value); },
    reject(error: unknown) { if (settled) throw new Error("Effect already settled"); settled = true; rejectPromise(error); },
  };
}
type Gate = ReturnType<typeof deferred<void>>;
type Scope = { instance: string; run: <T>(fn: () => T) => T; gate: Gate; lifetime: Promise<void> };

// Only external effects are gated. We never access DialCache's maps, flights,
// or resolved policy, and no expected observation is passed to this class.
export class BehaviorDriver {
  private readonly observed: Observation;
  // Independent event journal for bounded contract monitors. Entries come
  // only from external callbacks, settlements, and public diagnostics.
  private readonly history: EffectsContractEvent[] = [];
  private readonly causalHistory: CausalEvent[] = [];
  private readonly invocation = new AsyncLocalStorage<{ id: number }>();
  private readonly sourceByInvocation = new Map<number, number>();
  private fallbackFailed = false;
  private adapterReply: { value: AdapterReply } | undefined;
  private readonly loaders: Array<ReturnType<typeof deferred<Value | undefined>>> = [];
  private readonly sourceErrors: Error[] = [];
  private readonly timeoutErrors: unknown[] = [];
  private readonly scopes = new Map<string, Scope>();
  private readonly effects = { read: new Map<number, Gate>(), write: new Map<number, Gate>(),
    dump: new Map<number, Gate>(), load: new Map<number, Gate>(), policy: new Map<number, Gate>() };
  private readonly faults: Faults = { localStorage: false, read: false, write: false, dump: false, load: false, policy: false, observer: false,
    holdReads: false, holdWrites: false, holdDumps: false, holdLoads: false, holdPolicies: false };
  private runtimePolicy: Policy | null = {};
  private wallOffset = 0;
  private readonly wallOrigin = Date.now();
  private readonly instances = new Map<string, DialCache>();
  private readonly maintenanceError = new Error("Controlled mutation failure");
  readonly redis: FakeRedis;
  readonly cache: DialCache;

  constructor(private readonly fixture: Fixture, private readonly overrides: DialCacheConfig = {}) {
    this.observed = emptyObservation(fixture);
    if (fixture.localFaultInjection) {
      // Native binding for the model's fallible local-storage boundary. These
      // hooks inject an exception only; successful calls still use real storage.
      const owner = this;
      const get = LocalCache.prototype.getWithResolvedConfig;
      const put = LocalCache.prototype.put;
      vi.spyOn(LocalCache.prototype, "getWithResolvedConfig").mockImplementation(function (this: LocalCache, key, config) {
        if (owner.faults.localStorage) throw new Error("Controlled local storage failure");
        return get.call(this, key, config);
      });
      vi.spyOn(LocalCache.prototype, "put").mockImplementation(function (this: LocalCache, key, value, config) {
        if (owner.faults.localStorage) throw new Error("Controlled local storage failure");
        return put.call(this, key, value, config);
      });
    }
    const origin = Date.now();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now() - origin - this.wallOffset);
    // Sinon delivers fake immediates outside the async context in which they
    // were scheduled. Preserve only the driver's opaque ownership token at
    // this external scheduler seam; cache request scopes remain untouched.
    const scheduleImmediate = globalThis.setImmediate;
    vi.spyOn(globalThis, "setImmediate").mockImplementation(((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
      const invocation = this.invocation.getStore();
      return scheduleImmediate(invocation === undefined ? callback
        : (...values: unknown[]) => this.invocation.run(invocation, () => callback(...values)), ...args);
    }) as typeof setImmediate);
    const owner = this;
    this.redis = new class extends FakeRedis {
      override async read(request: RedisReadRequest, context?: RedisReadContext): Promise<RedisReadResult> {
        const index = owner.observed.reads++;
        if (context !== undefined) {
          owner.record("readContext", { index, timeoutMs: context.timeoutMs, aborted: context.signal.aborted });
          context.signal.addEventListener("abort", () => owner.record("readAbort", { index }), { once: true });
        }
        if (owner.faults.holdReads) await owner.hold("read", index);
        if (owner.faults.read) throw new Error("Controlled read failure");
        if (owner.adapterReply !== undefined) {
          const value = structuredClone(owner.adapterReply.value);
          owner.adapterReply = undefined;
          return value as unknown as RedisReadResult;
        }
        return super.read(request);
      }
      override async write(request: RedisWriteRequest): Promise<void> {
        const index = owner.observed.writes++;
        const invocation = owner.invocation.getStore();
        owner.causalHistory.push({ event: "writeDispatch", atMs: performance.now(), owner: invocation?.id,
          source: invocation === undefined ? undefined : owner.sourceByInvocation.get(invocation.id) });
        owner.history.push({ event: "writeDispatch", atMs: performance.now() });
        owner.record("writeDispatch", { index });
        owner.observed.writeTtls.push(request.cacheTtlMs);
        // A native adapter stamps the complete frame before its SET is delayed.
        const stamped = { ...request, createdAtMs: request.createdAtMs ?? Date.now() };
        if (owner.faults.holdWrites) await owner.hold("write", index);
        if (owner.faults.write) throw owner.maintenanceError;
        await super.write(stamped);
      }
      override async invalidate(request: RedisInvalidationRequest): Promise<void> {
        owner.observed.invalidations++;
        if (owner.faults.write) throw owner.maintenanceError;
        await super.invalidate(request);
      }
    }();
    this.cache = this.instance("default");
  }

  private instance(id: string): DialCache {
    const existing = this.instances.get(id);
    if (existing !== undefined) return existing;
    const fixture = this.fixture;
    const noop = () => { if (fixture.observerFailure || this.faults.observer) throw new Error("Controlled observer failure"); };
    const cache = new DialCache({
      ...(fixture.remote === false ? {} : { redis: { client: this.redis, ...(fixture.readTimeoutMs === "default" ? {} : { readTimeoutMs: fixture.readTimeoutMs ?? 50 }), compression: false as const } }),
      ...(fixture.localMaxSize === undefined ? {} : { localMaxSize: fixture.localMaxSize }),
      ...(fixture.shadowMaxInFlight === undefined ? {} : { shadowMaxInFlight: fixture.shadowMaxInFlight }),
      ...(fixture.recovery === undefined || fixture.recovery === "default" ? {}
        : { shouldAttemptStaleRecovery: this.classifier(fixture.recovery) }),
      cacheConfigProvider: async () => {
        const index = this.observed.policyCalls++;
        if (this.faults.holdPolicies) await this.hold("policy", index);
        if (this.faults.policy) throw new Error("Controlled policy failure");
        return this.runtimePolicy === null ? null : new DialCacheKeyConfig(this.runtimePolicy);
      },
      metrics: {
        request: (labels) => { this.record("request", labels); noop(); },
        miss: (labels) => { this.record("miss", labels); noop(); },
        disabled: (labels) => { this.record("disabled", labels); noop(); },
        error: (labels) => { if (labels.inFallback && labels.error === "fallback") this.fallbackFailed = true; this.record("error", labels); noop(); },
        invalidation: (labels) => { this.record("invalidation", labels); noop(); },
        coalesced: (labels) => { this.record("coalesced", labels); noop(); },
        observeShadowValueAge: (labels, seconds) => { this.record("shadowAge", { ...labels, seconds }); noop(); },
        observeStaleRecoveryValueAge: (labels, seconds) => { this.record("recoveryAge", { ...labels, seconds }); noop(); },
        observeFutureTimestampOffset: (labels, seconds) => { this.record("futureOffset", { ...labels, seconds }); noop(); },
        observeSize: (labels, bytes) => { this.record("size", { ...labels, bytes }); noop(); },
        observeStoredSize: (labels, bytes) => { this.record("storedSize", { ...labels, bytes }); noop(); },
        compression: (labels) => { this.record("compression", labels); noop(); },
        observeGet: (labels, seconds) => { this.record("get", { ...labels, seconds }); noop(); },
        observeFallback: (labels, seconds) => {
          this.history.push({ event: "fallbackCompletion", atMs: performance.now(), durationMs: seconds * 1000, failed: this.fallbackFailed });
          this.fallbackFailed = false;
          this.record("fallback", { ...labels, seconds }); noop();
        },
        observeSerialization: (labels, seconds) => { this.record("serialization", { ...labels, seconds }); noop(); },
        ...(fixture.shadowHook === false ? {} : { shadowValidation: ({ outcome }: { outcome: string }) => { this.observed.shadow.push(outcome); noop(); } }),
        staleRecovery: ({ outcome }) => { this.observed.recovery.push(outcome); noop(); } },
      logger: { debug: noop, warn: (message, details) => {
        if (message === "DialCache shadow validation mismatch" && typeof details === "object" && details !== null) {
          this.record("mismatchWarning", details);
        }
        noop();
      }, error: noop },
      ...this.overrides,
    });
    this.instances.set(id, cache);
    return cache;
  }

  private classifier(outcome: Recovery): () => boolean {
    return () => {
      this.observed.classifications++;
      if (outcome === "error") throw new Error("Controlled classification failure");
      return outcome === "allow";
    };
  }

  private readonly serializer: Serializer<Value | undefined> = {
    dump: async (value) => {
      const index = this.observed.dumps++;
      if (this.faults.holdDumps) await this.hold("dump", index);
      if (this.faults.dump) throw new Error("Controlled serialization failure");
      return value === undefined ? "undefined" : JSON.stringify(value);
    },
    load: async (raw) => {
      const index = this.observed.loads++;
      if (this.faults.holdLoads) await this.hold("load", index);
      if (this.faults.load) throw new Error("Controlled deserialization failure");
      const text = raw.toString();
      return text === "undefined" ? undefined : JSON.parse(text) as Value;
    },
  };

  async apply(input: Input): Promise<void> {
    switch (input.op) {
      case "begin": {
        const index = this.observed.calls.length;
        this.observed.calls.push({ status: "pending" });
        const scope = input.scope === undefined ? undefined : this.scope(input.scope);
        const cache = this.instance(input.instance ?? scope?.instance ?? "default");
        let sourceBudget: number | null = null;
        const call = () => cache.getOrLoad(() => {
          this.sourceByInvocation.set(index, this.loaders.length);
          this.causalHistory.push({ event: "sourceStart", id: this.loaders.length, owner: index,
            atMs: performance.now(), budgetMs: sourceBudget });
          this.history.push({ event: "sourceStart", id: this.loaders.length, atMs: performance.now() });
          if (this.fixture.probeSourceScope) this.observed.sourceScopes.push(cache.isEnabled());
          const gate = deferred<Value | undefined>();
          this.loaders.push(gate);
          this.sourceErrors.push(new Error(`Source failure ${this.sourceErrors.length}`));
          this.observed.loaders++;
          // Consume elapsed external source work before returning its gate,
          // without delivering timers or scheduled cache work during that work.
          if (this.fixture.sourceWorkMs !== undefined) vi.setSystemTime(Date.now() + this.fixture.sourceWorkMs);
          return gate.promise;
        }, { keyType: "id", key: input.key ?? "1", useCase: input.useCase ?? "Behavior", serializer: this.serializer,
          ...(input.recovery === undefined ? {} : { shouldAttemptStaleRecovery: this.classifier(input.recovery) }),
          ...(this.fixture.comparator === undefined ? {} : { shadowComparator: () => {
            this.observed.comparisons++;
            // Observe elapsed external comparison work without delivering timers.
            // The implementation must recheck its deadline when work returns.
            if (this.fixture.comparisonMs !== undefined) vi.setSystemTime(Date.now() + this.fixture.comparisonMs);
            if (this.fixture.comparator === "error") throw new Error("Controlled comparison failure");
            return this.fixture.comparator === "equal";
          } }),
          trackForInvalidation: this.fixture.tracked ?? false,
          defaultConfig: new DialCacheKeyConfig(this.fixture.policy),
          ...(this.fixture.fallbackTimeoutMs === "default" ? {} : {
            fallbackTimeoutMs: this.fixture.fallbackTimeoutMs === undefined ? 10 : this.fixture.fallbackTimeoutMs,
          }) });
        const ownedCall = () => {
          sourceBudget = !cache.isEnabled() || this.fixture.fallbackTimeoutMs === null ? null
            : this.fixture.fallbackTimeoutMs === "default" ? 60_000 : this.fixture.fallbackTimeoutMs ?? 10;
          return this.invocation.run({ id: index }, call);
        };
        const execute = () => input.disabled ? cache.disable(ownedCall) : ownedCall();
        const result = input.scope !== undefined ? this.scope(input.scope).run(execute)
          : input.outside ? execute() : cache.enable(execute);
        void result.then(
          (value) => { this.observed.calls[index] = { status: "value", value: value === undefined ? { absent: true } : value }; },
          (error: unknown) => { this.observed.calls[index] = { status: "error", error: this.classifyError(error) }; },
        );
        break;
      }
      case "resolve":
        this.loader(input.loader).resolve(input.value);
        this.history.push({ event: "sourceSettlement", id: input.loader, atMs: performance.now(), outcome: "resolve" });
        this.causalHistory.push({ event: "sourceSettlement", id: input.loader, atMs: performance.now(), outcome: "resolve" });
        break;
      case "reject": {
        if (input.error === "timeout") this.sourceErrors[input.loader] = new FallbackTimeoutError("NestedSource", 10);
        this.loader(input.loader).reject(this.sourceErrors[input.loader]);
        this.history.push({ event: "sourceSettlement", id: input.loader, atMs: performance.now(), outcome: "reject" });
        this.causalHistory.push({ event: "sourceSettlement", id: input.loader, atMs: performance.now(), outcome: "reject" });
        break;
      }
      case "advance":
        if (input.deliverTimers === false) vi.setSystemTime(Date.now() + input.ms);
        else await vi.advanceTimersByTimeAsync(input.ms);
        break;
      case "shiftWall":
        this.wallOffset += input.ms;
        vi.setSystemTime(Date.now() + input.ms);
        // Redis physical expiry has its own elapsed clock, unaffected by an application wall-clock step.
        for (const entry of this.redis.values.values()) entry.expiresAtMs += input.ms;
        break;
      case "seed":
        this.redis.setRaw(this.valueKey(input.key, input.useCase), input.frameHex === undefined
          ? encodeFrame(input.payloadHex === undefined
            ? input.payloadText ?? (input.value === undefined ? "undefined" : JSON.stringify(input.value))
            : Buffer.from(input.payloadHex, "hex"), Date.now() - (input.ageMs ?? 0), input.payloadHex === undefined ? 0 : 1)
          : Buffer.from(input.frameHex, "hex"), input.ttlMs ?? 60_000);
        break;
      case "invalidate":
        try {
          await this.cache.invalidateRemote("id", input.key ?? "1", input.futureBufferMs ?? 0);
          this.observed.maintenance.push("ok");
        } catch (error) {
          if (error === this.maintenanceError) this.observed.maintenance.push("mutation_error");
          else if (error instanceof TypeError && error.message === "DialCache invalidateRemote requires a configured Redis client") this.observed.maintenance.push("missing_remote");
          else throw error;
        }
        break;
      case "observeMarker": {
        // Observe the controlled Redis environment, never DialCache's internal
        // state. The fixed origin makes the timestamp portable across runtimes.
        const key = new DialCacheKey({ useCase: "Behavior", keyType: "id", id: input.key ?? "1", trackForInvalidation: true });
        const watermarkKey = `${key.prefix}#watermark`;
        const cutoff = this.redis.readWatermarkValue(watermarkKey);
        this.record("marker", { cutoffMs: cutoff === null ? -1 : cutoff - this.wallOrigin, ttlMs: this.redis.ttlMs(watermarkKey) });
        break;
      }
      case "adapterReply":
        if (this.adapterReply !== undefined) throw new Error("Unconsumed adapter reply");
        this.adapterReply = { value: input.value };
        break;
      case "policy": this.runtimePolicy = input.value; break;
      case "faults": Object.assign(this.faults, input.value); break;
      case "release": {
        const gate = this.effects[input.effect].get(input.index);
        if (gate === undefined) throw new Error(`No pending ${input.effect} ${input.index}`);
        if (input.fail) gate.reject(new Error(`Controlled ${input.effect} failure`));
        else gate.resolve();
        this.effects[input.effect].delete(input.index);
        break;
      }
      case "openScope": {
        if (this.scopes.has(input.id)) throw new Error(`Duplicate scope ${input.id}`);
        const gate = deferred<void>();
        let run!: Scope["run"];
        const body = async () => {
          // Capture the driver's execution context inside the public scope.
          // Other runtimes can retain their explicit request-context token.
          const captured = AsyncLocalStorage.snapshot();
          run = (fn) => captured(fn);
          await gate.promise;
        };
        const instance = input.instance ?? (input.parent === undefined ? "default" : this.scope(input.parent).instance);
        const cache = this.instance(instance);
        const open = () => input.disabled ? cache.disable(body) : cache.enable(body);
        const lifetime = input.parent === undefined ? open() : this.scope(input.parent).run(open);
        this.scopes.set(input.id, { instance, run, gate, lifetime });
        break;
      }
      case "closeScope": {
        const scope = this.scope(input.id);
        scope.gate.resolve();
        await scope.lifetime;
        // Retain the captured context to exercise detached work after closure.
        break;
      }
      default: { const unknown: never = input; throw new Error(`Unknown input: ${JSON.stringify(unknown)}`); }
    }
    // Drain ready executor work while unresolved external gates remain held.
    // No guessed number of Promise turns and no advancing deadline time.
    await vi.advanceTimersByTimeAsync(0);
    assertPublicationCausality(this.causalHistory);
  }

  private record(event: EventName, fields: object): void {
    if (this.fixture.observe?.includes(event)) this.observed.events!.push({ event, ...fields });
  }

  snapshot(): Observation { return structuredClone(this.observed); }

  contractHistory(): readonly EffectsContractEvent[] { return structuredClone(this.history); }

  async dispose(): Promise<void> {
    Object.assign(this.faults, { holdReads: false, holdWrites: false, holdDumps: false, holdLoads: false, holdPolicies: false });
    for (const scope of this.scopes.values()) if (!scope.gate.settled) scope.gate.resolve();
    for (const gates of Object.values(this.effects)) for (const gate of gates.values()) if (!gate.settled) gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    for (const loader of this.loaders) if (!loader.settled) loader.resolve(0);
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllTimers();
  }

  private scope(id: string): Scope {
    const scope = this.scopes.get(id);
    if (scope === undefined) throw new Error(`Unknown scope ${id}`);
    return scope;
  }
  private loader(index: number) {
    const loader = this.loaders[index];
    if (loader === undefined) throw new Error(`No loader ${index}`);
    return loader;
  }
  private hold(effect: keyof BehaviorDriver["effects"], index: number): Promise<void> {
    const gate = deferred<void>();
    this.effects[effect].set(index, gate);
    return gate.promise;
  }
  private valueKey(key = "1", useCase = "Behavior"): string {
    return `${new DialCacheKey({ keyType: "id", id: key, useCase, trackForInvalidation: this.fixture.tracked ?? false }).urn}:dialcache-frame-v1`;
  }
  private classifyError(error: unknown): string {
    const source = this.sourceErrors.indexOf(error as Error);
    if (source >= 0) return `source:${source}`;
    if (error instanceof FallbackTimeoutError) {
      let index = this.timeoutErrors.indexOf(error);
      if (index < 0) { index = this.timeoutErrors.length; this.timeoutErrors.push(error); }
      return `timeout:${index}`;
    }
    return `unexpected:${String(error)}`;
  }
}
