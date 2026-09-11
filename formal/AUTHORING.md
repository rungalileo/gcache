# Reading and extending the DialCache models

The Quint files should let a reader understand a behavior without translating
the TypeScript implementation. Readability is part of the specification's
acceptance criteria. Executable checks then challenge that written behavior.
Quint is the behavioral source of truth for both TypeScript and Go. The prose
explains it; implementation tests must not become an independent, drifting
definition of the same portable rule.

For a first contribution, start with the [worked walkthrough](./WALKTHROUGH.md).
It follows one existing contract from a named Quint regression through actual
TypeScript and Go assertions, and identifies the catalog entry each edit owns.
Then use the checklist below for your rule; it applies the same path to another
behavior.

## Reading a model

Start with the file's scope and assumptions. Each model deliberately covers a
bounded part of DialCache. The verification models emphasize rules; conformance
profiles describe external actions that a language driver can replay. The
[model inventory](./README.md#models-and-composition-profiles) and [profile registry](./profiles.json)
identify the relevant starting point.

Read the types and state next. Distinguish three kinds of information:

- **Environment inputs:** policy replies, cache bytes, clocks, source results,
  and the completion or failure of external work.
- **DialCache ownership:** a live request scope, registered flight, retained
  candidate, or pending publication.
- **Recorded observations:** a value acquired earlier, the time a result was
  accepted, and the effects or outcomes already produced by the modeled call.

Those distinctions explain races. A later invalidation changes external storage;
it cannot change bytes already retained by a caller. Likewise, advancing time
after a result was returned cannot retroactively invalidate that return.

Then follow the transitions. `s` is the current state; `s' = ...` defines the
next state. In `all { ... }`, guards must hold together for the transition to be
enabled. `any { ... }` and `nondet ...oneOf()` provide alternative schedules or
inputs. A record update lists changed fields and retains the rest with `...s`.
Named predicates make the conditions readable; they do not perform cache work.

Finally, read the invariants and `run ...Test` examples. An invariant states a
property of explored states. A regression gives a concrete sequence and its
expected observations. A `val` declaration can also be a helper; `execution.json`
identifies the properties that are actually scheduled for checking. Some
regressions deliberately corrupt state to show that
a property rejects the fault. They are tests of the property, not allowed system
transitions. Passing bounded exploration is not a proof over every execution.

## Writing conventions

Use this reading order, allowing a short helper next to the transition it explains:

1. Scope, assumptions, omissions, and the relevant contract IDs.
2. Types, finite input domains, and state ownership.
3. Named predicates and small pure helpers.
4. Initial state and environment/system transitions.
5. The exploration `step` definition.
6. Independently stated invariants.
7. Deterministic regression histories.

Use two-space indentation. Expand substantial records, nested updates, and
multi-condition guards; aim for lines that can be read without horizontal
scrolling. Keep a genuinely short action compact. Prefer a descriptive
intermediate state such as `published` or `completed` over a chain of `x`, `y`,
and `z`. Comments should explain ownership, ordering, assumptions, or a boundary
case, rather than narrate the syntax. Quint 0.32.0 has no CLI formatting command;
these are reviewed authoring conventions.

Give phase, outcome, policy, and fixture codes names. Verification models can
use sum types. Conformance profiles retain their published integer encodings
and use named constants, so a readability edit does not silently change the
portable trace interface. An integer can have a different meaning in another
profile; do not share a constant merely because its numeric value matches.

Keep repeated definitions DRY when they express the same operation. Small
representation helpers such as completing callers owned by one source belong
in [conformance-observations.qnt](./conformance-observations.qnt). Name repeated
transition conditions locally, including the time or snapshot they inspect.
Keep request lifetime, flight ownership, deadline acceptance, and publication
policy in the model that explains them. A common cache-model framework would
make those differences harder to see.

An assertion needs an independent way to detect a wrong transition. Do not
rewrite both sides of a check to call the same newly extracted eligibility
predicate. For example, the transition can use a named recovery-age predicate,
while its invariant independently compares the retained timestamp with the
recorded acceptance time and exclusive maximum age. This intentional repetition
provides evidence; it is not duplicate behavior to remove mechanically.

## Codifying the next behavior

For each new rule or interaction:

1. **State the contract.** Record the observable guarantee, its boundary cases,
   environmental assumptions, and allowed races in `SPEC.md`/`CONTRACTS.md`.
   Distinguish language binding details from behavior a port must preserve.
2. **Model the smallest relevant boundary.** Extend the appropriate model with
   readable state, inputs, and transitions. Add another profile only when an
   existing one cannot express the necessary ownership or scheduling boundary.
3. **Challenge the rule.** Add an independently stated invariant or regression,
   and a representative fault when it adds useful evidence. Merely declaring a
   property is insufficient: schedule it in `execution.json`.
4. **Exercise both implementations.** Require a generated witness or exported
   Quint regression that exposes the rule's consequence, and replay the same
   history in TypeScript and Go. Fixed scenarios preserve narrow regressions;
   protocol vectors and native
   tests cover wire and language boundaries. The driver supplies only external inputs and asserts actual public
   results/effects. Expected model state must never drive the implementation.
5. **Account for the evidence.** Link the case, property, scenario, and required
   witness in the existing catalogs. Preserve explicit gaps and update profile
   claims only after the corresponding language driver passes.

Both implementations replay the registered profiles. To expand their generated
scope, model the next bounded interaction and its environment controls, then
replay the same corpus in both languages. A readable model and TypeScript
replay do not by themselves establish Go conformance; the Go completion gate
also requires every scheduled profile, fixed case, protocol case, and witness
gate to finish successfully.

## Give reviewers focused context

For a human or LLM review, search the stable contract and case IDs first, then
extract the matching catalog entries. Provide a small context packet:

- Contract/case IDs, the observable rule or change, and its documentation link.
- Model file, exact regression/property symbols, and their execution-manifest entries.
- Profile name, TS and Go input mappings, and each port's actual-observation assertion.
- Latest relevant validation evidence, its source revision, and any changes since that run.

State the exact modeled bounds, environmental assumptions and native evidence
gaps. Separate a reached witness from a successful implementation assertion.
Expected model state belongs only in predictions and checks; execution must
follow recorded external inputs and actual effect ownership.

## Exporting a deterministic regression

Sampled histories explore combinations. Named Quint regressions guarantee that
a reviewed boundary is exercised even when a random seed does not reach it.
Keep the expected result in Quint; do not copy it into a hand-maintained JSON
scenario and call that Quint-driven evidence.

Profiles using `inputEncoding: "explicit-v1"` declare a top-level input record:

```quint
var input: { name: str, choice: int }
```

Every public action records its canonical command and external choice. Use
`name: "init"` only for initialization and `choice: -1` when the command has no
choice. A parameterized public action can serve both random exploration and a
named regression. The regression must invoke those actions; an arbitrary
assignment to private model state is not an executable input.

List exportable runs in the model's `replayRegressions` in `execution.json`.
Generation exports them under `regressions/<profile>/` alongside the sampled
corpus. Quint's deterministic test export omits MBT action metadata, so
`replay-inputs.mjs` normalizes only the explicit input record into the common
envelope. It never infers commands from differences in expected state.

Each implementation validates the input domain, performs the real public
operation, and compares its own observations after every step. Both completion
gates require the exact scheduled regression inventory. Link a case to its run
with `quintReplays: ["profile/regressionTest"]`; the same case must cite that
scheduled Quint check with a precise applicability scope. A checked property,
an explanatory definition, a sampled witness and an exported regression are
distinct evidence categories.

## Maintaining case and witness evidence

Use [FEATURE-COVERAGE.md](./FEATURE-COVERAGE.md) to place each new rule in its
feature family. Update `semantic-cases.json` and `quint-case-audit.json` with
precise contract, provenance and checked-scope references. Every positive fixed
scenario and every protocol/invalidation vector must be assigned to at least
one semantic case. An unmapped fixture is an accounting failure, even if its
test passes. Reuse a case for repeated evidence of the same rule; splitting
rows or mapping an entire file does not strengthen the evidence.

Keep native API, value-domain, clock, exporter and adapter obligations in
`feature-coverage.json`. Record exact tests and scope for each applicable
language, an explicit adaptation, and any evidence gap. Non-applicability
requires a concrete binding reason, not an empty evidence list. Review source
hash changes against the assertion, not only the test's unchanged name.

A generated witness must require its distinguishing input, ownership/order,
and actual observable consequence. Remove competing explanations: classifier
failure needs an otherwise eligible candidate, fence rejection needs otherwise
valid bytes, and a deadline case needs an actual boundary result. A private
phase or fixture label alone must not earn credit. Track a surviving value from
before the event being tested; even an equal-value replacement cannot prove
that the earlier publication survived. Late-effect suppression alone does not
prove that raw work retained capacity.

Add discriminating negative controls when introducing or changing witness
classification. Preserve the matching fixture or phase, then remove or alter
the final consequence and require the classifier to reject it. Exercise exact
F/M or deadline boundaries, byte-equivalence distinctions, and ownership where
the rule depends on them. Keep these classifier/harness controls outside positive
behavioral and mutation-detection cohorts. Raw expected state may classify
reachability and assert outcomes; it must never supply execution inputs or
actual observations to either implementation.

Run `node formal/check-semantic-coverage.mjs`,
`node formal/check-feature-coverage.mjs`, and the relevant attribution tests.
These validate accounting and selected classifier boundaries; they do not
replace model checks, generation, both implementation replays, or real/native
integration checks. Refresh execution fingerprints and reports after changed
inputs. Preserve previous measurements as historical until fresh runs finish.

## Reproducible committed fixtures

Add a named public Quint run or external-action recipe to
[fixture-recipes.json](./fixture-recipes.json), then run
`node formal/generate-artifacts.mjs --write`. Expected state must come from
Quint; recipes contain only external choices, selection bounds and projection
field names. Ordinary tests check artifact/source fingerprints; CI regenerates
and byte-compares predictions. See [PORTING.md](./PORTING.md) for the precise
driver, fixture and completion contracts.

## Refactoring and execution

[`execution.json`](./execution.json) is the execution schedule: invariant and
regression names, model order, exploration settings, and generated trace paths
and bounds. [`profiles.json`](./profiles.json) records versioned conformance
claims. Keep these purposes distinct; checking and generation consume the same
execution settings rather than maintaining separate invariant lists.

Preserve public action names, choice encodings, state/observation fields, and
`...Test` suffixes during cleanup. Preserve the order and nesting of `any` and
`oneOf` choices: grouping influences sampled histories even when the set of
possible transitions is unchanged. Review the model-mutation anchor if its
source expression moves or changes; its failure must never count as detection.

For a model refactor, run the scheduled model checks/regressions, generation,
implementation replay, evidence validation, and relevant mutation gates using
the [documented commands](./README.md#generating-and-replaying-behavior). Keep the
committed smoke expectations unchanged. Compare pre/post generated action and
state histories when preserving a fixed seed and schedule is intended, and
investigate differences rather than replacing expectations to obtain a pass.

Formatting and deduplication improve reviewability; they do not increase the
number of behavioral cases or justify a broader conformance claim. Changes to
behavior, bounds, or claims should be reviewed separately from cleanup.
