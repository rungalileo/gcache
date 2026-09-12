# Go parity acceptance

The target is a Go implementation of DialCache's portable behavior, with the
same interoperable cache protocol and observable metric schemas. The readable
Quint transitions and independently stated properties define that behavior.
The prose explains the models, their encodings, and their limits. A port must
not treat the TypeScript implementation, its tests, or an expected trace state
as an alternative behavioral oracle.

[`go-parity.json`](go-parity.json) records the reviewed implementation mappings,
shared execution evidence, native adaptations, and remaining assurance gaps.
Its status describes a finite portable contract inventory. Current profile,
regression, vector and witness requirements come from [execution.json](execution.json),
[profiles.json](profiles.json) and [coverage-witnesses.json](coverage-witnesses.json).
The [feature map](FEATURE-COVERAGE.md) accounts for behavioral/wire cases and
separate native obligations. All reviewed behavioral cases now have checked
Quint definitions and Quint-driven implementation evidence.

Earlier acceptance records remain **historical**. Their source revisions,
corpora and report hashes describe the exact runs that passed; changed models,
regressions, drivers or wire artifacts require fresh reports.
[VALIDATION.md](VALIDATION.md) documents current validation commands and
links the historical acceptance record. Inventory totals are
accounting, not coverage percentages or proofs.

