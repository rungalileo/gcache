# Measuring semantic coverage

Measure named contract cases, exercised boundaries, and detected behavioral defects separately. A line-coverage percentage or a mapped test declaration cannot establish semantic completeness.

## Evidence inventory

[semantic-cases.json](./semantic-cases.json) refines the obligations in
[CONTRACTS.md](./CONTRACTS.md) into named behavioral and wire cases. All 240
behavioral cases now cite checked Quint clauses and Quint-driven implementation
evidence. The wire expansion adds Quint-derived artifacts alongside fixed
vectors; native cases remain in [feature-coverage.json](./feature-coverage.json).
Get current counts from `node formal/check-semantic-coverage.mjs`, rather than
summing tables across documents.

The checker reports these distinct categories:

| Category | What is counted |
| --- | --- |
| Model | A cited invariant/regression scheduled in [execution.json](./execution.json) |
| Portable | Fixed scenarios, witnesses, exported Quint regressions or wire vectors |
| Generated witness | A required consequential history in [coverage-witnesses.json](./coverage-witnesses.json) |
| Quint regression replay | A named public-action regression exported and replayed in both ports |
| Quint vector replay | Expected primitive outputs exported from a scheduled Quint model |
| Quint-driven | The union of the preceding three Quint execution categories |

These categories overlap. Definitions/helpers explain rules but are not checked
properties. A named case is not an independent proof, and a finite corpus is not
the full input domain. [quint-case-audit.json](./quint-case-audit.json) records
what each cited check actually establishes; metadata validation cannot replace
semantic review of that scope.

Previous model-only gaps now have replay: local read/write failure consequences
use native injection seams, and marker-preservation histories observe actual
existence and TTL around value reads/writes. Explicit-input regressions also
cover default/omitted policy, exact cohorts, source budgets, dark publication,
mixed shadow capacity and recovered absence skipping selected shadow work.

Every positive fixed scenario, fixed protocol/invalidation vector and generated
wire artifact row must have a semantic-case assignment. Native evidence names
exact tests, asserted clauses and applicable language adaptations. The source
audit separately accounts for reviewed test declarations and documentation
sections; it does not count assertions or prove behavioral equivalence.

[VALIDATION.md](./VALIDATION.md) explains current commands, report identity and
where to retain behavioral, primitive-vector and mutation results.

## Model assurance

A model's transition helpers, independent properties and implementation replay
answer different questions. The shared `cache-rules.qnt` judgments own age,
expiry, deadline and fence decisions. `cache-contract.qnt` owns acquired recovery
and source records. Connection models execute real profiles and check selected
histories against those records.

| Evidence | What it establishes |
| --- | --- |
| Finite symbolic rule checks | Every decision in the declared finite domain satisfies the independently stated property |
| Sampled connection checks | Explored profile histories preserve the selected snapshot, timing and ownership contracts |
| Compiling model mutations | The named property detects that deliberate semantic change to a transition |
| Exported boundary regressions | The exact public command sequence is checked in Quint and against both implementations |

