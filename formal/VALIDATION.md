# Validation and evidence

Run validation from the repository root. The Make targets are shared by local
work and GitHub Actions; [README.md](./README.md#generating-and-replaying-behavior)
lists tool prerequisites and focused reproduction commands.

## Choosing a run

| Task | Command | Evidence |
| --- | --- | --- |
| Routine implementation checks | `make check` | Native tests, coverage, package, docs and source audits |
| Full portable acceptance | `make formal` | Rust model checks, generated histories, TS and Go replay, exact completion inventories; no Java |
| Finite symbolic rules | `make model-check` | Scheduled bounded checks with checksummed standalone Apalache; requires Java 21, `tar` and pinned Quint |
| Challenge implementation assertions | `make mutations` | Compiling semantic faults tested against both completed ports |
| Real server behavior | `make integration` | Redis, Valkey, Cluster and cross-language interoperability |
| Explore another schedule sample | `make explore` | Separate source snapshot, recorded random seed, both-port replay |
| All required local lanes | `make ci NODE22_BIN=/absolute/path/to/node22/bin/node` | Native, formal, separate symbolic, integration and mutation runs |

A behavior, model, or replay change requires full validation of its current
inputs before merge. The default PR workflow runs faster checks; it does not
enforce this full-validation requirement. The manual full workflow can target a
PR branch. Its symbolic job runs separately from corpus generation. Its weekly
run validates the selected `main` revision and includes exploration; a manual
run can enable the `exploration` option. The aggregate gate requires exploration
when selected or scheduled. Each PR body should identify the revision and
completed local or hosted validation.

## Reading a completion report

Evidence lives under `.formal-traces/` and in the workflow's uploaded artifacts.
The prepared `ts-context.json` and `go-context.json` bind the specification,
implementation, harness, corpus and required case inventory. Their matching
completion reports require every scheduled case to pass. A changed input,
missing result, skipped case, duplicate result or stale report fails acceptance.

```sh
node formal/conformance.mjs check .formal-traces/ts-completion.json .formal-traces/ts-context.json
node formal/conformance.mjs check .formal-traces/go-completion.json .formal-traces/go-context.json
```

Keep reports with their source/corpus fingerprints and native assertion output.
Copying a report to another revision does not revalidate that revision. Scope
and environmental assumptions are defined once in
[SPEC.md](./SPEC.md#assumptions-evidence-and-claims).

## Mutation evidence

Model mutations challenge the specification's independent properties.
Implementation mutations challenge the assertions that connect generated
histories to real TS/Go behavior. Report these measurements separately, including
survivors. Structural invariants and semantic obligations are also different
units; a total invariant count is not a measure of specification strength.

Every mutation must compile, its unmodified baseline must pass, and detection
must come from a semantic assertion or invariant counterexample. A tool failure,
missing witness, crash or timeout is a failed measurement. The selected fault
catalogs and per-run reports define the denominator; do not infer a percentage
of all possible defects from their scores.

## Exploratory runs

`make explore` selects and records a fresh seed, copies current tracked and new
source files, and runs Rust model checks and both native replays in that isolated
snapshot. It does not run the separate symbolic lane or require Java.
It preserves the pinned acceptance corpus and reports in the original checkout.
The weekly full workflow runs this lane alongside pinned validation. Exploration
does not produce an acceptance completion: its separate report distinguishes
native replay failures, witness-check failures and other infrastructure failures.
A witness-check failure can mean an unreached boundary or invalid witness
evidence; inspect the native report before attributing it to sampling. Go replay
still runs after a TypeScript witness-check failure.

Choose a seed explicitly, or replay the saved source snapshot using the exact
command printed by the runner:

```sh
node formal/explore.mjs --seed 0x2a
node formal/explore.mjs --replay /absolute/path/to/exploration/report.json
```

Snapshot replay verifies saved source fingerprints, uses that snapshot's runner
and requires matching package/lock inputs for the installed dependencies. It
writes a new evidence directory and preserves the original run.

Retain a failing seed, its source fingerprints and history. Turn a discovered
behavioral counterexample into a named public-action Quint regression so future
acceptance no longer depends on rediscovering it randomly. A missed mandatory
witness or broken runner is diagnostic evidence, not an implementation defect.

### A retained sampling regression

Seed `0x48596dab531a8ddc` on snapshot
`258908b8f12f61ad27d070bf4673f54ee1e81689` replayed the behavioral histories in
both ports but missed three mandatory witness labels. These public-action
regressions now anchor the missing schedules:

| Profile / missed witness | Named regression |
| --- | --- |
| effects / `untracked-demotes-fenced-reply` | [untrackedFencedReplyRefillsAndIsReadableTest](./dialcache-effects-conformance.qnt) |
| independent / `independent-recovery-age-boundary` | [independentRecoveryAtCapturedAgeBoundaryTest](./dialcache-independent-conformance.qnt) |
| recovery / `recovery-memoizes-both-requests` | [recoveredFlightMemoIsReusedByBothRequestsTest](./dialcache-recovery-conformance.qnt) |

The same seed passed both ports and all mandatory witnesses on snapshot
`97f77529d693c4d39baa124a2bde2142c8856bc1`. That exploration was not rerun on
`87c5e6e25784f188125403db4c46295d6e5bea95`, whose later changes include assertion
diagnostics. This records the discovery and its regression anchors; it does not
claim that named regressions alone cover every required witness.

## Historical results

The merged baseline's detailed run logs remain in
[the versioned record from PR #161](https://github.com/lan17/DialCache/blob/7729c3f461c1d6f631b528ea06a81edca3ae787c/formal/VALIDATION.md).
Current results belong in PR summaries and uploaded artifacts. This guide
explains how to produce and interpret evidence; it is not an accumulating log
of previous executions or machine-specific temporary paths.
