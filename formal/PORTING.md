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

Supply a native implementation, a controlled test environment, a profile adapter,
and assertion results in the completion format below. Existing implementations
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
| Observe | Read actual caller outcomes, source/effect counts, event order, timestamps, values and error categories after the step. Collect observations independently of expected model state. |
| Cleanup | Drain or release test-owned work, restore clock/fault hooks, and isolate the next history. Unfinished work must not silently leak into another history. |

Input mappings may use previously observed driver-owned invocation IDs and
counters to select the latest actual operation. They must never use a predicted
model owner, phase, counter, cache value, or expected result to select an input
or decide when the implementation has progressed far enough.

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

The common normalized envelope also contains `mbt::actionTaken` and
`mbt::nondetPicks.choice` (`Some` with an integer or `None`). Legacy profiles use
this envelope directly. Core accepts no nondeterministic argument record.
[replay-inputs.mjs](./replay-inputs.mjs) translates explicit inputs into that
envelope without comparing predicted states. Prefer the explicit input when
the profile declares it, and reject contradictory encodings.

The controlled fixtures, action mappings and compared fields are documented in
[CONFORMANCE.md](./CONFORMANCE.md) for core and
[BEHAVIOR.md](./BEHAVIOR.md) for pending effects, feature profiles and the six
additional composition profiles. [conformance-observations.qnt](./conformance-observations.qnt)
names shared outcome encodings. Read a profile's initialization and public
actions alongside its table; the profile's declared units and choices are part
of the versioned input contract.

For each step, decode the external command, execute it, allow causally ready
native work to progress, then assert the profile's actual observations. Do not
release deliberately held work or advance time merely to match an expectation.
Diagnostic profiles also compare their specified event categories, counts and
timing. Private prediction fields can support model properties and witness
classification; they cannot replace observations collected from the port.

Histories may deliberately finish with pending work. Their final assertions
describe that state. Test teardown releases resources after those assertions;
it must not change the recorded history to manufacture a completed outcome.

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
make formal        # Full model/corpus checks, then prepared TS and Go replay.
make mutations     # Requires valid completion reports from the full run.
make integration   # Real-server interoperability; requires Docker.
```

`make ci NODE22_BIN=/path/to/node22/bin/node` runs all local lanes in order,
including the exact Node 22.15.0 package floor. `make formal-corpus` produces the full
corpus and completed TS evidence; `make formal-go` validates that evidence and
then prepares Go's run. These are the same entry points used by hosted CI.
The manual/weekly full workflow performs the complete formal and mutation
checks; PR CI keeps native/race/smoke/audit and real-server integration checks,
with conditional artifact recomputation. Behavior/model changes require full
validation before merge, and every release or new-port acceptance requires the
complete inventory. A green smoke lane supplies no full-parity claim.

The current shared inventory contains 7,180 required checks. Print its exact
IDs with `node formal/conformance.mjs inventory`. The commands below describe
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
separate from implementation assertions. Current Go validation consumes the
shared witness evidence produced during TS replay, checking exact corpus and
definition hashes. Go independently executes and asserts every history.

Prepare each port immediately before its native tests. For TS, the low-level
command is `node formal/conformance.mjs prepare typescript .formal-traces/ts-context.json`.
Run its complete native suite and validate its completion before using
`node formal/conformance.mjs prepare go .formal-traces/go-context.json`.
Go preparation consumes the witness evidence TS just produced. Do not prepare
both contexts consecutively before running either suite.

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
