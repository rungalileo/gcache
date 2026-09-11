# Portable behavioral scenarios and generated feature profiles

[`behavioral-scenarios.json`](./behavioral-scenarios.json) specifies deterministic feature scenarios independently of TypeScript. [`dialcache-effects-conformance.qnt`](./dialcache-effects-conformance.qnt) generates additional races using the same driver operations. Together with the [core profile](./CONFORMANCE.md) and [protocol vectors](./protocol-vectors.json), these are executable contracts for implementation tests and language ports.

The deterministic corpus currently contains 244 scenarios across 12 behavior families. It includes request-scope lifetime, coalescing, both read and fallback deadlines, local TTL/LRU, runtime snapshots, layer precedence, cache failures, tracked invalidation, frame age/retention, stale recovery, and shadow validation. These scenarios are test-derived contracts, **not Quint-generated traces**. The effects model generates interleavings of calls, loader settlement, clock observations, native writes, and invalidation. Recovery, policy, and shadow models generate further feature schedules through the same driver; their bounds and action mappings appear below. Keeping these complementary forms avoids a single model containing every feature combination. The [feature map](./FEATURE-COVERAGE.md) relates the scenarios to the full reviewed behavioral, protocol, and native inventory.

The corpus includes interaction regressions for scope closure during recovery, runtime coalescing changes during an active flight, independent retained snapshots, recovery/shadow exclusion, local insertion TTL after an aging remote hit, and shadow capacity ownership. These are fixed portable schedules: they extend implementation conformance without claiming that the generated profiles explore those combinations. The [behavioral evidence map](./TEST-MAP.md#behavioral-map) connects these obligations to implementation tests and the current generated profiles.

Full validation below means `make formal` locally or the manual/weekly full
workflow. It regenerates and replays every scheduled history and checks the
required witnesses in both languages. Fast PR checks use committed smoke,
fixed supplements and freshness audits without claiming full parity;
model/generator changes additionally recompute committed artifacts. Full
validation remains required for behavior/model changes before merge and for
release/new-port acceptance. See the [Make targets](./README.md#generating-and-replaying-behavior).

## Scenario format

Schema version 2 has a `scenarios` array. Each scenario has a unique `name`, a `feature` label, a `fixture`, and ordered `steps`. Each step contains:

- `input`: one environment/public-operation command from the table below.
- `expect`: a patch to the previous **expected** observation. Unmentioned fields retain their previous expected values. Arrays replace the entire previous array.

Start with the empty observation below. When `fixture.observe` is present, also initialize `events` to an empty list. After each input, drain runnable work until it completes or blocks on an external effect. Compare the entire actual observation to the accumulated expectation, including fields omitted from that step's patch. Patches are only notation for assertions; they must never populate driver state.

```json
{
  "calls": [], "loaders": 0, "reads": 0, "writes": 0, "invalidations": 0,
  "maintenance": [], "loads": 0, "dumps": 0, "policyCalls": 0, "classifications": 0, "comparisons": 0, "sourceScopes": [],
  "writeTtls": [], "shadow": [], "recovery": []
}
```

Every scenario/trace gets a fresh default cache instance and empty Redis environment. Additional named instances share that Redis environment but own separate local storage, request contexts, flights, and shadow capacity. State persists between its steps. The TypeScript implementation is [`test/formal/behavior-driver.ts`](../test/formal/behavior-driver.ts), used by the effects and feature replay tests. No new production APIs, private cache maps, or flight mutations are needed.

## Optional observed events

`fixture.observe` is a list of event names to include in an additional `events` observation array. Ports record actual callbacks/adapter observations in occurrence order; they must not consult expected patches. Unselected events are excluded by the fixture, and generated profiles select only the observations they specify. This keeps diagnostic checks separate from claims about all executor schedules.

- `writeDispatch`: actual native adapter invocation index, recorded before its controlled write gate.
- `readContext`: the adapter's actual read `index`, effective `timeoutMs`, and initial `aborted` state. `readAbort` records the index when cooperative cancellation is requested; the held raw read remains independently releasable.
- `request`, `miss`, `disabled`, `error`, `coalesced`, `invalidation`: public bounded metadata. Operational events use `cacheNamespace`, `useCase`, `keyType`, and `layer` as applicable; miss/disabled events add `reason`, errors add `error`/`inFallback`, and coalescing uses `scope`.
- `shadowAge`, `recoveryAge`, `futureOffset`, `get`, `fallback`, `serialization`: actual observations with `seconds`; serialization adds `operation`, and verdict ages add `outcome`.
- `size`, `storedSize`: observed `bytes`. `compression` carries its actual `outcome`.
- `mismatchWarning`: fields supplied to the public logger for a confirmed-mismatch warning. The scalar fixtures do not prescribe a general host-language JSON conversion algorithm or truncation implementation.
- `marker`: an explicit environment probe of the tracked watermark's cutoff and remaining physical TTL. Cutoffs are milliseconds relative to the fixture wall origin; absence is `cutoffMs: -1`. TTL uses Redis's `-2` absent and `-1` persistent values. This controlled adapter observation supplements real-server integration evidence.

Names are a trace vocabulary, not required language method names. All selected events are compared after every input, including steps that expect none. The [source audit](./TEST-AUDIT.md) explains the test/doc obligations these probes cover.

## Fixture

`policy` uses the existing configuration vocabulary: `ttlSec` and `ramp` with `local`/`remote` leaves, `requestLocal`, `coalesce`, `staleOnErrorMaxAgeSec`, `remoteReadTimeoutMs`, and `shadow.ramp`. Omitted fields have DialCache's documented defaults; TTL without a ramp enables that layer fully. Runtime overlays initially omit all leaves.

Other fixture fields are `tracked` (default false), `fallbackTimeoutMs` (fixture default 10, null disables, `"default"` omits the operation override to exercise the library's 60-second default), `readTimeoutMs` (fixture default 50; `"default"` omits the adapter option to exercise the library default), `localMaxSize` (default 10,000), `shadowMaxInFlight` (default 1), and `recovery` (`allow`, `deny`, `error`, or default timeout-only classification). An operation can override the instance classifier with `begin.recovery`. Optional `comparator` supplies `equal`, `unequal`, or `error`; omitted comparison uses ordinary value equality. Optional `comparisonMs` makes that external callback consume the specified elapsed time before returning or failing, without delivering timers. These are controlled callback outcomes, not an expression language. `shadowHook: false` omits the required outcome observer; `observerFailure: true` makes installed observers fail; `remote: false` omits the Redis adapter. `probeSourceScope: true` records whether caching is enabled when each actual source invocation begins. Shadow/recovery hooks always record terminal diagnostic outcomes. Optional `observe` selects additional public events (see below); it does not change policy or execution. Compression writes are disabled; existing compressed entries can be seeded to check decoding and recovery. Envelope interoperability is also covered separately by protocol vectors.

Optional `sourceWorkMs` consumes that many milliseconds of elapsed external work inside each actual source invocation before it returns its unresolved fixture gate. Wall and elapsed clocks advance together; no timers or scheduled cache work run during this segment. This supplies a schedule in which the dark-shadow budget can expire before its deferred job starts, while the source remains independently settleable. Ports provide the same external callback/executor ordering through their controlled environment; neither expected observations nor private cache state select when the job runs. The default is zero work.

Keys use namespace `urn`, key type `id`, use case `Behavior`, and ID `1` unless an input overrides `useCase` or `key`. The fixture value domain is JSON scalars (numbers, strings, booleans, null) plus an absent value. The test serializer uses JSON for scalars and the unquoted literal `undefined` for absence. An omitted input value denotes absence, represented in observations by `{"absent": true}`; the ordinary string `"undefined"` stays a string and cannot be mistaken for it. A port may use an option/unit value or its own fixture sentinel. This custom serializer tests cacheability without prescribing a language's JSON API or reference identity.

Wall time starts at `2026-09-08T12:00:00Z`; monotonic time starts at zero. Elapsed time advances through `advance` or configured external source/comparison work; `shiftWall` changes application wall time independently, preserving monotonic time and Redis physical expiry. Local entries use monotonic age; frame age and watermark proposals use application wall time. The fake Redis expiration clock advances with elapsed time independently of application wall-clock steps. Tracked reads atomically acquire a value and watermark. Watermarks remain available through the trace. A native write's frame timestamp is captured when the adapter receives it, before any held transport completion.

## Inputs and completion boundaries

| Input | Meaning |
| --- | --- |
| `begin` | Start a public call and assign its ID by invocation order. Default: a new enabled scope lasting through this call. Optional `key`, `useCase`, `instance` (default `default`, or the named scope's instance), `recovery`, `scope`, `outside: true`, or `disabled: true`. Return control when runnable work blocks or the call settles. |
| `resolve` | Settle the specified external `loader` with scalar `value`, or the absent fixture value if omitted. Loader IDs are actual invocation order, distinct from caller IDs. |
| `reject` | Reject `loader` with that loader's unique source error. Optional `error: "timeout"` marks an error propagated by the source as a fallback timeout; it remains that source's logical error token. |
| `advance` | Advance both clocks by `ms` and deliver due timers. With `deliverTimers: false`, advance clock observations without delivering pending timers; later settlement must still enforce the deadline. |
| `shiftWall` | Shift application wall time by signed `ms`, without advancing elapsed time or changing Redis physical retention. This is a clock observation, not a timer delivery. |
| `seed` | Environment stores a frame for `key` and optional `useCase`: `value`, `ageMs` (default 0; negative is future), optional physical `ttlMs` (default 60,000). `frameHex` instead supplies exact raw bytes. This is external setup, not a DialCache write. |
| `invalidate` | Call public targeted invalidation for `key`, with `futureBufferMs` default 0; await completion. Record its success, controlled mutation failure, or missing-remote-resource error. |
| `observeMarker` | Observe the environment's tracked watermark for optional `key`, including remaining physical TTL. The fixture must select the `marker` observation. |
| `policy` | Replace the runtime overlay with `value` (or `null` to inherit). Existing entries and already accepted invocation snapshots retain their contracts. |
| `faults` | Update environmental flags: `read`, `write`, `dump`, `load`, `policy`, `observer`, `localStorage`; and gates `holdReads`, `holdWrites`, `holdDumps`, `holdLoads`, `holdPolicies`. Unmentioned flags retain their values. Flags start false. `localStorage` requires the dedicated local-failure fixture described below. |
| `release` | Complete a held `effect` (`read`, `write`, `dump`, `load`, `policy`) by its zero-based invocation `index`. A released read acquires the environment's current atomic snapshot. Optional `fail: true` rejects only this effect. |
| `openScope` | Open context `id` for optional `instance`, optionally nested inside `parent` (whose instance is inherited). `disabled: true` opens a disabled context; otherwise it calls enable. Save its execution context for later inputs. |
| `closeScope` | Complete context `id`. Retain its context handle so later `begin` inputs can exercise detached work after closure. Nested scopes reuse the outer request memo lifetime. |

Only unresolved external operations are gated. A port can use its own executor and explicit request-context handles. It must not reproduce Node Promise turns. The TypeScript driver captures its execution context inside public enable/disable calls; it does not read DialCache's context internals.

## Additional composition profiles

The following profiles extend the existing ownership models. Their exact bounds,
checked properties and replayed regressions are registered in `execution.json`.
Each records explicit public inputs as described in `AUTHORING.md`; expected
observations never select a command, effect index or source result.

| Profile | Boundary and distinguishing public observations | Executable mapping |
| --- | --- | --- |
| `recovery-read` | Request/local/remote traversal, retained snapshots, held reads/decoding, compressed candidates, frame rejection and watermark lifetime. New public requests distinguish retained bytes from current Redis state. | [Fixture and actions](./replay/profiles/recovery-read.mjs) |
| `local-failure` | Local storage exceptions, accepted source outcomes and request-only reuse. A failed local read remains publication-ineligible even after the fault is cleared before source settlement. | [Fixture and actions](./replay/profiles/local-failure.mjs) |
| `runtime-boundaries` | Exact serving cohort thresholds, leaf inheritance and validation, falsy/absent values, and feature toggles. Results and later layer reuse distinguish policy admission from mere policy input selection. | [Fixture and actions](./replay/profiles/runtime-boundaries.mjs) |
| `shadow-layers` | Dark and served shadow work combined with request/local publication, independent caller sources, per-instance job capacity, captured fill policy and propagated source errors. | [Fixture and actions](./replay/profiles/shadow-layers.mjs) |
| `source-budgets` | Default, unbounded and finite source budgets; held policy resolution, outside calls, invalid keys, late followers and late results after retry. | [Fixture and actions](./replay/profiles/source-budgets.mjs) |
| `local-clock` | Fractional native time with whole-millisecond local insertion and expiration, including instances constructed at different process times. | [Inputs and observations](./replay/local-clock.mjs) |

This table summarizes scope. The linked modules define exact choices and command
mappings; [bindings.mjs](./replay/bindings.mjs) connects their fixtures, setup and
assertions to the coordinator. Shared feature projections live in
[features.mjs](./replay/features.mjs).

The local-failure fixture keeps real storage behind a narrow native failure
seam: TypeScript throws from the local storage call; Go throws through the
local clock observation while retaining the precise clock for deadlines and
diagnostics. Reads are faulted only when an entry exists, because Go's missing
entry path does not consult that clock. Healthy operations use real storage.
These tests add no production fault-injection API and make no claim about
elapsed time or overlapping sources.

The local-clock profile has a dedicated runner. It advances environment time
in microseconds and constructs actual default cache instances. Replacing their
clocks with the common integer test clock would erase the boundary under test.
Its fixture contains immediate healthy sources and no Redis, request memo,
policy provider or precise source/read/shadow deadline work.

Common value projections reserve code `11` for the ordinary text `"undefined"`,
distinct from absent code `5`; code `10` remains invalid. Optional read, marker
and compression projections compose with caller outcomes, diagnostics and
external effect counts. Unselected observations remain outside a profile's
claim.

Gates delay external completion, not DialCache policy capture. A held policy
provider observes the current runtime overlay and provider-failure flag **when
released**; the invocation captures that reply afterward. Read/write/codec fault
flags are likewise observed after the corresponding gate releases. Serializer
arguments and a dispatched write's bytes/timestamp are captured at invocation;
a released read instead acquires the then-current atomic remote snapshot. This
defines the fixture environment; production providers may choose their own
reply values and only their delivered replies determine policy.

Calls may remain pending at a scenario's end. Drivers release fixture-owned work during cleanup; cleanup effects are outside the trace and cannot satisfy its assertions. Unknown operations, missing effects, and repeated settlement fail replay.

## Observations

- `calls`: every caller, in start order, is `{"status":"pending"}`, `{"status":"value","value":1}`, or `{"status":"error","error":"source:0"}` / `"timeout:0"`. Source IDs identify the original loader error; timeout IDs identify distinct timeout outcomes in observation order. Coalesced followers must receive the same error identity. Ports can compare a shared logical error token without adopting JavaScript object identity.
- `loaders`, `reads`, `writes`, `invalidations`, `loads`, `dumps`, `policyCalls`: cumulative actual loader, adapter, serializer, and provider invocations. Failed and still-pending attempts count. Value writes and invalidations are separate.
- `classifications`, `comparisons`: actual invocations of the fixture-owned classifier/comparator. Built-in defaults are not instrumented.
- `sourceScopes`: actual source-entry enablement observations when the explicit scope probe is enabled; otherwise empty.
- `writeTtls`: actual requested physical write TTLs in milliseconds, in dispatch order.
- `maintenance`: public invalidation outcomes, `ok`, `mutation_error`, or `missing_remote`. The last category records the actual public error; a port need not reproduce its native class or text.
- `shadow`, `recovery`: terminal outcomes from the public diagnostic hooks, in observed order. Exact telemetry timing and ordinary metrics are not asserted.

A returned cache value, loader invocation, or acknowledged write does not prove publication. Subsequent calls test cache retention and invalidation. Negative harness tests deliberately remove recovery, local storage, and acknowledged invalidation and require a later observable divergence.

### Additional fixed-scenario inputs

`adapterReply` stages one JSON-shaped semantic adapter result for the next successful raw-read settlement. Only one result may be staged at a time. The driver supplies it to the real cache at the adapter boundary; it neither decodes it on behalf of DialCache nor records a predicted miss/hit. Existing held reads and read failures remain independent. Tests use invalid replies to check the core's normalization; ports whose adapter type cannot represent malformed replies can enforce that boundary when decoding external input.

`seed.payloadText` supplies exact UTF-8 text serializer bytes; `seed.payloadHex` supplies raw binary serializer/envelope bytes, framed with the current wall timestamp minus `ageMs`. `seed.frameHex` remains a complete frame, including header; ordinary `seed.value` still uses the scalar fixture codec. These inputs change only the fake Redis environment.

## Generated pending-effect profile

The effects model fixes remote-only policy to 60 seconds, a 10 ms source deadline and separately configured read budgets, and held read/decode/serialize/write effects. It bounds each trace to eight callers and eight sources; successful values are 1. Model monotonic time and application wall time are separate. No local cache, recovery, shadow work, or physical expiry is enabled in this profile.

| Quint action | Driver input |
| --- | --- |
| `init` | Choice 0..5 configures the fresh fixture and initial policy; hold reads, loads, dumps, and writes; observe budgets, cancellation, dispatch, and portable diagnostic events |
| `beginCall` | `begin` |
| `resolveLoader` / `rejectLoader` | Resolve with value 1 / reject, using explicit source index `choice` |
| `releaseRead` / `failRead` | Release the explicitly selected raw read with success / failure |
| `releaseLoad/Dump/Write` / `failLoad/Dump/Write` | Settle the latest corresponding actual effect with success / failure |
| `seedRemote` | Seed value 1 at the current application wall time |
| `tick` / `jumpClock` | Advance 10 ms with / without timer delivery |
| `rollbackWall` | Move application wall time back 1,000 ms, preserving monotonic time and Redis physical expiry |
| `invalidate` / `futureFence` | Invalidate with a 0 / 20 ms future buffer |
| `observerFault` | Choice 0/1 restores / fails diagnostic callbacks; cache outcomes remain unchanged |
| `adapterReply` | Choice 1..16 supplies one next raw adapter reply; a second cannot be queued until the first is consumed |
| `readBudgetPolicy` | Choice 0 inherits the operation/instance budget; choices 1..4 supply runtime budgets 10/20/30/50 ms |

Initial choices 0..4 use tracked keys; choice 5 checks untracked reply/fence behavior. The effects initial input selects these precedence cases. Budget changes affect later reads; followers retain the registered leader's budget. Read budgets are multiples of the 10 ms clock step. Clock jumps without timer delivery are generated during 10 ms reads and source/application-owned phases; larger reads use delivered timer steps.

| Initial choice | Instance | Operation default | Initial runtime | Effective read budget |
| --- | --- | --- | --- | --- |
| 0 | Omitted | Omitted | Inherit | Library 50 ms |
| 1 | 20 ms | Omitted | Inherit | 20 ms |
| 2 | 20 ms | 10 ms | Inherit | 10 ms |
| 3 | 20 ms | 10 ms | 30 ms | 30 ms |
| 4 | 20 ms | 10 ms | Provider returns null | 10 ms |
| 5 | 20 ms | 10 ms | Inherit; untracked key | 10 ms |

Each ITF state contains authoritative `input.name` and `input.choice`, plus
expected state `s`. Choices are ITF integers: read/source settlement records an
actual effect index; `observerFault` records 0/1; `init` records 0..5,
`readBudgetPolicy` records 0..4, and `adapterReply` records 1..16. Actions without
an external choice use `-1`. Optional MBT compatibility annotations must agree
with the explicit input; raw regression exports need no annotations. See the
[trace contract](./PORTING.md#trace-and-observation-contract).
The parser rejects missing, unexpected, or unsafe choices. Failure actions set a fixture fault, release the selected external gate, drain runnable work, and restore the fault. Model-only timestamps, fences, phase, and registration fields never enter execution or implementation projection.

After every step, replay compares actual caller outcomes, loader/read/write/invalidation/serializer/provider counts, physical write TTLs, actual raw-read context budgets/initial cancellation state, and ordered cancellation IDs. Model caller codes are 0 pending, 1 value 1, 2 original source error, 3 timeout. Fixed scenarios additionally compare logical error identity. A read deadline starts a fresh source budget and suppresses refill; successful raw-read completion clears that budget before application-owned decoding. Failed fresh decoding permits refill. Accepted serialization/write outlives the source budget, with the observed fence checked again after preparation.

Full validation exports 512 traces from 4,096 samples, up to 60 transitions, and requires all actions plus 79 witnesses covering abandoned source/read settlement, independent budgets, late settlement guards, application-owned phases, acquired snapshots across invalidation, failure-specific publication, clock rollback at the second fence check, and observer failure isolation. Scheduled deterministic regressions anchor their declared boundaries; [execution.json](./execution.json) distinguishes model checks from exported replays. Sampling favors the narrow rollback-during-publication boundary as well as unrestricted clock changes; it does not restrict that behavior to the favored schedule.

Full validation runs all profiles in `execution.json` through TypeScript and Go. PR checks run the committed subset alongside ordinary tests. Committed ITF smokes run without Quint. Failure diagnostics include trace, step, action, and both observations. The effects choice/state schema and scope/policy value choices changed with this specification revision; ports must select a matching revision and reject unsupported actions or choices. Behavioral scenario schema 2 is unchanged.

The queued adapter choices are: 1 null, 2 primitive, 3 legacy watermark shape, 4 kindless metadata, 5 missing miss reason, 6 unknown reason, 7 unknown reason with valid future fence, 8 fenced reason without fence, 9 negative fence, 10 fractional fence, 11 unsafe fence, 12 absent reason with future fence, 13 expired reason with zero fence, 14 miss with stray frame fields, 15 valid frame with stray miss metadata, and 16 fenced reason with valid future fence. Future fences are the input wall clock plus 20 ms. Successful raw completion consumes the reply even when DialCache has abandoned that read; adapter failure leaves it queued. Ports with strongly typed replies may normalize these encodings at their input boundary, but must preserve the resulting miss/refill behavior.

`s.events` records `{ event, location, detail, amount }`. Location identifies a reached layer or coalescing scope. Amount is an integer millisecond measurement (get, fallback, serialization, future offset), a byte size, a write-dispatch index, or zero. Replay converts model milliseconds to callback seconds and compares actual ordered events, their labels, and source-error attribution. A follower emits its coalescing event without repeating the leader's read/source trail. Fresh decoding is included in remote-get duration; source duration ends at accepted settlement/deadline; dump has its own duration. Late sources do not repeat failures. Size events precede actual adapter dispatch, including when that write remains pending. Scalar value 1 has one serialized byte here; Unicode/binary byte accounting remains covered by protocol vectors and fixed scenarios.

The profile requires 36 fixture/race witnesses plus 43 adapter/diagnostic witnesses: every reply class consumed by an active read, untracked fence demotion, normalized fences blocking publication, every selected event kind, error/miss categories, and nonzero held load/dump durations. Seven additional deterministic regressions anchor normalization, phase timing, and late-failure suppression. Missing/corrupted diagnostic observations fail the harness.

## Generated feature profiles

Seven additional models share the existing driver and a common [observation record](./conformance-observations.qnt). Their ITF states contain authoritative `input.name` and `input.choice`, with `s.o` as the expected observation. State outside `s.o` and the optional diagnostic record `s.d` is model-private prediction, not an implementation observation. The explicit choice is a nonnegative ITF integer on actions with choices below, or `-1` otherwise. Optional `mbt::actionTaken` and `mbt::nondetPicks.choice` annotations must agree with it. Reject unknown actions, unsupported choices, missing observation fields, and integer precision loss.

Call observations encode pending as 0, fixture values 1/2 as 1/2, source errors as 3, and deadline errors as 4. Success codes 5..9 represent absent, null, false, zero, and empty string respectively; scope/policy generate these values. Other outcomes fail replay. These profiles compare error categories; the fixed scenarios compare logical error identity. All other observation fields use the scenario vocabulary directly, including zero/empty fields. A driver must use explicit action choices for selected source indices and its actual invocation counts for actions targeting the latest effect. It must never use expected counters, phases, cached values, or fences to select an input or fabricate an observation.

| Profile | Fixture and bounds | Generated coverage |
| --- | --- | --- |
| [Independent](./dialcache-independent-conformance.qnt) | Tracked same-key calls, coalescing disabled, six callers, independent read/source/decode gates, read budgets 5/10 ms, F=1 s and captured M=2/5 s | Per-call cancellation, late effects, refill authority, recovery snapshots/policy and original source-error identities |
| [Layers](./dialcache-layers-conformance.qnt) | Two instances, three persistent contexts, four identities, tracked/untracked and capacity 0/2 fixtures, twenty calls | Request/process sharing, layer precedence, LRU promotion/eviction, per-instance capacity, tracked local warming and operation-group invalidation |
| [Admission](./dialcache-admission-conformance.qnt) | Tracked served remote hits, three keys, two instances, two shadow slots per instance, held reads/decodes, 10 ms job deadline, up to sixteen callers | Same-key deduplication, capacity drops, instance isolation, coalesced hits, policy snapshots, disabled detached sources, match/mismatch/supersession, capacity retained through timed-out source/decode/C1 work |
| [Scope](./dialcache-scope-conformance.qnt) | Request-only, one key, two outer lifetimes, three nested contexts, one held provider reply, independently settled sources, no deadline, up to sixteen callers | Scope isolation/closure/replacement; nested and disabled contexts; reenablement; pending policy at closure; shared rejection/retry; request/coalescing policy changes; late source settlement |
| [Recovery](./dialcache-recovery-conformance.qnt) | Tracked remote with optional request memoization in two contexts, F=1 s, M initially 5 s, 10 ms source deadline, held decoding, up to eight callers | Fresh/stale/future frames; F/M boundaries; allow/deny/failing classifier; coalesced followers; source success versus rejection/deadline; default timeout-only classification and explicit overrides; abandoned source settlement; age checks around decode; invalidation/replacement; read/decode failures; captured recovery policy |
| [Policy](./dialcache-policy-conformance.qnt) | Untracked local+remote, both TTLs initially 1 s, M=5 s, local capacity one, two keys, one held provider reply, independently settled sources, no source deadline, up to twelve callers | Runtime coalescing on/off, per-source policy snapshots, shared versus independent same-key work, cross-key overlap and reverse settlement; independent runtime leaves; invalid local/remote TTL; provider/read/dump/write failure; policy acquisition and pending publication; local eviction/insertion TTL; logical Redis freshness versus physical retention |
| [Shadow](./dialcache-shadow-conformance.qnt) | Tracked remote TTL=60 s, serving ramp=0, shadow ramp initially 100 (runtime 0/100/invalid), optional outcome hook, caller/job deadline=10 ms, all read/load/dump/write effects held, up to eight callers | Independent dark C0/source settlement; captured payload decode; match/mismatch/C1 supersession; confirmation failure; conditional fills; source/read/decode/dump/write failure; deadline during held effects; late work cannot change emitted outcomes |

Recovery opens contexts 0 and 1 in every fixture. New calls use open contexts; the separate scope profile covers detached calls after closure. Request misses may join the same process flight, after which each attached open context memoizes its result. A same-request follower records request coalescing; a new request records process coalescing. Recovered values have no shared-cache publication. Closing a context clears its memo and prevents late recovery from populating it. Four required witnesses include a recovered memo hit, later probes of both requests after shared recovery, a new read after closed-scope recovery, and request followers sharing recovery work. Three deterministic regressions anchor these cases.

Policy and recovery separate wall timestamps from elapsed time. Generated public probes require local hits to survive a rollback before their original TTL, expiry at that TTL despite rollback, remote future-frame rejection, and retained recovery rejection when rollback makes its candidate future-dated. Physical Redis expiry remains independent. Invalidation never lowers an existing watermark. Four deterministic regressions anchor these clock rules.

Recovery begins with value 1 seeded at age 1,000 ms. Policy and shadow begin with empty storage. Every trace gets a fresh fixture. The shadow profile permits another call once its preceding source and owned job work have settled. The separate admission and shadow-layers profiles exercise cross-key capacity/drop and mixed ownership boundaries alongside fixed scenarios. Recovery advances through a source deadline before the end of a larger elapsed-time step; recovery starts at that deadline and its held decode may complete later. The retained snapshot and source-error identity survive late source settlement. Recovery initial input 0/1/2/3 selects the timeout-only library default or an instance classifier that allows, denies, or throws; 4..7 selects the same classifier with request-local caching enabled. Operation choice 3 inherits that instance policy; 0/1/2 replaces it with allow/deny/error. Full validation requires all eight initial fixtures, both directions of operation override, instance allow on ordinary source errors, instance denial on source deadline, and classifier-error preservation of the source failure. Policy admits another invocation after the preceding provider reply is released, even while its source remains pending. Sources can settle in any order; same-key followers join only while their current policy permits sharing. A shared leader remains registered when an independent source publishes or fails. Request scopes have their own generated profile; held publication remains outside this policy profile.

Common actions reuse the scenario inputs: `releaseRead/Load/Dump/Write/Policy` releases the most recently observed corresponding external effect in scope/recovery/policy/shadow; admission and independent instead select explicit pending read/load indices; `readFault/loadFault/dumpFault/writeFault/providerFault` sets that failure flag from choice 0/1 (provider uses `faults.policy`). Shadow `rejectLoader` rejects the latest actual loader; recovery/scope/policy/admission/independent settlement selects an explicit source index. No action reads or mutates the cache's internal state.

| Profile/action | Input mapping and allowed choices |
| --- | --- |
| Recovery `closeScope` | Close context choice 0/1; late work can finish but cannot memoize into the closed context |
| Recovery `beginCall` | Choice 0..7: context `floor(choice / 4)` and operation classifier `choice % 4` (allow/deny/error/inherit) |
| Recovery `joinCall` | Begin in context choice 0/1 while shared work is pending; a preexisting request memo can still win |
| Recovery `resolveLoader` / `rejectLoader` / `rejectTimeout` | Choice 0..7 selects an unsettled source; resolve with value 2 / reject with ordinary error / reject with a propagated timeout error |
| Recovery `seed` | Choices 0..6 give ages `[0,999,1000,4999,5000,-1,1000]` ms; value 1 except choice 6 gives value 2 |
| Recovery `advance` | Elapsed time choice 1, 10, 1000, or 4000 ms, with timers delivered |
| Recovery / Policy `rollbackWall` | Move only the application wall clock back 1,000 ms; local deadlines and physical expiry retain elapsed time |
| Recovery `invalidate` | Public invalidation with zero future buffer |
| Recovery `policy` | Set `staleOnErrorMaxAgeSec` to choice 2000/5000 divided by 1000 |
| Policy `beginCall` | Key is string `"0"` or `"1"` from choice 0/1 |
| Policy `resolveLoader` | Choice 1..84 encodes source index `floor((choice - 1) / 7)` and the value at `(choice - 1) % 7` in `[1,2,absent,null,false,0,""]`; only pending sources are generated |
| Policy `rejectLoader` | Reject the explicitly selected source index, choice 0..11; only pending sources are generated |
| Policy `seed` | Choice 0..3 supplies key `floor(choice/2)` with value `1 + choice%2`, current wall stamp, and 5 s physical TTL |
| Policy `advance` | Elapsed time choice 1, 500, 1000, 2000, or 5000 ms |
| Policy `policy` | Replace overlay using the numbered table below |
| Shadow `init` | Choice 0..3 selects default/equal/unequal/error comparison; 4..7 selects the same comparison with mismatch logging enabled; 8 omits the outcome hook; 9/10 supplies equal/error comparison consuming 10 ms; 11/12 uses default comparison and consumes 9/10 ms of external source work before deferred job dispatch. Logging is initially off for 8..12 |
| Shadow `rollbackWall` | Move the wall clock back 1,000 ms without changing elapsed time |
| Shadow `logPolicy` | Choice 0/1 disables/enables logging; choice 2 supplies the malformed string `"invalid"`. Newly admitted eligible jobs record a configuration error and capture logging off for choice 2; omitted ramp inherits the fixture default |
| Shadow `shadowPolicy` | Choice 0/1/2 replaces the runtime overlay with shadow ramp 100/0/101; omitted logging inherits the fixture default |
| Shadow `beginCall` | Plain `begin` |
| Shadow `resolveLoader` | Resolve latest loader with choice 1/2 |
| Shadow `seed` / `reencode` | Store the explicit payload choice below at current wall time; `reencode` chooses the alternate text/binary form of the currently stored bytes during C1 |
| Shadow `seedUnicode` | Store text/binary multibyte JSON using choice 7/8; this extra environment branch increases representation-boundary sampling while ordinary `seed` retains all payloads |
| Shadow `advance` | Elapsed time choice 1/10 ms, delivering due timers; blocked-source fixtures 11/12 use only 10 ms windows |
| Shadow `advanceWall` | Move only the application wall clock forward by choice 1/60000 ms while C1 confirmation is pending; elapsed deadlines and physical Redis TTL do not advance |
| Shadow `invalidate` | Public invalidation with future buffer choice 0/20 ms |

Shadow payload choices 1/2 are text JSON `1`/`2`; 3/4 are binary hex `31`/`32`; 5 is binary `2031`; 6 is text ` 1`; 7 is text JSON `"café"`; 8 is binary `22636166c3a922`. Thus text and binary may share exact UTF-8 bytes, while different byte spellings may decode to the same value. Comparison uses decoded values; confirmation uses bytes. `reencode` records the replacement payload as an explicit choice, so a driver never consults expected storage. Required witnesses include both Unicode text/binary confirmation directions, equal decoded values superseded by different bytes, binary C0 decoding, and successful/failing comparison exhausting the deadline. Timer delivery is not required for elapsed-time rejection.

Policy overlay choices replace the entire runtime overlay; omitted leaves inherit the fixture's defaults:

| Choice | Overlay |
| --- | --- |
| 0 | Empty/inherit |
| 1 | Local TTL 2 s |
| 2 | Remote TTL 2 s |
| 3 | Local serving ramp 0 |
| 4 | Remote serving ramp 0 |
| 5 | Invalid local TTL -1 s |
| 6 | Invalid remote TTL -1 s |
| 7 | Recovery maximum age 2 s |
| 8 | Both serving ramps 0 |
| 9 | Remote TTL 4 s, recovery disabled (maximum age 0) |
| 10..19 | Same overlay as choice minus 10, with `coalesce: false`; other choices inherit default sharing |
| 20 | Invalid remote read budget 0: bypass all caching for the invocation |
| 21 / 22 | Invalid local / remote ramp 101: disable that layer while preserving the other |
| 23 / 24 | Invalid recovery maximum age 1 / -1 s: normal serving remains active, writes use ordinary 1 s retention |
| 25 | Invalid shadow ramp 101: normal fresh serving remains active |

Five deterministic policy regressions anchor invalid budget, per-layer ramp, optional recovery retention, and fresh-hit shadow-policy behavior. The generated sample requires each boundary, including a Redis hit under invalid shadow policy and both invalid recovery retention cases. Independent Redis seeding makes external replacement/read scenarios reachable.

Generation exports 512 recovery traces from 4,096 samples, and 512 policy traces from 2,048 samples and 1,024 shadow traces from 4,096 samples, at most 60 transitions each. Actions are sampled in progress/environment groups so repeated environmental changes do not crowd out useful completion paths; C1 favors completion and logging changes while retaining replacement, fencing, read failure, time, and admission-policy changes. This changes exploration frequency, not the allowed transition semantics.

Full validation requires every named action, all three recovery outcomes, recovery across invalidation, coalesced recovery, age-out during decoding, local/remote hits, changed-policy publication, physical TTLs of 1/2/4/5 seconds, both C0/source orders, all twelve modeled shadow outcomes, and a write completing after shadow timeout. These witness checks fail if a configured corpus misses its promised paths. They establish occurrence only. The separate verification models still reason about wider abstractions such as shadow admission, and the portable fixed corpus covers additional binding-independent boundaries.

Scope and recovery expose `s.d = { warnings, ages, coalesced, fallbackErrors }`. Shadow profile version 2 adds `configErrors`, counting actual `config_resolution` events with remote/non-fallback labels. Other profile diagnostic schemas are unchanged. Ages are integer milliseconds in Quint and compared to actual callback seconds after unit conversion. The driver obtains this projection only from observed callbacks; it checks their operation/outcome labels and retains their order. Recovery records age only after successful retained decode. Shadow records original-C0 age at match/confirmed-mismatch verdict, clamped to zero after wall rollback; it emits a warning only for a confirmed mismatch whose admitted policy enabled logging. Later runtime changes do not rewrite that policy. Malformed logging leaves comparison active and warnings disabled. C1 compares retained payload identity even when a replacement timestamp is future-dated. Exact native JSON warning formatting remains a binding obligation.

`coalesced` records actual request/process scope labels; `fallbackErrors` records the source-failure layer, including failures later recovered as stale. Scope fixtures assert one trail for shared failures, no cache-error trail for disabled pass-through work, and `noop` attribution if the request closes while policy is pending. Admission-time attribution survives later scope closure. Three deterministic scope regressions and five diagnostic witnesses anchor these consequences. Other cache/maintenance errors are outside this feature diagnostic projection and remain checked by effects and fixed scenarios.

Thirteen shadow fixtures, both custom comparison overrides, comparison failure, both captured-logging directions, logging on/off, malformed logging at a completed mismatch, no warning for match/supersession, clamped age, and positive verdict age are required witnesses. Eighteen deterministic shadow regressions anchor these rules. Required witnesses also cover no job without the outcome hook, disabled/invalid policy skipping new jobs, and an admitted job completing under its original policy. Missing or corrupted diagnostic expectations must fail harness checks.

Fixtures 11/12 use the existing external `sourceWorkMs` input, advancing elapsed and wall time without delivering timers while the source begins. At 9 ms, the dark job still dispatches C0 and an immediately settled source can succeed. At exactly 10 ms, the deferred job reports timeout without a Redis read, while the caller remains pending. Subsequent source resolution or rejection produces the caller's deadline error when settlement checks elapsed time; delivering its timer may produce that error first. These fixtures advance in full 10 ms windows after the blocked work, observing after overdue timers are delivered; intermediate native timer ordering is outside their bounds. This distinguishes job abandonment from source timer delivery. Generated witnesses require both boundaries and both late settlement outcomes. The `expiredSourceWorkSkipsRedis` invariant independently forbids reads in the exhausted-work fixture; warning authorization is checked against captured valid policy separately from verdict emission.

`test/formal-features.test.ts` replays these traces and checks parser/assertion trust boundaries. Fast PR checks use the committed `recovery-smoke.itf.json`, `policy-smoke.itf.json`, and `shadow-smoke.itf.json` without Quint. Full validation replays every generated trace. To replay a downloaded artifact:

```sh
DIALCACHE_FEATURE_TRACE_FILE=.formal-traces/features/recovery/trace_0.itf.json \
  corepack pnpm exec vitest run test/formal-features.test.ts --coverage.enabled=false
```

Full policy validation requires six additional concurrency witnesses: cross-key overlap, uncoalesced same-key overlap, a join after policy changes, reverse source settlement, one source settling multiple callers, and publication while another provider reply is held. Its committed smoke is a generated prefix containing a shared rejection and a later independent settlement; it also runs without Quint. Policy settlement choices changed with the concurrent profile, so replay these traces with the matching specification revision.

The parent `independent/`, `layers/`, `scope/`, `recovery/`, `policy/`, `shadow/`, or `admission/` directory identifies the fixture. To replay a whole generated feature corpus, set `DIALCACHE_FEATURE_TRACE_DIR=.formal-traces/features` instead. Keep a failing trace with its profile directory when copying it.

## Generated independent-caller profile

[`dialcache-independent-conformance.qnt`](./dialcache-independent-conformance.qnt) tests the same key with coalescing disabled. The single registered-flight models cannot express independent acquired reads and recovery chains; this companion reuses the existing driver and effect vocabulary. Six callers can each own one read, one source, and one decode. Tracked remote freshness is 1 s, initial recovery maximum age is 5 s, read budget is 5 ms, and source budget is 10 ms. Recovery classification allows ordinary errors and timeouts. Value 1 initially has age 1,000 ms and physical TTL 60,000 ms. Only raw reads and decoding are held; accepted publication completes at the source-settlement boundary.

| Action | Environment/public input |
| --- | --- |
| `beginCall` | Begin another independent same-key call |
| `releaseRead` / `failRead`, `releaseLoad` / `failLoad` | Complete or reject the explicitly selected actual read/decode index, 0..5 |
| `resolveLoader` | Choice 1..12: source `floor((choice - 1) / 2)`, value `1 + (choice - 1) % 2` |
| `rejectLoader` | Reject source index 0..5 with that source's logical error |
| `advance` | Advance 1, 5, 10, or 1,000 ms and deliver due deadlines |
| `seed` | Choice 0..5: values `[1,1,2,1,2,1]`, ages `[0,1000,1000,4999,0,1999]` ms, physical TTL 60,000 ms |
| `invalidate` | Public invalidation with zero future buffer |
| `policy` | Choice 0..3: read budget 5 ms for even choices, 10 ms for odd; recovery maximum age 5 s for 0/1, 2 s for 2/3 |

Each call captures its read budget and recovery policy. Read failure or timeout cannot borrow another call's refill authority. Each recovery chain retains its own eligible bytes and original source error. Later invalidation cannot revoke an already acquired fresh decode or stale candidate; recovery still rechecks age around decode. Late raw read/source settlement cannot affect another call. The environment delivers deadlines in time order, using registration order for equal instants, including new source deadlines reached within one advance. This is the supplied schedule; other runtimes need not use the same timer implementation.

Besides the common `s.o`, replay requires `s.io = { budgets, aborted, sourceErrors }`. `budgets` records actual adapter read budgets in read invocation order; `aborted` records actual cooperative cancellation indices in delivery order. `sourceErrors` has one entry per caller: zero unless the caller returned its source's ordinary error, otherwise the one-based actual source identity. The driver projects actual adapter callbacks and returned error tokens; model-private ownership records never enter execution. Parser and corrupted-budget tests protect that boundary.

Full validation emits 512 traces from 2,048 samples, up to 60 steps, and requires every action plus sixteen witnesses covering separate budgets/deadlines, distinct recovery values/errors, captured age policy, failed-read refill suppression, acquired observations across invalidation, and late completion isolation. Six deterministic model regressions anchor these rules. The committed `independent-smoke.itf.json` replays without Quint. Coalesced recovery, scope lifetimes, wall rollback, and held publication retain separate profile coverage; this model does not combine every feature.

## Generated layer-composition profile

[`dialcache-layers-conformance.qnt`](./dialcache-layers-conformance.qnt) connects request memoization, process flights, local storage, Redis, and source publication. The separate scope and policy profiles isolate lifetime and policy history; composition is needed to test a request miss joining a process flight, per-instance storage shared across operations, and the publication consequences of tracked reads.

The initial **input choice**, never expected model state, selects the fresh fixture:

| `init` choice | Identity and Redis adapter | Local capacity per instance |
| --- | --- | --- |
| 0 | Untracked, adapter present | 2 |
| 1 | Tracked, adapter present | 2 |
| 2 | Untracked, adapter present | 0 |
| 3 | Tracked, adapter present | 0 |
| 4 | Untracked, adapter absent | 2 |
| 5 | Tracked, adapter absent | 2 |

Modes 4 and 5 omit the Redis adapter and require public local-hit reuse after explicit invalidation reports `missing_remote`; no adapter mutation is dispatched. All modes enable request-local caching and 60-second local/remote TTLs, with no source deadline. Sources are held independently; other external effects settle at their action boundary. Two instances share Redis but own their local capacity and process flights. Persistent contexts 0 and 1 belong to instance 0; context 2 belongs to instance 1. Contexts 3 and 4 mean a fresh invocation scope on instance 0 and 1 respectively. This is an input-level fixture description, not a requirement to reproduce any host context API.

| Action | Input mapping |
| --- | --- |
| `beginCall` | Choice 0..19: context `floor(choice/4)`, identity `choice%4`; identity maps to entity `floor(identity/2)` and operation `Layers0`/`Layers1` from `identity%2` |
| `resolveLoader` | Choice 1..40 selects source `floor((choice-1)/2)` and value `1+(choice-1)%2` |
| `rejectLoader` | Explicit pending source index 0..19 |
| `closeScope` | Persistent context 0..2; captured handles remain usable for detached calls |
| `policy` | 0 all layers; 1 disable request; 2 disable local; 3 disable remote; 4 request only; 5 no serving layers |
| `seed` | Choice 0..7 selects identity `floor(choice/2)` and value `1+choice%2` |
| `invalidate` | Entity 0/1, affecting both tracked operation variants |
| `tick` | Advance 1 ms |

At most twenty calls and eighty steps keep entries fresh throughout this profile; TTL boundaries remain in policy/scenario coverage. There are four logical identities, so a two-slot local cache can demonstrate read promotion and eviction, while request storage can exceed that capacity. Successful source completion publishes only to participating eligible layers. Tracked remote fallback skips direct local publication; an authoritative hit can warm local. Invalidation fences subsequent remote reads while acquired request/local values survive. Policy changes preserve admitted sources' publication decisions.

Full validation exports 512 traces from 2,048 samples. Required witnesses include all six fixtures and local reuse without Redis before and after a surfaced maintenance error, cross-request process sharing, zero-capacity sharing/reload, uncapped request memoization, LRU promotion/eviction with later public probes, per-instance capacity, tracked read warming, local survival across invalidation, both operation variants fenced, and untracked reads ignoring markers. Private model records select reachability witnesses only; storage-related witnesses require actual replayed calls that probe their predictions. They never control the adapter or become implementation observations. Scheduled deterministic regressions anchor these boundaries, and a committed generated smoke runs without Quint. The current regression and witness inventories are in [execution.json](./execution.json) and [coverage-witnesses.json](./coverage-witnesses.json).

This profile uses the same observations and public/environment inputs as the other feature profiles. It adds initial fixture choices; drivers must reject unsupported choices. Larger capacities, more scopes/instances, mixed deadline/recovery/shadow combinations, and expiry during LRU ordering are outside its generated bounds.

## Generated request-scope profile

The scope profile reuses the same `openScope`, `closeScope`, `begin`, policy, and source-settlement inputs. It adds no public API or driver mechanism. It starts with enabled outer context `0`, held provider replies, request-local caching on, no shared storage, and the source-scope probe enabled. Its single key isolates request-lifetime semantics from the storage/TTL state in the policy profile.

| Context choice | Meaning |
| --- | --- |
| 0 | Initially open outer request |
| 1 | A separately opened outer request; it may overlap or replace 0 |
| 2 | Enabled context nested under 0 |
| 3 | Disabled context nested under 0 |
| 4 | Enabled context nested under 3, reusing 0's live memo lifetime |
| 5 | Outside every request; only usable by `beginCall` |

`openScope` chooses 1..4, each at most once. Nested contexts open only while outer 0 is live, and 4 requires 3 to exist. `closeScope` chooses any opened, unfinished context 0..4 after the first call. Closing 0/1 clears that lifetime's memo and registered flights. Closing nested contexts does not end the outer lifetime. Captured contexts remain usable by later calls: closed outer contexts are pass-through, while completed nested contexts still belong to a live outer lifetime. These are context ownership rules; ports need not reproduce AsyncLocalStorage or Promise scheduling.

`beginCall` chooses context 0..5. Enabled calls wait for `releasePolicy`; disabled/detached/outside calls immediately start their own source without a provider invocation. At most one provider response is held, but any accepted sources may overlap. `policy` choice 0 inherits request caching and coalescing; 1 sets `requestLocal: false`; 2 sets `coalesce: false` while retaining memoization. Settlements select actual loader indices: `resolveLoader` choice 1..112 encodes index `floor((choice - 1) / 7)` and the value at `(choice - 1) % 7` in `[1,2,absent,null,false,0,""]`; `rejectLoader` chooses index 0..15. Only pending sources are generated.

The model predicts memo lifetime and flight ownership. Replay observes actual caller values/errors, source enablement, and provider/source invocations; subsequent calls establish hits or misses. A late source may return to its original caller after closure, but cannot populate a replacement memo. Coalescing admission precedes reading a memo populated by another independently accepted source.

Generation exports 256 traces from 1,024 samples, up to 60 transitions, with at most sixteen calls. Sampling keeps closure reachable while favoring useful call progress; no fairness or exhaustive context-tree claim is made. Full validation requires every action plus 24 witnesses: disabled/detached bypass, policy reply after closure, rejection/retry, shared rejection, source settlement after closure, replacement miss after that settlement, independent scope overlap, uncoalesced same-scope overlap, memo hits, nested/reenabled hits, memo reuse after nested closure, memo reuse after policy bypass, memo hits for all five empty/falsy/absent values, and five failure-attribution/shared-trail witnesses. Eight deterministic model regressions anchor closure, replacement, nested/disabled reuse, rejection/retry, and error attribution.

The committed `scope-smoke.itf.json` is a generated schedule including absent-value reuse and request closure. It runs without Quint in fast PR checks. Request deadlines, recovery, shared-process flights, arbitrary context trees, and more than two outer lifetimes remain covered separately or outside this generated profile.

## Generated served-hit shadow admission profile

[`dialcache-admission-conformance.qnt`](./dialcache-admission-conformance.qnt) reuses the existing public driver and observation schema. It separates admission and resource ownership from the dark C0/fill protocol. Three shared Redis keys initially contain value 1, with tracked serving and shadow ramps at 100%. Two cache instances each have two shadow slots. This makes a duplicate drop distinguishable from a full instance, and permits checking another instance while the first is full.

Caller reads and all decoding are held. A successful caller read acquires C0; completing its decode returns that value and considers shadow admission using the caller flight's accepted policy. Coalesced followers share this one admission. Independently accepted calls can each attempt admission. An admitted detached source runs with caching disabled. Shadow comparison uses its retained C0 and source result; unequal values trigger a held C1 read. No shadow action changes a caller result or writes cache values.

| Quint action | Portable input and choice |
| --- | --- |
| `beginCall` | Choice 0..5 selects instance `floor(choice / 3)` and key `choice % 3`, both decimal strings |
| `releaseRead` / `releaseLoad` | Release the explicitly chosen actual effect index, 0..31 |
| `resolveLoader` | Choice 1..32 selects source index `floor((choice - 1) / 2)` and value `1 + (choice - 1) % 2` |
| `rejectLoader` | Reject the chosen actual source index, 0..15 |
| `seed` | Choice 0..5 replaces key `floor(choice / 2)` with value `1 + choice % 2`; both instances observe the shared environment |
| `policy` | Choice 0 inherits enabled shadow/coalescing; 1 disables shadow; 2 disables coalescing; 3 disables both. Only new caller flights acquire the changed policy |
| `advance` | Advance 1 or 10 ms and deliver timers, bounded to 600 ms total elapsed time |

Only pending effects/sources may settle. There are at most sixteen calls and sixteen admitted jobs, giving at most 32 read and 32 decode effects. Redis TTL is 60 seconds, each shadow job's deadline is 10 ms, and the read deadline is 1,000 ms. The elapsed-time bound keeps serving reads fresh and below their separate deadline. Ordinary misses, read/decode faults, separate read timeouts, shadow fill writes, custom comparator failures, local/request layers, and fractional cohort selection retain coverage in other profiles, scenarios, or vectors.

A whole-job timeout emits one diagnostic outcome but keeps the slot until its pending source, decode, or confirmation read settles. Later completion cannot start another decode/read or emit a replacement verdict. Once the owned work drains, a subsequent hit may admit another job. This models resource ownership rather than cancellation or language executor turns.

Full validation exports 128 traces from 1,024 samples, up to 60 transitions, and requires every action plus eighteen witnesses: six terminal outcomes (match, mismatch, superseded, source_error, timeout, dropped), one admission for coalesced hits, uncoalesced hit overlap, accepted shadow policy after a change, unselected hits, duplicate drops while capacity is available, full-capacity drops, admission while the other instance is full, per-instance deduplication, capacity retained by each of the three timed-out phases, and readmission after expired work drains. Six deterministic model regressions anchor coalesced admission, duplicate drops, per-instance capacity, and all three timeout ownership phases.

The committed `admission-smoke.itf.json` retains actions, choices, and observation records from the first 57 states of a generated trace. Model-private prediction fields are omitted to keep it compact. It contains a timed-out decode, a blocked duplicate, completion of the raw decode, and subsequent admission for that key. Full generated ITF states remain in the full workflow artifacts. The existing parser replays both forms without special handling or expected-state input to the driver.

## Port workflow and limits

1. Implement the protocol/key/normalization/envelope vectors and the invalidation-transition vectors against the actual remote adapter/protocol.
2. Implement these fixture operations using public cache operations and controlled external adapters.
3. Run the committed scenarios and smoke traces.
4. Replay the same core, pending-effect, scope, recovery, policy, shadow, admission, layers, and independent ITF corpora used by TypeScript.
5. Report passing behavior families, specification revision, seed, bounds, and tool versions.

Passing covers the supplied observations and scenarios. It does not establish every feature interaction, fairness/liveness, arbitrary resource limits, or all external failures. The Go driver executes this same feature interface and generated corpus. Its native concurrency gates and source-ownership monitor use actual callbacks and contexts, while expected model state remains assertion-only. See [`TEST-MAP.md`](./TEST-MAP.md) for the remaining boundaries.
