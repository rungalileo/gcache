# Implementing another DialCache port

Implement portable behavior from the Quint models and run the shared corpus
against the real cache API. [CONTRACTS.md](./CONTRACTS.md) defines the obligations;
[FEATURE-COVERAGE.md](./FEATURE-COVERAGE.md) separates portable cases from native
binding requirements. This document defines the driver and completion boundary.
The specification is experimental and versioned in [profiles.json](./profiles.json).
Pin a repository commit and corpus when developing a port.

Start with the [worked walkthrough](./WALKTHROUGH.md) to follow one source
deadline contract from a Quint regression to its TypeScript and Go assertions.
Then use this guide to implement the remaining profiles and completion reports.

## What a port supplies

Supply a native implementation, a controlled test environment, a driver for the
shared commands, and assertion results in the completion format below.
The shared [replay coordinator](./replay/coordinator.mjs) owns profile parsing,
action mappings and observation assertions. TypeScript imports those same
modules; Go uses one persistent Node process over JSON lines. A new port can
reuse that protocol instead of translating every profile's tables.
Existing implementations
are examples: [the TypeScript driver](../test/formal/behavior-driver.ts) and
[the Go driver](../go/behavior_driver_test.go). A port need not copy their public
API names, threading model, internal storage, or scheduling implementation.

