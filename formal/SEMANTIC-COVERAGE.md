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

[VALIDATION.md](./VALIDATION.md) records the completed expansion snapshot,
including separate behavioral, primitive-vector and mutation results. Historical
reports below retain their actual revisions and corpus definitions. Neither
evidence links nor an older pass validate changed inputs.

## Generated boundary evidence

[`coverage-witnesses.json`](./coverage-witnesses.json) names the required boundary, outcome and race witnesses for each profile. The core profile has replay and action checks but no case-level witness gate. Reachability is checked across sampled histories and exported public-action regressions, and every history must independently replay against the real implementation. Expected model state is used only for assertions and reachability classification; it never supplies implementation observations.

A case links to a specific required witness, not merely an action name or the presence of a test file. For example, read-budget precedence requires a first read before runtime policy changes, late source fulfillment and rejection have separate witnesses, and failed recovery requires the original source-error identity. Default-off logging requires an actually omitted flag; a separate exported regression distinguishes omission from an explicit false runtime reply. Multiple witness references are all required, but do not imply that all those events occurred in one history; use a dedicated interaction witness for that claim.

Witness classification also has negative controls in `test/formal-witness-boundaries.test.ts` and `test/formal-witness-attribution.test.ts`. A matching fixture or intermediate phase with a missing or contradictory public consequence must not count. These controls challenge the classifier; they are neither positive cache cases nor mutation-detection credit.

## Behavioral mutation comparison

[`semantic-mutations.json`](./semantic-mutations.json) defines 13 reviewed, single-site faults. `node formal/measure-semantics.mjs` applies each in an isolated copy, verifies that it compiles, and runs three cohorts against it:

1. **Ordinary:** existing unit tests, excluding all formal tests.
2. **Generated:** sampled and exported-regression replays, reachability gates, and Quint-derived primitive vectors.
3. **Portable:** the generated cohort plus positive fixed scenarios and complementary fixed protocol vectors.

The source edits are TypeScript-specific audit machinery. Ports reuse the case/witness/vector contracts and can supply equivalent faults for their own implementation.

Execution partitions protocol rows with `DIALCACHE_PROTOCOL_CORPUS=generated` or `fixed`; ordinary runs use their complete union. It runs each cohort using Vitest's normal file isolation. The reported portable result is their union: a fault is detected if either component records a failed assertion. Baseline counts and failing test names are combined from those actual runs. Both component reports are retained; generated traces are not redundantly replayed a second time per fault.

Negative harness tests and inventory checks are excluded from detection cohorts: a test that expects a deliberately broken driver to fail must not count as behavioral fault detection. Real-server integration/Lua tests are outside this local mutation comparison; they have their own completion evidence. All unmodified baselines must pass. Compile/import errors, crashes, timeouts, missing reports, empty runs, and incomplete surviving runs fail measurement rather than counting as detections.

### Latest recorded measurement