Each validation record identifies its actual revision/input snapshot, report
hashes and execution-input manifest. Use `make formal` for Rust model checks,
artifact generation and prepared TS/Go replay. Run `make model-check` for the
separate finite symbolic checks, then `make mutations` and `make integration`
for their fault and real-server evidence.
`make ci NODE22_BIN=/path/to/node22/bin/node` runs all local lanes in order,
including symbolic checks and the exact Node 22.15.0 package floor; see the [Make target guide](./README.md#generating-and-replaying-behavior)
for pinned prerequisites and individual targets.

Hosted PR checks run native/race tests, committed smoke, audits and real
integration; model/generator input changes also trigger artifact recomputation.
The full formal/symbolic/mutation workflow runs manually and weekly. Fast PR checks do
not replace the full acceptance inventory: behavior/model changes
need full validation for their exact inputs before merge, and release/new-port
acceptance needs the full evidence. Reports under `.formal-traces/` bind their
source, corpus and witness fingerprints; changed inputs invalidate an old pass.

`make formal-generate` generates the corpus and then evaluates the shared,
language-neutral witness evidence (`node formal/witnesses.mjs evaluate`);
`make formal-go` prepares Go against both, independently of the TypeScript
replay, and the two ports' parity lanes run in parallel. `check-go-replay.mjs`
and the shared completion gate reject missing histories, skipped witnesses,
incomplete reports and stale inputs. Go independently executes every history;
the shared evaluator supplies witness reachability over the common corpus, not
Go's cache results, and none of its inputs is a TypeScript file.

## Required evidence

Quint-generated histories should drive most portable behavioral testing in
both implementations, especially interactions among policy capture, request
ownership, cache layers, deadlines, recovery, and shadow work. For a rule
covered by generated histories, the ledger must link:

1. The precise Quint transition or independently checked property expressing
   the obligation, with the model's bounds and assumptions made explicit.
2. A required consequential witness or exported public-action Quint regression
   that exposes the result through public observations. A witness for entering a branch is
   insufficient when the contract concerns a later read, timeout, or write.
3. Successful replays of the **same generated histories** through the actual
   TypeScript and Go APIs, recording the corpus hash, repository revision,
   checker settings, and both implementation reports.

Scheduled named Quint regressions are exported alongside sampled histories.
The completion gates require each of those regressions in both ports, making
its declared boundary independent of sampling. Remaining mandatory witnesses
are checked across the combined named and sampled corpus. Fixed scenarios remain
useful for a known failure or a narrow complementary example.
Protocol vectors and native integration tests are appropriate evidence for
byte encodings, host numeric limits, backend registration, and actual Redis
execution. Acceptance does not require every fixed case to become a generated
history. It does require reviewing the consequential portable branches and
using Quint as their behavioral source of truth, rather than treating a large
trace count as evidence that all obligations were exercised. When several
cases share a witness, review each rule separately: reachability alone does
not establish that the observation distinguishes its incorrect implementation.

The execution driver may use action parameters and external fixture data to
control source settlement, clocks, cache replies, and scheduling gates. Only
the assertion layer may read expected model state. Expected counters, results,
or private model cache state must never determine actual execution. Required
witness gates must fail if generation omits them. Mutation challenges must
reach a behavioral assertion; a parse error, compile error, missing tool, or
watchdog failure is not successful semantic detection.

Protocol vectors complement behavioral traces by checking bytes, numeric
boundaries, argument ordering, invalid encodings, and compression. Native
integration tests complement both by checking actual Redis execution,
concurrency, backend collector behavior, packaging, and language-specific
value handling. Their contribution and limits must be stated explicitly;
they do not establish unmodeled interactions among portable state machines.

`inventory.withoutRequiredGeneratedWitnesses` identifies a generated-evidence
gap, not necessarily a Go implementation gap. A known implementation gap
requires a specific unsupported portable behavior or a failing behavioral
comparison. A rule already supported by fixed, vector, or native evidence can
instead be a candidate for additional generated assurance. Current finite limits are recorded in
[FEATURE-COVERAGE.md](FEATURE-COVERAGE.md) and [PROTOCOL.md](PROTOCOL.md): larger
feature products, unbounded scheduling/state spaces, full host numeric formatting
and codec/resource behavior. The new composition profiles cover local failures,
marker lifetime, fractional local clocks, runtime/default policy boundaries,
source budgets and mixed dark/served ownership. Each claim retains its precise
bounds. Do not label a missing witness as an implementation difference or
manufacture a separate model for every fixed test.

## Reading and updating the ledger

`cases` records every current semantic case, its declared model links,
generated witness requirements, and fixed or vector evidence. Empty model
links mean that no scheduled invariant or regression is currently cited for
that case; a precise transition definition may still express its behavior.
Record that transition separately from an independently checked property.
A matching profile name does not invent either connection, and a property
checking one clause does not prove all clauses of a compound case. Evidence
fields identify the checked local reports and corpus fingerprints. Refresh
them after executable inputs change; a previous revision's pass must not
silently satisfy a changed model or implementation.

[`quint-case-audit.json`](quint-case-audit.json) records the reviewed scope of
each cited scheduled invariant or regression, plus separate transition,
helper, and predicate references. It explicitly distinguishes a checked
safety clause from a complete case proof and records known limits of the
properties. The ordinary metadata gates check reference kinds, scheduling,
case membership, positive scenario/vector assignments, feature/native coverage,
and nonempty scope notes without requiring Quint; it cannot
automate the semantic judgment in those notes.

`profiles` records the shared corpus for each executable profile. Scheduled
trace counts are generation settings, not a claim that all traces differ or
that the model's state space was exhausted. After a model or registry change,
refresh the input hashes, case inventory, required witnesses, and reports
together. Preserve the existing execution-manifest validation and scheduled
invariant/regression checks.

`sourceInventory` lists reviewed TypeScript production declarations.
Each inherits its reviewed source-file mapping to named Go symbols, with hashes
that reject stale mappings. These are navigation and review records, not
independent equivalence claims. The linked source audit's test and
documentation files also have explicit Go-applicability reviews. Native
adaptations retain their rationale and evidence rather than being counted as
identical language APIs.

`boundaries` carries explicit abstraction and language-binding decisions.
An exclusion in an older bounded profile must be reconsidered for the full
port target. Do not change an exclusion to "supported" merely because the
new implementation has a similarly named function. Conversely, do not
require Go to reproduce a JavaScript-only API shape when an explicit Go
binding preserves its portable consequences.

## Native clock precision

C23 grants the source its full budget from source start; C25 accepts a source
settlement only strictly before that deadline. The existing Quint models and
shared histories express these rules in integer ticks. Their replays did not
expose a Go clock-binding defect: rounding two absolute elapsed readings before
subtracting them could reject work completed within its full source budget.

Source, read and shadow budgets retain monotonic `time.Duration` precision
before subtraction. The optional `PreciseClock` interface supports the same
precision for custom clocks; integer clocks retain their declared resolution.
Timer delivery is checked against elapsed time.

Local TTL has a different native boundary: TypeScript floors the monotonic
clock to whole milliseconds at insertion and lookup. Go follows those same
whole-millisecond observations. For example, insertion at 0.7 ms with a 1,000 ms
TTL expires at the observed clock value 1,000 ms. Applying precise elapsed
subtraction to local storage would retain that entry beyond TypeScript's
boundary. The local-clock profile now defines this rule using fractional environment
advances and whole-millisecond observations. It also checks that default instances
constructed at different fractional times share one process grid. Native tests
separately distinguish precise source/read/shadow budgets; integer-tick traces
in other profiles cannot establish these binding boundaries.

[`clock_precision_test.go`](../go/clock_precision_test.go) uses deterministic
native clock phases to exercise source and read completion before and at their
budgets, served and dark shadow deadlines, insertion expiry, coalescing age,
early timer delivery, and integer-clock compatibility. These native regressions retain their own C23/C25 and B02 evidence. The separate
local-clock model/replay adds only its stated local-expiry and shared-grid scope;
it does not turn every clock precision test into a Quint-driven case. Their execution and any new full-run
results must retain their own revision and input identities rather than reuse
a previous implementation's validation record.

## Current configuration and observability bindings

`ParsePolicy` validates JSON-shaped static configuration. `SnapshotPolicy`
copies mutable leaves. `ResolvePolicy` combines that static snapshot with a
sparse runtime overlay; it separates invocation failures, layer disablement,
recovery configuration errors, and shadow configuration errors. Whole-second
TTLs and millisecond deadlines retain distinct validation rules. Invalid
shadow logging policy is reported only after actual shadow admission. These
bindings have focused native tests and share the generated policy and shadow
replay evidence above. The ledger and feature inventory distinguish each
portable case's Quint evidence from its additional native binding requirements.

`MetricsAdapter.ObserveEvent` accepts backend-neutral diagnostics.
`FailureIsolatedObserver` and `FailureIsolatedLogger` prevent exporter errors
or panics from replacing cache/source results. Shadow mismatch previews use
native JSON behavior and bounded UTF-8 output; unavailable previews remain
absent. The Prometheus and DogStatsD adapters preserve metric names, units,
labels, bucket boundaries, and counter increments. Logical cache keys never
become metric labels.

The Go Prometheus binding accepts an explicit native registry. Reconstructing
this adapter with the same registry and prefix reuses its collectors and
observations. `NewPrometheusMetricsWithBindings` additionally reuses externally
created, individually registered `CounterVec` and `HistogramVec` collectors.
Each `PrometheusCollectorBinding` supplies the actual collector and its
construction schema. All declared schemas, public descriptors, and registered
collector identities are checked before the remaining collectors are
registered as an atomic group. A failed compatibility check creates no metric
series or partial collector group.

This is an explicit Go binding adaptation: unlike the TypeScript integration,
native `client_golang` does not expose the bucket configuration of an empty
histogram. The caller therefore asserts its real construction schema,
including buckets, rather than the adapter inspecting private fields or
creating a temporary series. Supplying inaccurate schema metadata violates
that binding's precondition. Registration/reconfiguration must not race with
construction; concurrent metric observations remain supported. Tests cover
empty and populated compatible collectors, preserved observations, descriptor
and declared-bucket mismatches, an unregistered lookalike, and failure without
partial registration. The default constructor continues to reject externally
owned collisions unless their explicit bindings are supplied.