| Driver operation | Required behavior |
| --- | --- |
| Create/reset | Construct independent instances with the profile's configuration, codecs, wall/elapsed clocks, counters, and optional hooks. Start each history from its declared initialization. |
| Begin a call | Invoke the real cache API in the specified enabled, disabled, or outside scope. Record actual pending/completed callers and source invocations. |
| Scope lifetime | Create nested or sibling contexts and close exactly the requested scope. Retained references must obey the native binding's documented lifetime. |
| Source completion | Resolve or reject the specified actual loader invocation. Preserve source identity and distinguish an owned deadline from a propagated timeout error. |
| External effects | Hold/release actual policy, Redis read/write, serialization, and decoding operations by their invocation IDs. A held operation cannot finish until its external release or specified failure. |
| Clock control | Control wall time and elapsed time separately. Advance or shift only the specified clock; follow the profile's timer-delivery rule. Preserve fractional units in the local-clock profile. |
| Storage inputs | Seed the specified bytes/value/TTL or execute invalidation. The adapter must expose the requested atomic primary snapshot and maintenance result. |
| Settle | After every command, bring the implementation to quiescence under the `causally-ready-v1` contract: every task spawned by the implementation or the driver has finished or is blocked on a driver-owned gate, a driver-owned timer that is not yet due, or a driver-owned scope gate, and nothing is runnable. This obligation falls on the library as well as the test: it must expose its detached scheduling to the test executor (Go's `Defer` hook drained under `synctest.Wait`, the Node fake-timer microtask queue drained by `advanceTimersByTimeAsync(0)`) so the driver reaches quiescence without guessing turn counts or advancing deadline time. The TypeScript suite includes a no-settle control, [formal-settlement-control.test.ts](../test/formal-settlement-control.test.ts): a driver that skips its drain must fail the observation assertions of every BehaviorDriver-backed smoke history (currently all eight). Each port is expected to carry an equivalent control against its own driver. |
| Observe | Read actual caller outcomes, source/effect counts, event order, timestamps, values and error categories after the step. Collect observations independently of expected model state. |
| Cleanup | Drain or release test-owned work, restore clock/fault hooks, and isolate the next history. Unfinished work must not silently leak into another history. |

Input mappings may use previously observed driver-owned invocation IDs and
counters to select the latest actual operation. They must never use a predicted
model owner, phase, counter, cache value, or expected result to select an input
or decide when the implementation has progressed far enough.

## Shared coordinator protocol

Start `node formal/replay/coordinator.mjs` with Node 24. Send one JSON object per
line on stdin and read one response per line on stdout. Each request includes
`version: 1`, a positive integer `id`, and `op`. IDs must strictly increase for
the lifetime of that coordinator process, including across history sessions;
match each response's version and ID. Responses contain `ok: true` and `result`,
or `ok: false` and an error. [protocol.schema.json](./replay/protocol.schema.json)
defines the message, command, observation, fixture and environment shapes.
Malformed input, unknown commands, mismatched IDs, process failure and transport
timeouts fail the test. The coordinator performs no cache operations.

| Request | Purpose |
| --- | --- |
| `profiles` | Discover supported profiles/actions and settlement contract |
| `prepare` with `profile`, `path`, optional JSON-text `raw` | Validate the entire history; return a session ID, initialization fixture/setup, action names and step count |
| `observe` with `session`, `index`, `settlement`, `observed`, `environment` | Assert the actual observation for this step; return the next external commands or final completion |
| `discard` with `session` | Release an unfinished coordinator session after a failed or canceled native run |

After `prepare`, create the native fixture, execute setup and report observation
index zero. Execute the returned `inputs`, settle authorized work and report the
next index. The environment carries the driver's actual `wallMs` clock in epoch
milliseconds; behavior, effects and core drivers start it at
`2026-09-08T12:00:00.000Z` (`1788868800000` ms) and move it only through clock
commands, as the [observation contract](#observation-contract) describes.
Invocation counters and IDs also come from actual native observations. The
coordinator retains expected state; its command responses do not contain
predictions. Duplicate or skipped observation indices are errors.

The shared command definitions and per-profile bindings are in
[replay/bindings.mjs](./replay/bindings.mjs). Their normalization, dynamic input
selection and assertions are maintained once. The Go transport adapter is
[replay_coordinator_test.go](../go/replay_coordinator_test.go); native environment
control remains in the driver. Node is a test-tool dependency, not a dependency
of the Go cache library.

## Trace and observation contract

Quint exports ITF JSON. A trace contains a nonempty `states` array with an
initial state followed by public actions. Reject unknown profiles/versions,
unknown actions, malformed or out-of-domain choices, missing observations,
misplaced initialization, and empty histories.

For `explicit-v1` profiles, each state contains:

```json
{
  "input": { "name": "resolveLoader", "choice": { "#bigint": "1" } },
  "s": { "o": { "calls": [{ "#bigint": "1" }] } }
}
```

This is a structural excerpt; real observations contain all fields required by
the profile. ITF integers are decimal strings inside `{"#bigint":"..."}`.
Decode them exactly and reject unsupported ranges. `choice: -1` denotes no
external choice. An action's integer encoding belongs to its profile; the same
integer is not a universal operation or result code.

All current profiles declare explicit inputs. The coordinator reads `input`
directly, including raw Quint regression exports. Core actions have no external
arguments and use `choice: -1`. Optional `mbt::actionTaken` and
`mbt::nondetPicks.choice` annotations (`Some` with an integer or `None`) must agree
with the input when present. Core also accepts an empty picks record.
[run-models.mjs](./run-models.mjs) uses
[replay-inputs.mjs](./replay-inputs.mjs) to add compatibility annotations to
scheduled exports. A native driver using the coordinator needs no translation
step and must never infer commands from predicted states.

[CONFORMANCE.md](./CONFORMANCE.md) describes the core fixture, actions and
observations. [BEHAVIOR.md](./BEHAVIOR.md) describes the common environment,
pending effects and feature profiles; its composition table summarizes six
additional profiles and links their executable mappings. Exact fixtures,
choices and projections are connected by
[replay/bindings.mjs](./replay/bindings.mjs).
[conformance-observations.qnt](./conformance-observations.qnt) names shared
outcome encodings. Read a profile's initialization and public actions alongside
its binding; the declared units and choices are part of the versioned contract.

The `causally-ready-v1` settlement contract requires each command's authorized
native work to finish or reach a declared external gate or timer boundary before
observation. A driver supplies a controlled executor or equivalent progress
barrier. Merely waiting a fixed amount of real time is insufficient. Timer
delivery follows the command's explicit clock policy: a silent clock shift must
not deliver a timer that the history deliberately holds. Do not release held
work, advance virtual time, or poll expectations to obtain a matching snapshot.

Exact observations describe the profile's controlled schedule. Preserve required
causal order and invocation ownership. An unrelated native event order can only
be normalized when the declared observation contract allows it; sorting every
event would conceal ordering violations.
Diagnostic profiles also compare their specified event categories, counts and
timing. Private prediction fields can support model properties and witness
classification; they cannot replace observations collected from the port.

Histories may deliberately finish with pending work. Their final assertions
describe that state. Test teardown releases resources after those assertions;
it must not change the recorded history to manufacture a completed outcome.

## Observation contract

Every `observe` request carries the driver's complete current observation. Its
shape is defined under `$defs` in
[protocol.schema.json](./replay/protocol.schema.json), and the coordinator
validates each observation against the session profile's definition before
comparing it. A shape violation fails with
`Malformed replay observation: <definition> at observed.<path>`. It is an
infrastructure error, never an observation mismatch: it carries no
`expected:`/`actual:` evidence and cannot be credited to a mutation.

| Caller | Definition | Encoding |
| --- | --- | --- |
| Feature profiles (12) | `behaviorObservation` | The full behavior record below; `events` is present exactly when the fixture has an `observe` list |
| `effects` | `behaviorObservation` | The same record; the fixture observes every metric event kind plus `readContext`/`readAbort` |
| `core` | `coreObservation` | Nine nonnegative integers: `sourceVersion`, `lastResult`, `outsideLoaderCalls`, `requestLoaderCalls`, `localLoaderCalls`, `coalescedLoaderCalls`, `remoteLoaderCalls`, `redisReads`, `redisWrites` |
| `local-clock` | `localClockObservation` | The behavior record without `events`; `calls` holds the plain integer each call returned, `loaders` counts source invocations, every other counter is zero and every other list empty |

Behavior observation fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `calls` | `callResult[]` | One entry per `begin`, in begin order: `{status:"pending"}`; `{status:"value", value}` where `value` is a JSON primitive or `{absent:true}` for a call that completed without a value; or `{status:"error", error}` where `error` is `source:N` (the N-th controlled source failure), `timeout:N` (the N-th fallback deadline error) or `unexpected:<text>` |
| `loaders`, `reads`, `writes`, `invalidations`, `loads`, `dumps`, `policyCalls`, `classifications`, `comparisons` | nonnegative integer | Started effects, including held ones |
| `maintenance` | `("ok" \| "mutation_error" \| "missing_remote")[]` | Outcome of each `invalidate` command, in order |
| `sourceScopes` | `boolean[]` | `isEnabled()` inside each source invocation when the fixture sets `probeSourceScope` |
| `writeTtls` | `integer[]` | `cacheTtlMs` of each remote write, in dispatch order |
| `shadow`, `recovery` | `string[]` | `shadowValidation` and `staleRecovery` outcomes, in order |
| `events` | `observedEvent[]` | Journal of the kinds named by the fixture's `observe` list, in actual callback order |

Every event has `event`; additional label fields must be JSON primitives. The
"cache labels" below are `cacheNamespace`, `useCase`, `keyType` and `layer`.

| Kind | Required fields |
| --- | --- |
| `request` | cache labels |
| `miss`, `disabled` | cache labels + `reason` |
| `error` | cache labels + `error`, `inFallback` |
| `coalesced` | `cacheNamespace`, `useCase`, `keyType`, `scope` (no layer) |
| `invalidation` | `cacheNamespace`, `keyType`, `layer` (no use case) |
| `shadowAge`, `recoveryAge` | `cacheNamespace`, `useCase`, `keyType`, `outcome`, `seconds` |
| `futureOffset`, `get`, `fallback` | cache labels + `seconds` |
| `size`, `storedSize` | cache labels + `bytes` |
| `compression` | cache labels + `outcome` |
| `serialization` | cache labels + `operation`, `seconds` |
| `mismatchWarning` | `cacheNamespace`, `useCase`, `keyType`, `outcome`; optional `cacheKey`, `cachedValueJson`, `sourceValueJson` (string or null) |
| `readContext` | `index`, `timeoutMs`, `aborted` |
| `readAbort`, `writeDispatch` | `index` |
| `marker` | `cutoffMs`, `ttlMs` (signed; a `-1` cutoff means no watermark) |

Fixture sentinels are defined by `$defs/behaviorFixture`; `core` and
`local-clock` receive `{}`. `policy` is required. `fallbackTimeoutMs` is a
number, `null` (no deadline) or `"default"` (the library default); omitted means
10 ms. `readTimeoutMs` is a number or `"default"`; omitted means 50 ms.
`recovery` is `allow`, `deny`, `error` or `default`; `comparator` is `equal`,
`unequal` or `error`. `observe` lists event kinds from the table above, and its
presence, even empty, makes `events` required. `localMaxSize` and
`shadowMaxInFlight` are nonnegative integers; `comparisonMs` and `sourceWorkMs`
are nonnegative numbers; `tracked`, `remote`, `shadowHook`, `observerFailure`,
`probeSourceScope` and `localFaultInjection` are booleans. The coordinator
validates its own prepare response, fixture included, against this definition,
so it cannot hand a port an unknown sentinel.

`environment.wallMs` is the driver's actual wall clock in epoch milliseconds.
Behavior, effects and core drivers start their controlled wall clock at
`2026-09-08T12:00:00.000Z` (`1788868800000` ms) and move it only through
`advance`, `shiftWall` and `advanceWall`; frame timestamps, adapter replies and
marker cutoffs are computed relative to that epoch. The local-clock driver
reports its real process clock, which no mapping consumes. `seed.ageMs`
(signed), `seed.ttlMs` and `invalidate.futureBufferMs` are whole milliseconds.

[coordinated-replay.ts](../test/formal/coordinated-replay.ts) replays any
profile's history through the coordinator with the TypeScript drivers exactly as
a native port does. The coordinator test runs every committed smoke history
through it, so the schema is checked against real observations, not examples.

## Generated fixtures and fast local tests

With the pinned Quint executable available, regenerate all committed
model-derived artifacts with one command:

```sh
node formal/generate-artifacts.mjs --write
make fixtures-check
```

This runs all four wire exporters and regenerates the smoke/witness fixtures.
[fixture-recipes.json](./fixture-recipes.json) records named public regressions
or explicit action/choice schedules, excerpt ranges, and field projections.
It never stores expected state. For sampled-history excerpts, the exporter
replays the entire external prefix from initialization before selecting the
excerpt. Quint computes every expected state again.

The exporter uses Quint's own parser/source locations to restrict an original
public action's `oneOf` input domain to the requested choice. Original guards,
state updates and helpers remain unchanged. A separate counter selects the
next external action; it never supplies cache state. Impossible choices,
disabled actions, missing outputs and contradictory recorded inputs fail
regeneration. Named public-action regressions run directly in Quint.

Generated files omit volatile timestamps and retain recipe provenance. The
[fixture lock](./generated-fixtures.lock.json) binds their content to the
models, recipes and exporter. Ordinary TS/Go tests verify those fingerprints
without launching Quint. `make fixtures-check` recomputes the predictions and
compares the complete output; the full workflow always recomputes these
artifacts, and PR CI recomputes them when model/generator inputs change. Review changed predictions against the
model change.
Fixed scenarios and manually reviewed coverage/binding catalogs remain separate.
Classifier tests deliberately corrupt copies of valid fixtures to test the
harness; those corruptions receive no positive conformance credit.

## Complete corpus and reusable acceptance checks

Use the [shared Make targets and pinned prerequisites](./README.md#generating-and-replaying-behavior)
from the repository root:

```sh
make check         # Fast native checks and committed smoke; not full acceptance.
make formal        # Rust model/corpus checks, then prepared TS and Go replay.
make model-check   # Separate finite symbolic checks; requires Java 21 and tar.
make mutations     # Measures both fault catalogs over the generated corpus.
make integration   # Real-server interoperability; requires Docker.
```

`make ci NODE22_BIN=/path/to/node22/bin/node` runs all local lanes in order,
including symbolic checks and the exact Node 22.15.0 package floor.
`make formal-generate` produces the full corpus and the shared witness evidence;
`make formal-ts` and `make formal-go` each prepare and complete one port's run
against them. The parity and mutation lanes depend only on the generated corpus
and shared witness evidence and run in parallel in hosted CI, whose aggregate
requires all of them. These are the same entry points used by hosted CI.
The manual/weekly full workflow performs the complete formal, symbolic and mutation
checks; PR CI keeps native/race/smoke/audit and real-server integration checks,
with conditional artifact recomputation. Behavior/model changes require full
validation before merge, and every release or new-port acceptance requires the
complete inventory. A green smoke lane supplies no full-parity claim.

Print the current required IDs with `node formal/conformance.mjs inventory`.
The commands below describe
the lower-level completion API for implementers of another port; the Make
targets already orchestrate it for TS and Go.

The shared inventory contains stable language-neutral IDs:

| ID | Required assertion |
| --- | --- |
| `sampled/<profile>/<index>` | Complete replay of that sampled history |
| `regression/<profile>/<run>` | Complete replay of that named public-action history |
| `scenario/<feature>/<name>` | That supplementary fixed scenario |
| `protocol/<group>/<name>` | That fixed or Quint-generated protocol vector |
| `witness/<profile>` | The profile's required consequential witness gate |

Scenario/vector name components use URI percent encoding. The manifest drives
the exact inventory; a passing smoke test cannot substitute for a scheduled
history. Witness gates establish reachability across the corpus and are
separate from implementation assertions. Every port evaluates them with the
shared `node formal/witnesses.mjs evaluate` command described under
[Witness evidence](#witness-evidence); Go validation consumes that evidence
after checking its exact corpus and definition hashes, and independently
executes and asserts every history.

Prepare each port immediately before its native tests. For TS, the low-level
command is `node formal/conformance.mjs prepare typescript .formal-traces/ts-context.json`.
Run its complete native suite, evaluate the shared witness evidence, and
validate its completion before using
`node formal/conformance.mjs prepare go .formal-traces/go-context.json`.
Go preparation binds the witness evidence the shared evaluator just produced.
Do not prepare both contexts consecutively before running either suite.

For another language, supply a JSON array containing every repository-relative
implementation, driver, adapter, dependency-lock and test-configuration file
that affects execution:

```sh
node formal/conformance.mjs prepare rust .formal-traces/rust-context.json rust/conformance-sources.json
```

These commands do not run the implementation. They record a unique run ID,
preparation time, specification/source fingerprints, the exact corpus bytes,
and the required case inventory. A port's source manifest is a reviewed input
declaration; the checker cannot discover an omitted native dependency itself.
Go's default inputs also include the shared source/fixture definitions and the
evaluated witness JSON under `.formal-traces/go-parity-witnesses/`. Another port
that consumes auxiliary evidence must include those files in its input manifest.

Run native tests with complete trace directory selectors. Preserve the original
assertion report and its timestamps. The supplied report adapters accept
Vitest JSON and `go test -json`, respectively:

```sh
node formal/conformance-adapters.mjs typescript .formal-traces/ts-replay.json .formal-traces/ts-context.json > .formal-traces/ts-completion.json
node formal/conformance-adapters.mjs go .formal-traces/go-replay.jsonl .formal-traces/go-context.json > .formal-traces/go-completion.json
node formal/conformance.mjs check .formal-traces/ts-completion.json .formal-traces/ts-context.json
node formal/conformance.mjs check .formal-traces/go-completion.json .formal-traces/go-context.json
```

Another language emits the same JSON completion schema: `schemaVersion: 1`,
`language`, `runId`, `contextSha256`, millisecond `startedAt`/`finishedAt`,
`status: "passed"`, `nativeReportSha256`, and `results: [{id, status:"passed"}]`.
`contextSha256` is SHA256 of the prepared context serialized with `JSON.stringify`
(preserved member order, no indentation/newline); `nativeReportSha256` hashes
the original report bytes. An adapter can be written in Node while the port
and test execution use the native language. Reuse the supplied checker.

Every required ID must pass exactly once. Missing, duplicate, unknown, skipped,
failed and incomplete results are rejected. So are changed source/corpus bytes
and native runs predating preparation. Keep contexts, corpus, original reports
and completion JSON together under `.formal-traces/`. Mutation targets validate
the relevant full reports against current source and corpus fingerprints before
starting: TS mutations need TS completion, and Go mutations need both ports.
Supplied adapters verify actual native
assertion records before producing completion results. A completion document
is test evidence, not cryptographic attestation that an untrusted driver behaved
honestly. Challenge each new driver with broken implementations and malformed
histories, including lost publication, missing coalescing and deadline errors.

## Witness evidence

A witness is a required boundary, outcome or race that the generated corpus
must reach; [coverage-witnesses.json](./coverage-witnesses.json) names them per
profile. Each `witness/<profile>` completion leaf is decided by one shared,
language-neutral evaluator under [replay/witnesses/](./replay/witnesses/). It
reads the same histories every port replays (the profile's sampled traces plus
its exported `replayRegressions`), keys every rule on the explicit Quint `input`
record, and classifies from declared inputs, public observations and, where a
rule needs it, the model's private predictions. Driver observations never enter
it, and it never supplies an implementation's inputs.

Run it once over a generated corpus:

```sh
node formal/witnesses.mjs evaluate --profile all
```

`--profile <name>` selects one profile, `--traces <dir>` relocates the corpus
root (default `.formal-traces`), and `--out <dir>` selects the evidence
directory (default `.formal-traces/go-parity-witnesses`). When a required
witness or any declared action is unreached, the command fails listing every
missing label and removes that profile's stale evidence file.

For each complete profile it writes `<out>/<profile>.json`:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1` |
| `profile` | Profile ID |
| `traces` | Number of evaluated histories |
| `required` | The registry's required labels, in registry order |
| `seen` | Every reached label, sorted |
| `inputs` | `{ path, sha256 }` for `formal/profiles.json`, `formal/coverage-witnesses.json`, `formal/execution.json`, the profile's model, `formal/conformance-observations.qnt`, every Quint library, the full `formal/replay` closure (which contains the classifiers) and the profile's `witnessSources`, deduplicated in that order |
| `corpus` | `{ name, sha256 }` per history, sorted by file name |

No input names a TypeScript or Go file, so completing the witness leaves does
not require running another port's test suite. A port either runs the CLI
itself before its native replay or consumes an evidence file whose `inputs`
and `corpus` hashes match its own checkout and corpus byte for byte, as the Go
replay does. The TypeScript suite calls the same `checkWitnesses` function for
its gate; it no longer produces evidence.

## Current limitations for a third port

The `causally-ready-v1` settlement contract is defined in prose, in the
[trace and observation contract](#trace-and-observation-contract) and the
`Settle` row above; no machine-checkable definition exists. Its only executable
control is the TypeScript no-settle test. The Go port has no equivalent control
yet, so a third port writes its own against its own driver.

Node 24 is required as test tooling: the coordinator and the witness evaluator
are Node scripts that a port's test run spawns, and the completion checker and
report adapters run on Node as well. The port's library itself needs no Node
dependency, as the Go module shows.

The Go transport validates every command the coordinator returns against
`$defs/command` but does not validate its own observations locally, so the
coordinator's schema check is the first to reject a malformed record. A port may
validate each observation against `$defs/behaviorObservation`,
`coreObservation` or `localClockObservation` before sending it; that attributes
a shape defect to the driver without a coordinator round trip.

## New-port acceptance

Start with keys/frames and core traversal; add profile mappings until the full
shared inventory passes. Preserve one failing history as the reproduction unit:
report profile, action index, input, expected/actual observations and command.
Automatic shrinking is not currently supplied.

Before accepting a port, also run its native API/value/clock/exporter checks,
real Redis/Valkey/Cluster protocol and bidirectional interoperability tests,
race or equivalent concurrency checks, and representative semantic mutations.
The completion checker covers portable replay; these native/integration/model
checks remain distinct required evidence. Record exact adaptations and gaps.
Passing this finite suite does not establish every schedule, feature combination,
native codec domain, environmental durability assumption, or rolling upgrade.