[VALIDATION.md](./VALIDATION.md#mutation-evidence) records the latest completed
measurements and their exact source revisions, corpus fingerprints, cohort
counts and surviving faults. Both TypeScript and Go detected **13/13 selected
faults in the generated cohort and 13/13 in the portable union**. The generated
cohort includes Quint-derived protocol vectors, which now detect M12's reversed
argument ordering. Ordinary and fixed cohorts retain the survivors listed in
that validation record. These are recorded runs, not a claim that a subsequent
documentation or source change has been remeasured.

### Historical comparison before generated primitive vectors

The tables in this section preserve the **earlier Go parity milestone, before
the current case/witness expansion and generated primitive cohort**. They do
not describe current detection. Its completed TypeScript measurement passed
all unmodified baselines: 660 ordinary tests, 4,008 generated replays/witness
gates, and 372 fixed scenarios/protocol vectors (4,380 positive portable
tests/gates in their union). Exact source, input, and corpus fingerprints are
retained in that report. Later changes require fresh reports; the manual/weekly
full workflow repeats measurement for its checked-out inputs.

| Mutant scope | Ordinary detected | Generated detected | Portable detected |
| --- | ---: | ---: | ---: |
| Behavioral faults | 11/11 | 11/11 | 11/11 |
| Protocol faults | 1/2 | 1/2 | 2/2 |
| All selected faults | 12/13 | 12/13 | 13/13 |

In that historical snapshot, generated replay and portable tests detected all 12 faults detected by ordinary tests. The generated cohort did not yet include the primitive vectors that distinguish M12. These are detection/parity ratios for this catalog, not percentages of all possible defects. No survivor is automatically labeled equivalent or excluded from the denominator.

Policy and shadow profile version 2 had closed three earlier generated-behavior survivors. The historical fault details were:

| Fault | Ordinary TypeScript | Generated TypeScript | Portable TypeScript | Distinguishing evidence |
| --- | --- | --- | --- | --- |
| M08: invalid logging policy enables warnings | Detected | Detected | Detected | A malformed flag reaches a confirmed mismatch without a warning |
| M11: local reads renew insertion TTL | Detected | Detected | Detected | A hit before expiry is followed by a public probe at the original insertion deadline |
| M12: argument order is reversed | Survives | Survives | Detected | Exact ordering is checked by protocol vectors |
| M13: expired dark job starts Redis work | Detected | Detected | Detected | Source work exhausts the job budget before deferred dispatch; no Redis read may start |

The other nine faults were detected by all three cohorts in that snapshot. Mutation IDs identify faults, not proofs of an entire case: shared helper changes can be detected through another affected behavior. The report preserves the actual failing test names and trace diagnostics so detection can be reviewed.

The independent Go measurement from that historical milestone compiled all 13 equivalent faults and completed all unmodified baselines: 93 ordinary native tests, 4,008 generated replays/witness gates, and 372 fixed scenarios/protocol vectors. Its completed report records:

| Go cohort | Selected faults detected |
| --- | ---: |
| Ordinary native | 5/13 |
| Quint-generated | 12/13 |
| Fixed scenarios/protocol vectors | 12/13 |
| Portable union | 13/13 |

In that historical Go run, native clock regressions detected M03 (late source acceptance) and M11 (renewed insertion TTL). All 11 behavioral faults were detected by generated tests. M12 was detected only by the fixed protocol vectors; M09 (omitted mismatch-logging flag) was detected by generated tests but survived the fixed cohort. The native TypeScript and Go suites differed in size and scope, so their ordinary detection ratios were not equivalent denominators of implementation quality.

Full validation requires every catalog entry's declared generated and portable
detections in each language. It runs in the manual/weekly full workflow and via
`make mutations` locally. Fast PR checks do not run the mutation catalog.
Quint-driven tests provide the main portable regression suite; native tests
cover language and integration boundaries.

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

The strengthened C23 invariant records actual model source-start time. `check-model-properties.mjs` requires a compiling deadline-epoch mutation to produce an invariant counterexample, and retains its source hash, tool version, and trace. Compilation/evaluator errors cannot count as detection. This challenges the specification itself in addition to the TypeScript mutation catalog.

Every effects replay also runs `assertEffectsHistory` over actual external source starts/settlements and public fallback/write observations. Its C23/C25/C26 checks cover source-relative budget/duration, strict deadline acceptance, and a preceding accepted success before publication. It consumes no expected model phases and permits pending prefixes. An additional causal monitor in both drivers ties writes to their actual invocation/source callback and rejects publication after that source settled too late; negative tests distinguish property failures from malformed monitor inputs. This is a bounded connection for selected properties, not full model refinement or liveness proof.

The Go driver executes the same generated corpus through its own cache implementation. Its value-domain and API adaptations appear in [`go/README.md`](../go/README.md). `measure-go-semantics.mjs` independently measures the Go fault catalog; TypeScript mutation results are never credited to Go. The Go race detector covers only exercised schedules.