`make model-check` runs the symbolic checks declared in `execution.json` through
checksummed standalone Apalache; see the [tool prerequisites](./README.md#generating-and-replaying-behavior).
This lane is separate from `make formal` and included in `make ci`.
The model-property challenge catalog is the `challenges` array of
[execution.json](./execution.json). It runs once at the end of the scheduled
model checks and records an independent baseline and counterexample for each
fault. Count challenges and distinct faults separately: a challenge is one
(fault, model, invariant) measurement, while a distinct fault is one
`(source, before, after)` mutation. The same shared-rule fault may be measured
against several models when each entry carries a `measures` note, so the
catalog currently reports 64 challenges over 62 distinct faults. Every scheduled
model owns at least one challenge; a `challengeWaiver` on a model entry is a
documented gap, not coverage. A detected challenge shows that the named
invariant rejects that one deliberate change under the manifest bounds. Model
receipts preserve the timestamp, captured policy and owner at acceptance.
Boundary properties can challenge an eligibility helper by stating the
inequality directly. Connection and composition properties may reuse that
helper while checking independently captured inputs, ownership and history;
they do not thereby validate the helper itself. Each challenge's named property
and scope determine what its detection establishes.

Keep structural invariants because they expose broken model state, but report
semantic obligations and mutation sensitivity separately. Sharing transition
code reduces drift; it does not replace an independently checked property or
establish a whole-system refinement theorem.

## Generated boundary evidence

[`coverage-witnesses.json`](./coverage-witnesses.json) names the required boundary, outcome and race witnesses for each profile. The core profile has replay and action checks but no case-level witness gate. Reachability is checked across sampled histories and exported public-action regressions, and every history must independently replay against the real implementation. Expected model state is used only for assertions and reachability classification; it never supplies implementation observations.

A case links to a specific required witness, not merely an action name or the presence of a test file. For example, read-budget precedence requires a first read before runtime policy changes, late source fulfillment and rejection have separate witnesses, and failed recovery requires the original source-error identity. Default-off logging requires an actually omitted flag; a separate exported regression distinguishes omission from an explicit false runtime reply. Multiple witness references are all required, but do not imply that all those events occurred in one history; use a dedicated interaction witness for that claim.

Witness classification lives in the language-neutral modules under [`formal/replay/witnesses/`](./replay/witnesses/): one classifier module per profile plus shared trace, label and evidence helpers, run by `node formal/witnesses.mjs evaluate` to write the evidence every port consumes (see the [witness evidence contract](./PORTING.md#witness-evidence)). Its negative controls remain TypeScript tests: `test/formal-witness-boundaries.test.ts`, `test/formal-witness-attribution.test.ts` and the per-profile `test/formal-*-witnesses.test.ts` files import those shared classifiers directly. A matching fixture or intermediate phase with a missing or contradictory public consequence must not count. These controls challenge the classifier; they are neither positive cache cases nor mutation-detection credit.

## Behavioral mutation comparison

[`semantic-mutations.json`](./semantic-mutations.json) defines 13 reviewed, single-site faults. `node formal/measure-semantics.mjs` applies each in an isolated copy, verifies that it compiles, and runs three cohorts against it:

1. **Ordinary:** existing unit tests, excluding all formal tests.
2. **Generated:** sampled and exported-regression replays, reachability gates, and Quint-derived primitive vectors.
3. **Portable:** the generated cohort plus positive fixed scenarios and complementary fixed protocol vectors.

The source edits are TypeScript-specific audit machinery. Ports reuse the case/witness/vector contracts and can supply equivalent faults for their own implementation.

Execution partitions protocol rows with `DIALCACHE_PROTOCOL_CORPUS=generated` or `fixed`; ordinary runs use their complete union. It runs each cohort using Vitest's normal file isolation. The reported portable result is their union: a fault is detected if either component records a failed assertion. Baseline counts and failing test names are combined from those actual runs. Both component reports are retained; generated traces are not redundantly replayed a second time per fault.

Negative harness tests and inventory checks are excluded from detection cohorts: a test that expects a deliberately broken driver to fail must not count as behavioral fault detection. Real-server integration/Lua tests are outside this local mutation comparison; they have their own completion evidence. All unmodified baselines must pass. Compile/import errors, crashes, timeouts, missing reports, empty runs, and incomplete surviving runs fail measurement rather than counting as detections.

### Recorded measurements

Per-run reports retain cohort sizes, assertion failures and survivors. The
[historical baseline](./VALIDATION.md#historical-results) preserves PR #161's
results; fresh measurements belong with their exact source and corpus artifacts.

## Reproduction and CI

Use the [shared Make targets and pinned prerequisites](./README.md#generating-and-replaying-behavior):

```sh
make formal        # Regenerate and complete prepared TS and Go replay.
make mutations     # Validate those reports, then measure both fault catalogs.
```

`make mutations-ts` requires current full TS completion. `make mutations-go`
requires both TS and Go completion; it cannot run until Go replay finishes.
TS mutation measurement may run alongside Go replay after `make formal-corpus`.
The targets reject missing, incomplete or stale completion evidence by checking
its current source, corpus and witness fingerprints. Raw measurement programs
remain `measure-semantics.mjs` and `measure-go-semantics.mjs`; the Make targets
supply the preflight checks used by hosted full validation.

The manual/weekly workflow runs the full corpus and fault checks. PR checks
retain native/race/smoke/audit and real-server integration, plus fixture
recomputation when generation inputs change. A behavior/model change still
needs full validation before merge; release and new-port acceptance need the
same full evidence. `make check` alone supplies no mutation or full-parity pass.

The runner clears inherited trace selectors, uses the complete generated directories, and leaves source files untouched. It writes `.formal-traces/semantic/report.json` and `report.md`, per-cohort assertion reports/logs, and baseline witness evidence. JSON records completion status, elapsed time, revision, Node version, source/configuration/input hashes, exact corpus hash, cohort sizes, detections, survivors, and failing test names. An interrupted or failed run is not a completed measurement. The full workflow retains these files in `typescript-semantic-evidence`, alongside the shared `formal-traces` artifact; restore the measurement artifact into `.formal-traces/semantic/` for reproduction.

Each catalog entry's `requiredDetections` is a regression gate. The local mutation target and full workflow fail if a required fault survives. Newly detected faults remain visible as improvements; update the required set after inspecting the result. Source edits must match exactly once, so implementation drift requires reviewing the mutation rather than silently skipping it.

To expand assurance, add a test/doc-derived case and precise executable evidence, require a generated witness where appropriate, then add a representative fault for a previously unchallenged rule. Preserve gaps until execution closes them. Keep code coverage, source accounting, case evidence, and mutation detection as separate measurements. The current Go suite requires every shared profile, exported regression, fixed scenario and protocol case registered by the manifests, with an equivalent fault catalog in `go-mutations.json`. Broader interaction histories and larger domains remain separate assurance work.

## Model properties and cross-language execution

`check-model-properties.mjs` challenges shared boundaries and profile connections
using the reviewed catalog, which it reads from the `challenges` array in
`execution.json`. It validates the whole manifest before a complete run, records
a passing baseline and invariant counterexample for each compiling fault along
with source fingerprints, tools and bounds, and fingerprints `execution.json` as
`catalogSha256` in its report. This measures the specification separately from
implementation mutation detection.

Every effects replay also runs `assertEffectsHistory` over actual external source starts/settlements and public fallback/write observations. Its C23/C25/C26 checks cover source-relative budget/duration, strict deadline acceptance, and a preceding accepted success before publication. It consumes no expected model phases and permits pending prefixes. An additional causal monitor in both drivers ties writes to their actual invocation/source callback and rejects publication after that source settled too late; negative tests distinguish property failures from malformed monitor inputs. This is a bounded connection for selected properties, not full model refinement or liveness proof.

The Go driver executes the same generated corpus through its own cache implementation. Its value-domain and API adaptations appear in [`go/README.md`](../go/README.md). `measure-go-semantics.mjs` independently measures the Go fault catalog; TypeScript mutation results are never credited to Go. The Go race detector covers only exercised schedules.
