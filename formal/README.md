# Executable DialCache specification

Quint defines DialCache's portable behavior through readable transitions and
independently checked properties. TypeScript and Go replay the same external
histories against their real APIs and compare the resulting values, errors,
cache effects and diagnostics. The suite targets language ports and regression
testing; passing finite executions is not a proof over every input or schedule.

## Start with your task

- **Understand a behavior:** follow the [worked Quint walkthrough](./WALKTHROUGH.md),
  then read the relevant [model below](#models-and-composition-profiles).
  [SPEC.md](./SPEC.md) explains the surrounding ownership rules and allowed races.
- **Change or add a rule:** read [AUTHORING.md](./AUTHORING.md#codifying-the-next-behavior).
  Find its stable contract ID in [CONTRACTS.md](./CONTRACTS.md), then its corner
  case in [FEATURE-COVERAGE.md](./FEATURE-COVERAGE.md). The walkthrough shows how
  that ID connects the model, drivers and evidence catalogs.
- **Investigate a failure:** start with the reported model/run or trace path and
  replay its exact inputs. See [single-history reproduction](#generating-and-replaying-behavior)
  and the walkthrough's [focused commands](./WALKTHROUGH.md#run-this-example).
  [BEHAVIOR.md](./BEHAVIOR.md) documents profile-specific encodings and observations.
- **Implement another language:** follow [PORTING.md](./PORTING.md) for driver
  responsibilities and acceptance checks, then [PROTOCOL.md](./PROTOCOL.md) for
  shared bytes. [GO-PARITY.md](./GO-PARITY.md) records Go's binding adaptations.

Use large JSON catalogs as lookup indexes after identifying the relevant rule.
Begin with the model and its named regression; generated JSON preserves the
executable example for native tests. [SEMANTIC-COVERAGE.md](./SEMANTIC-COVERAGE.md)
explains what the different evidence counts establish, and
[TEST-MAP.md](./TEST-MAP.md) locates the broader test suite.

## What the suite checks

| Evidence | Execution | Meaning of a pass |
| --- | --- | --- |
| Model properties | Quint transitions, bounded exploration and named regressions | The checked model obeyed those properties within the explored bounds |
| Behavioral conformance | Sampled ITF histories and exported Quint regressions replayed in both ports | The real implementations produced the model's observations for those histories |
| Wire interoperability | Quint-derived primitive artifacts and complementary fixed vectors | The implementations matched those key, frame, envelope and invalidation cases |
| Native integration | Language, clock, codec, exporter and real Redis tests | The tested binding/environment satisfies its explicit obligations |

These kinds of evidence complement each other. Models can pass while a driver
or implementation diverges. A witness classification needs the distinguishing
public consequence; expected model state never supplies execution inputs or
actual observations. The reviewed behavioral inventory now gives every named
behavioral case a checked Quint reference and Quint-driven implementation
evidence. This is case accounting, not universal behavioral completeness.

[VALIDATION.md](./VALIDATION.md) records the completed local validation of the
reviewed implementation snapshot. Earlier reports retain their original
revisions and fingerprints; changed models, drivers or vectors require new
validation rather than inheriting a previous pass.

## Models and composition profiles

The verification models emphasize individual ownership or safety boundaries:

| Model | Starting point |
| --- | --- |
| [dialcache-core.qnt](./dialcache-core.qnt) | Enabled scopes, traversal and publication |
| [dialcache-runtime-policy.qnt](./dialcache-runtime-policy.qnt) | Sparse overlays and captured policy |
| [dialcache-coalescing-liveness.qnt](./dialcache-coalescing-liveness.qnt) | Flights, deadlines and abandoned sources |
| [dialcache-tracked-invalidation.qnt](./dialcache-tracked-invalidation.qnt) | Acquired snapshots, watermarks and delayed writes |
| [dialcache-stale-recovery.qnt](./dialcache-stale-recovery.qnt) | Retained bytes, age checks and recovery authority |
| [dialcache-shadow-validation.qnt](./dialcache-shadow-validation.qnt) | Diagnostic C0/source/C1 work and fills |
| [dialcache-redis-protocol.qnt](./dialcache-redis-protocol.qnt) | Frame/fence validation order |

Conformance profiles expose external commands that both language drivers replay:

| Profile | Behavior and interactions |
| --- | --- |
| [core](./dialcache-conformance.qnt) | Enabled traversal, hits, misses, publication and invalidation |
| [effects](./dialcache-effects-conformance.qnt) | Pending reads, sources and serialization; deadlines, refill authority and late effects |
| [scope](./dialcache-scope-conformance.qnt) | Nested enablement, request memoization, shared work and scope closure |
| [recovery](./dialcache-recovery-conformance.qnt) | Retained stale bytes, classifier policy, age checks and request-only recovery publication |
| [policy](./dialcache-policy-conformance.qnt) | Runtime overlays, captured policy, cache lifetime, capacity and coalescing changes |
| [shadow](./dialcache-shadow-conformance.qnt) | Dark reads, source comparison, confirmation, conditional fills and diagnostic outcomes |
| [admission](./dialcache-admission-conformance.qnt) | Served-hit shadow admission, deduplication, deadlines and capacity held by unfinished work |
| [layers](./dialcache-layers-conformance.qnt) | Request/local/remote composition, instance and key isolation, publication and invalidation |
| [independent](./dialcache-independent-conformance.qnt) | Uncoalesced callers, independent budgets, acquired snapshots and per-call refill authority |
| [recovery-read](./dialcache-recovery-read-conformance.qnt) | Held reads/decode, compressed recovery, logical versus physical age, marker lifetime and publication |
| [local-failure](./dialcache-local-failure-conformance.qnt) | Local storage faults, preserved source outcomes and request publication |
| [runtime-boundaries](./dialcache-runtime-boundaries-conformance.qnt) | Omitted/invalid policy leaves, defaults, exact rollout cohorts and policy capture |
| [shadow-layers](./dialcache-shadow-layers-conformance.qnt) | Dark fills and local/request reuse; independent sources and mixed served/dark capacity |
| [local-clock](./dialcache-local-clock-conformance.qnt) | Fractional environment time and the shared whole-millisecond process-local expiry grid |
| [source-budgets](./dialcache-source-budgets-conformance.qnt) | Default/unbounded/finite source deadlines, held policy, followers, outside calls and key failures |

These profiles deliberately bound callers, keys, contexts, capacities, payloads
and time. Their introduction does not imply that every product of those domains
is explored. [profiles.json](./profiles.json) records profile versions, input
encodings, smoke traces and implementation declarations.

## One execution inventory

[execution.json](./execution.json) is the source for scheduled models,
invariants, model regressions, exported replay regressions, vector generators,
seeds and exploration bounds. [coverage-witnesses.json](./coverage-witnesses.json)
records required consequences. [semantic-cases.json](./semantic-cases.json) and
[quint-case-audit.json](./quint-case-audit.json) give each evidence link a reviewed
scope. Native cases are separate in [feature-coverage.json](./feature-coverage.json).
Read the manifests or run their checkers for current totals instead of copying
counts between documents:

```sh
node formal/execution.mjs
node formal/check-semantic-coverage.mjs
node formal/check-feature-coverage.mjs
node formal/run-models.mjs check --dry-run
node formal/run-models.mjs generate --dry-run
```

A declaration alone does not count as a checked property. The inventory rejects
unscheduled regressions, stale references and positive scenarios/vectors without
a case assignment. A case may cite several witnesses; each must hold. Shared
histories or repeated citations are not independent proofs.

## Generating and replaying behavior

Run the repository [Make targets](../Makefile) from its root. Local commands
and hosted CI share those targets, so a failure has the same reproduction path.
Use Node 24, pnpm 10.33.0 and Go 1.27.1 to match CI. Install repository
dependencies with `corepack pnpm install --frozen-lockfile`; the targets do not
install tools or dependencies. Full model work and fixture recomputation also
require Quint 0.32.0 and its Rust evaluator 0.6.0. Install Quint with
`npm install --global @informalsystems/quint@0.32.0`; the pinned evaluator must
be available to it. Real-server integration requires Docker. Full local CI also
needs the exact Node 22.15.0 executable for the supported-runtime package floor;
pass its absolute path as `NODE22_BIN`. Make targets expect these tools to be
installed before validation starts.

```sh
make help          # List targets and prerequisites.
make check         # Fast native checks, committed Quint-derived smoke and audits.
make formal        # Full models, corpus and prepared TS/Go conformance reports.
make mutations     # Challenge both ports after their full reports pass.
make integration   # Real Redis/Valkey/Cluster and cross-language checks.
make ci NODE22_BIN=/path/to/node22/bin/node
                   # All local lanes, including the exact Node 22.15.0 floor.
```

| Target | Scope |
| --- | --- |
| `check-ts`, `check-go` | Native checks for one language; Go includes race detection |
| `docs` | Build the documentation |
| `package-floor` | Run zstd and packed-package checks with exact Node 22.15.0 via `NODE22_BIN` (or the current Node only if it is 22.15.0) |
| `audit` | Check reviewed manifests, source mappings and artifact freshness without Quint |
| `smoke` | Replay committed Quint-derived smoke and fixed supplements in both ports |
| `formal-corpus` | Check all scheduled models, generate the full corpus, recompute committed artifacts, and complete TS replay |
| `formal-go` | Validate the existing TS completion, then prepare and complete Go replay of that corpus |
| `mutations-ts`, `mutations-go` | Measure one port's fault catalog against validated full evidence; Go requires both completion reports |
| `integration-ts`, `integration-go` | Run one port's real-server integration checks |
| `fixtures-check` | Recompute and compare all committed Quint-derived artifacts |

`make check` and `make smoke` use committed artifacts without starting Quint.
They do not establish full parity. `make formal` checks all scheduled model
invariants and named regressions, exports sampled and public-action histories,
then runs TS and Go through the shared completion gates. TS witness evidence
is produced before Go's inputs are prepared. Reports and corpus files live
under `.formal-traces/`; changed inputs invalidate their completion reports.

Hosted pull requests run the fast native, race, smoke and audit checks plus
both real-server integration suites. Changes to models, generation inputs or
related tooling also trigger committed-artifact recomputation. The complete
formal and mutation workflow runs manually and weekly. A behavior or model
change still requires full validation for its exact inputs before merge;
release and new-port acceptance also require full evidence. Passing only the
fast PR checks cannot replace the full 7,180-check acceptance inventory.

[GitHub requires a manually dispatched workflow to exist on the default branch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).
Once the full workflow is on `main`, select the PR branch/ref when dispatching
it. Until that first merge, use `make ci` locally with `NODE22_BIN` set. The
weekly run validates its `main` snapshot; it does not validate a different PR's
inputs.

Regenerate committed predictions after an intentional model change with
`node formal/generate-artifacts.mjs --write`, then run `make fixtures-check`.
Make targets clear inherited trace selectors and `QUINT_SEED`, using the
execution manifest's seed, backend, thread count, sample and transition bounds.
For exploratory runs, the lower-level `formal/run-models.mjs` commands accept
`QUINT_SEED`; keep those results separate from the reproducible acceptance run.
These are bounded simulations, not exhaustive mathematical proofs.

For `explicit-v1` profiles, every public transition records
`input: { name, choice }`. Named regressions use those same public actions and
export under `.formal-traces/regressions/<profile>/<test>.itf.json`. The exporter
normalizes that explicit input into the common replay envelope; it never infers
commands from expected state differences. Private state-patch regressions remain
model-only and must not be exported as implementation histories.

Both ports replay the sampled corpus **and** the exact scheduled regression
inventory. Regressions guarantee reviewed exact boundaries independently of
random reachability. Sampled traces explore additional schedules; required
witness gates check their consequences across the combined corpus. Without
trace selectors, ordinary tests use committed smoke traces and fixed portable
scenarios. A smoke pass cannot satisfy the full corpus completion gate.

Replay one failing feature history with either language:

```sh
DIALCACHE_FEATURE_TRACE_FILE=.formal-traces/regressions/shadow/confirmationPastFreshnessKeepsOriginalPayloadAndAgeTest.itf.json \
  corepack pnpm exec vitest run test/formal-features.test.ts --coverage.enabled=false
DIALCACHE_FEATURE_TRACE_FILE="$PWD/.formal-traces/regressions/shadow/confirmationPastFreshnessKeepsOriginalPayloadAndAgeTest.itf.json" \
  go -C go test -race -count=1 -run '^TestFeatureConformance$' ./...
```

Core/effects failures use `DIALCACHE_MBT_TRACE_FILE` or
`DIALCACHE_EFFECTS_TRACE_FILE` and their corresponding test files. Local-clock
uses the feature selectors with `test/formal-local-clock.test.ts` and the Go
local-clock replay. Failures print the input, expected observation, actual
observation and reproduction command.

## Wire artifacts and native boundaries

Scheduled `vectorExport` entries identify the Quint model, generator, artifact,
source hashes and case count. Frame/text/duration, invalidation and key/cohort
models compute their own expected outputs. Exporters translate representation;
they do not call production transforms to obtain expected bytes or states.
Envelope expansion adds marker/threshold/selection behavior with independently
verified native codec outcomes and encoded sizes as environmental inputs.
[PROTOCOL.md](./PROTOCOL.md) describes the exact scopes and remaining boundaries.

The fixed [protocol-vectors.json](./protocol-vectors.json) and
[invalidation-vectors.json](./invalidation-vectors.json) remain complementary
examples. Actual invalidation transitions run on Redis/Valkey, with atomic
fixture setup and observation and only measured server elapsed time subtracted
from finite TTL expectations. Integration also checks primary routing, cluster
hash tags and bidirectional TypeScript/Go payload and invalidation behavior.

Native tests retain API registration, borrowed-reference behavior, custom clock
resolution, exporter registration, codec resources and adapter cancellation.
The local-clock profile connects a fractional-time Quint contract to real
default clock construction. Local-failure connects portable failure effects to
native fault injection; neither seam changes the production API. Full IEEE754
shortest decimal formatting, arbitrary integer widths, native zstd stream quirks
and actual resource ceilings retain their separately stated binding evidence.

## Go completion and fault challenges

The main full-run command is `make formal`. To resume after a successful
`make formal-corpus`, run `make formal-go`; it validates the existing TS report
and current corpus before preparing Go. To challenge the completed run:

```sh
make mutations-ts  # Requires the current TS completion report.
make mutations-go  # Requires the current TS and Go completion reports.
```

These targets are also used by the manual and weekly full workflow. The TS
mutation measurement may overlap Go replay; Go mutations start only after Go
completion. `make mutations` verifies both reports before measuring both ports.

The completion checker derives required replay leaves, regression inventory,
protocol cases and witness gates from current metadata. A partial, skipped or
smoke-only run cannot pass. Mutation runners compile each reviewed fault and
retain raw assertion reports in isolated copies. Compile/import failures,
missing witnesses, crashes and watchdog failures are infrastructure failures,
not detections. Reports retain exact revisions, source/configuration hashes,
corpus hashes, tool versions, counts and survivors.

Source-duration and source-ownership monitors also inspect actual effect
histories without expected state. A compiling model mutation challenges the
source-relative deadline invariant. These checks establish selected safety
clauses, not full refinement, arbitrary scheduling fairness or eventual progress.

## Assumptions and maintenance

Tracked reads require an atomic primary observation. Wall clocks supply frame
and invalidation stamps; monotonic clocks govern local expiry and deadlines.
Stable retained bytes, immutable reused values, executor progress, suitable
application-owned resource budgets and watermark durability are environmental
obligations. Invalidation deliberately does not revoke already acquired bytes,
request memo, local values or registered work. Shadow mismatch is diagnostic,
not repair or a linearizable source/cache snapshot.

For a changed rule, update Quint and its independent check, retain a
consequential replay, update both implementations as needed, and review the
case/audit/native mappings. [source-audit.json](./source-audit.json) accounts for
reviewed test declarations and documentation sections; it does not imply that
every assertion has a formal equivalent. Preserve historical reports after
input changes until fresh execution completes.
