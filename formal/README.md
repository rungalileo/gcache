# Executable DialCache specification

Quint defines the portable contracts that TypeScript, Go and future ports must
preserve. Native drivers execute external commands against the real libraries;
generated expectations stay in the test coordinator.

## Start with your task

| Task | Read first |
| --- | --- |
| Understand system behavior | [SPEC.md](./SPEC.md), then the relevant model below |
| Follow one rule into both implementations | [WALKTHROUGH.md](./WALKTHROUGH.md) |
| Change a behavior or extend coverage | [AUTHORING.md](./AUTHORING.md) |
| Implement another language | [PORTING.md](./PORTING.md) and [PROTOCOL.md](./PROTOCOL.md) |
| Locate or reproduce a failing check | [TEST-MAP.md](./TEST-MAP.md) and the commands below |
| Interpret validation results | [VALIDATION.md](./VALIDATION.md) |

Start with readable Quint and a named regression. The JSON catalogs are indexes
and generated artifacts; a reader should not need to open them to learn a rule.
[CONTRACTS.md](./CONTRACTS.md) gives stable obligation IDs and
[FEATURE-COVERAGE.md](./FEATURE-COVERAGE.md) organizes their boundary cases.

## How the specification connects to code

Canonical Quint rules define shared acceptance conditions. Focused models
compose those rules with ownership, policy capture and environment transitions.
Independent properties check the resulting histories; conformance profiles
expose commands that the native implementations can execute.

The shared replay boundary separates three responsibilities:

- **Quint:** permitted transitions, expected results/effects, and semantic properties.
- **Replay coordination:** decode explicit inputs, map observations, check assertions,
  classify reached boundaries, and account for every required result.
- **Native drivers:** call the library, control external gates/clocks, and report
  actual results and effects without consulting expectations.

The important links are executable. Shared helpers prevent repeated transition
judgments from drifting; profile connection checks establish selected
correspondences with the contract. Independent assertions deliberately avoid
calling the helper they are meant to challenge.

## Models and composition profiles

Read [cache-rules.qnt](./cache-rules.qnt) and
[cache-contract.qnt](./cache-contract.qnt) for shared judgments and acquired
ownership records. [SPEC.md](./SPEC.md#definition-ownership-and-executable-connections)
maps them to the five checked profile connections.
[dialcache-rule-checks.qnt](./dialcache-rule-checks.qnt) supplies the finite
symbolic boundary checks.

The verification models emphasize individual ownership or safety boundaries:

| Model | Starting point |
| --- | --- |
| [dialcache-core.qnt](./dialcache-core.qnt) | Enabled scopes, traversal and publication |
| [dialcache-runtime-policy.qnt](./dialcache-runtime-policy.qnt) | Sparse overlays and captured policy |
| [dialcache-flight-deadlines.qnt](./dialcache-flight-deadlines.qnt) | Flights, deadlines and abandoned sources |
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

## Generating and replaying behavior

Use Node 24, pnpm 10.33.0 and Go 1.27.1 to match CI. Install dependencies with
`corepack pnpm install --frozen-lockfile`. Model work requires Quint 0.32.0 and
Rust evaluator 0.6.0 (`npm install --global @informalsystems/quint@0.32.0`).
`make formal` and `make explore` use the Rust evaluator and do not need Java.
The separate `make model-check` target needs Java 21 and `tar`. Its standalone
Apalache 0.56.1 runner downloads the versioned release, verifies the SHA-256 in
[execution.json](./execution.json), and extracts those verified bytes afresh.
The archive is cached under `~/.cache/dialcache/apalache/0.56.1/`; for offline
use, supply `APALACHE_ARCHIVE=/absolute/path/to/apalache-0.56.1.tgz`. Supplied
archives must pass the same checksum check.

Real-server tests require Docker. The package floor requires exact Node 22.15.0
provided through `NODE22_BIN`. Make targets check the installed prerequisites;
only the symbolic runner downloads its pinned solver archive.

```sh
make help          # Targets and prerequisites.
make check         # Native checks, package, docs and inventories.
make smoke         # Committed Quint-derived histories in both ports.
make formal        # Rust model checks, full corpus and both-port completion.
make model-check   # Separate finite symbolic checks; Java 21 and tar required.
make mutations     # Challenge assertions after full replay has passed.
make integration   # Real Redis/Valkey/Cluster and interoperability.
make explore       # Fresh recorded seed in an isolated source snapshot.
make ci NODE22_BIN=/absolute/path/to/node22/bin/node
```

`make formal-corpus` runs Rust model checks, generation and TS completion;
`make formal-go` resumes with Go against that exact corpus. `make mutations-ts` and
`make mutations-go` split the fault campaigns. `make fixtures-check` recomputes
committed artifacts; after an intentional model edit, update them with
`node formal/generate-artifacts.mjs --write` first. `make ci` includes the
separate symbolic checks after `make formal`, as well as the other local lanes.

Pinned acceptance clears inherited trace selectors and `QUINT_SEED`. Exploration
keeps a separate source snapshot, seed, corpus and diagnostic replay evidence. See
[VALIDATION.md](./VALIDATION.md) for CI policy and report interpretation.

Scheduled named public-action Quint regressions exercise their declared
boundaries independently of sampling. Both ports replay those histories and the
complete sampled corpus; required witness coverage is checked across their
union. A model regression reaches implementations only when registered for
replay in `execution.json`. Private state-patch checks stay model-only unless
rewritten as public actions.

Replay one failing feature history:

```sh
DIALCACHE_FEATURE_TRACE_FILE=.formal-traces/regressions/shadow/confirmationPastFreshnessKeepsOriginalPayloadAndAgeTest.itf.json \
  corepack pnpm exec vitest run test/formal-features.test.ts --coverage.enabled=false
DIALCACHE_FEATURE_TRACE_FILE="$PWD/.formal-traces/regressions/shadow/confirmationPastFreshnessKeepsOriginalPayloadAndAgeTest.itf.json" \
  go -C go test -race -count=1 -run '^TestFeatureConformance$' ./...
```

Core/effects use `DIALCACHE_MBT_TRACE_FILE` or `DIALCACHE_EFFECTS_TRACE_FILE`
and their corresponding tests. Local-clock uses feature selectors with
`test/formal-local-clock.test.ts` and the Go local-clock replay.

## Evidence and scope

[execution.json](./execution.json) schedules model properties, regressions,
exports and bounds. [profiles.json](./profiles.json) declares the replay profiles.
[SEMANTIC-COVERAGE.md](./SEMANTIC-COVERAGE.md) explains witness and mutation evidence.
Query the inventories instead of copying changing totals between documents:

```sh
node formal/execution.mjs
node formal/check-semantic-coverage.mjs
node formal/check-feature-coverage.mjs
node formal/run-models.mjs check --dry-run
```

The suite combines model properties, generated conformance histories,
independently computed wire vectors, complementary fixed examples and native
integration tests. Fixed scenarios have handwritten expectations and are not
Quint-generated. Their evidence mappings do not mechanically prove each fixed
assertion agrees with Quint.

The specification and tests use declared finite domains. Environmental
assumptions, allowed races and the limits of conformance claims are centralized
in [SPEC.md](./SPEC.md#assumptions-evidence-and-claims); wire/binding obligations
are in [PROTOCOL.md](./PROTOCOL.md) and [GO-PARITY.md](./GO-PARITY.md).
