# Core behavioral conformance profile

This document specifies the bounded `core` profile implemented by the TypeScript and Go replay drivers. Its model is `dialcache-conformance.qnt`; the full port target also requires the other profiles registered in [execution.json](./execution.json).

## Trace format and trust boundary

Inputs use Quint 0.32.0's ITF JSON format. Each entry in `states` has:

- `mbt::actionTaken`: the action that reached this state; the first is `init`.
- `mbt::nondetPicks`: an empty record for this profile, whose actions have no parameters.
- `s`: the expected model state after that action. Integers are encoded as `{"#bigint":"123"}`; booleans are JSON booleans.

The committed smoke scenario uses the same format. Drivers reject unknown actions, unsupported arguments, missing/misplaced initialization, missing observations, and empty traces/corpora. This profile uses nonnegative safe integers; the TypeScript parser rejects out-of-range ITF integers instead of rounding them. General ITF sets/maps/variants are not needed by this profile.

Create a fresh implementation instance and independently controlled environment per trace, preserving both across its actions. Await its defined completion boundary, record real outputs/effects, then compare the observation projection with `s`. Only action names enter the TypeScript driver's execution method. Expected state is consumed by the assertion layer.

The model also keeps `localCached`, `localValue`, `coalescedCached`, `coalescedValue`, `remoteReadable`, and `remoteValue`. These predict later returns and loader counts; they are **not implementation observations**. A loader invocation does not prove cache publication, nor does an acknowledged write prove later readability. Subsequent public calls test those effects. Drivers must not read or modify private cache/flight maps to match the model.

This profile is registered as `core` version 1 in [`profiles.json`](./profiles.json),
under experimental specification 0.1.0. Pin the repository revision and Quint
version with a result. Incompatible action/state changes require a profile
version increment and corresponding driver changes; old parsers must fail
visibly. This registry identifies formats and bounded claims, not a stable
production API or a claim of exhaustive conformance.

## Controlled environment

Each trace starts with source version `1`, empty caches and Redis, no active calls, and all counters/results zero. Each operation uses entity `keyType=user_id`, ID `123`, and a distinct use case from the table below. All state is reset between traces.

Local/remote serving TTLs are 60 seconds with 100% ramps. Request-local policy is enabled only for the request-local action; default coalescing is enabled. Remote calls are tracked. Shadow validation, stale recovery, compression, and runtime policy changes are not enabled in this profile.

Before every action except `init`, advance the application wall clock by 1 ms from `2026-09-08T12:00:00.000Z`. This makes sequential invalidation/write timestamps distinct. There is no writer skew or TTL expiry in these short traces; monotonic deadline time does not advance. Invalidation uses a zero future buffer, and no action overlaps an invalidation. This profile does not establish delayed-write fencing or timeout behavior.

Redis supplies the semantic adapter contract: atomic tracked reads, stored serialized values with creation times, successful writes/invalidation, and injected read errors. The TypeScript driver uses the existing `FakeRedis` adapter. This tests core behavior above that boundary; real Redis/Valkey/Cluster integrations and the portable protocol vectors test adapters and wire behavior separately.

## Actions

All calls execute through public logical call/scope/invalidation equivalents. The TypeScript binding uses `getOrLoad`/`enable`/`invalidateRemote`; ports do not need those names or a `cached()` registration API. See [the contract boundary](./CONTRACTS.md#where-the-boundary-lies). The loader increments its associated counter and returns the current source version. An action completes before the next action starts, except for the two overlapping calls explicitly contained in `coalescedLocalPair`.

| Action | Driver operation and completion boundary |
| --- | --- |
| `init` | Construct a fresh instance/environment; observe initial state |
| `bumpSource` | Increment the backing source version without changing caches or last result |
| `outsideCall` | Call outside enablement with local policy, use case `ConformanceOutside`; await its return |
| `requestLocalPair` | In one new enabled scope, await two sequential same-key calls with request-local-only policy, use case `ConformanceRequest`; compare both returns and close the scope |
| `localCall` | In a new enabled scope, call with local-only policy, use case `ConformanceLocal`; await the return |
| `coalescedLocalPair` | Start two same-key local-only calls before either loader can settle, use case `ConformanceCoalesced`; drain ready executor work while the leader loader is gated, then release it, await both returns, compare them, and close the scope |
| `remoteCall` | In a new enabled scope, call with tracked remote-only policy, use case `ConformanceRemote`; await the return and publication |
| `invalidateRemote` | Invalidate `user_id/123` with zero future buffer and await completion; leave last result unchanged |
| `remoteReadFailureCall` | Inject a Redis read failure for a tracked remote call; await the source result, then restore Redis read health |

Draining ready work is an implementation-driver responsibility. A Go/Rust/Python driver can use its executor's facilities; it must not emulate a fixed number of Node Promise turns. The TypeScript driver drains ready work at frozen fake time while the loader remains unresolved. It controls the external loader promise, not the implementation's flight map.

## Compared observations

After **every** action, compare these fields exactly:

| Field | Independent source |
| --- | --- |
| `sourceVersion` | Driver-owned backing source |
| `lastResult` | Most recent actual public call result; both results of pair actions must agree |
| `outsideLoaderCalls` | Actual loader invocations for `ConformanceOutside` |
| `requestLoaderCalls` | Actual loader invocations for `ConformanceRequest` |
| `localLoaderCalls` | Actual loader invocations for `ConformanceLocal` |
| `coalescedLoaderCalls` | Actual loader invocations for `ConformanceCoalesced` |
| `remoteLoaderCalls` | Actual loader invocations for `ConformanceRemote`, including read-failure fallback |
| `redisReads` | Actual semantic Redis read attempts, including failures |
| `redisWrites` | Actual semantic Redis value-write **plus invalidation** attempts |

All counters are cumulative within a trace. These are adapter-level operations, not TCP commands or round trips. A normal remote miss loads and writes once; a hit reads once without a loader/write; a read error calls the loader and must not refill. Unexpected rejections fail replay with step context. Error classifications, explicit pending operations, and deadline delivery need additional profiles.

## Adding a language implementation

1. Run `protocol-vectors.json` against the implementation's keys and frame/decoder routines.
2. Implement the environment/actions above against public operations and report the compared observations from real calls and adapter effects.
3. Replay the committed smoke trace, then the same generated ITF corpus as TypeScript.
4. Implement the remaining registered profiles, with separately controlled external observations, deadlines, and loader settlement where races matter.
   [BEHAVIOR.md](./BEHAVIOR.md) defines those profiles; [PORTING.md](./PORTING.md) defines the complete acceptance checks. Adding a new behavior requires updating Quint and its evidence before extending each port's driver.
5. Record only passing profiles, the spec revision, generation seed/bounds, and backend/tool versions. Passing core does not establish stale recovery, shadow validation, runtime-policy, deadline, or delayed-invalidation conformance.

Keep minimized or otherwise useful failing scenarios as regressions. Automatic shrinking is not implemented. The CI artifact and single-file replay command provide the current reproduction path.
