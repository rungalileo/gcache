# Validation snapshots

## Port-readiness milestone

The completed implementation and harness snapshot is
[`1fc04bc5acabd1206fd120f56aaf1e7ccf33a82a`](https://github.com/lan17/DialCache/commit/1fc04bc5acabd1206fd120f56aaf1e7ccf33a82a).
This milestone adds reproducible fixture generation, a concrete
[port driver contract](./PORTING.md), and a reusable language-neutral completion
gate. It preserves the existing behavioral models and public predictions.
A subsequent documentation-only commit records these results.

### Completed local checks

| Check | Result |
| --- | --- |
| Committed Quint artifacts | All four wire exporters and all 26 smoke/witness artifacts regenerated and byte-compared successfully; the latter contain 126 histories |
| Fast fixture checks | Native TS and Go tests verify recipe/model/exporter and artifact fingerprints without launching Quint |
| Fixture negative controls | An out-of-domain input and a disabled action both failed export without changing any output artifact |
| Quint checks and corpus | All 26 models, 189 invariants and 388 regressions passed; regenerated 5,280 sampled histories and 165 exported public-action histories across 15 profiles |
| Shared completion | Both languages passed the same 7,180 required IDs: 5,280 sampled, 165 regression, 244 fixed scenario, 1,477 protocol and 14 witness gates |
| Full native replay | TypeScript: 7,237 tests passed. Go with race detection: 7,335 leaves passed, including harness controls |
| TypeScript unit coverage | 2,807 tests passed; 98.03% lines/statements, 97.35% branches and 99.73% functions, with thresholds unchanged |
| Regular CI | Frozen install, typecheck, build, docs, Node 22.15/24 packed-package checks, Node 22.15 zstd round-trip/output-cap smoke, Go vet and formatting passed |
| Real integration | 819 TypeScript tests and 1,019 Go leaves passed; Go used race detection. Both exercise Redis 6.2, Valkey 8, Cluster and cross-language interoperability |
| Ancillary checks | Workflow/title/link checks passed; CodeQL JavaScript/TypeScript (87 rules) and Actions (17 rules) reported zero findings |

All 435 required witnesses were reached. The inventory retains 240 behavioral,
22 wire and 33 explicitly native boundary cases. These counts describe different
units of evidence and cannot be added into a coverage percentage.

### Mutation evidence

Fresh measurements ran at
[`b0ed1289968f32b730c2fd75385025833fac1a10`](https://github.com/lan17/DialCache/commit/b0ed1289968f32b730c2fd75385025833fac1a10).
All unmodified baselines passed: 660 ordinary TS tests, 126 ordinary Go leaves,
and 6,802 generated plus 378 fixed tests per language. Generated and portable
cohorts detected all 13 selected faults in both languages. TS ordinary detected
12/13 (M12 survived), Go ordinary detected 5/13 (M01, M02, M04, M07, M09, M10,
M12 and M13 survived), and each fixed supplement detected 12/13 (M09 survived).
No compiler error, infrastructure failure or incomplete result counts as a
detection. These are the same selected faults and cohort definitions described
in [SEMANTIC-COVERAGE.md](./SEMANTIC-COVERAGE.md).

The later commits fix two malformed-core-trace controls and strengthen completion
input fingerprints. They change no production code, Quint model, behavioral
replay assertion or mutation-cohort selection. Full native replay, unit tests,
typecheck and JavaScript CodeQL were rerun on the final harness snapshot; earlier
regular/integration and mutation reports retain their actual revision identities.

### Reproduction and evidence identity

Commands and report schemas are in [PORTING.md](./PORTING.md). Runs used Darwin
arm64, Node 24.20.0, pnpm 10.33.0, Go 1.27.1, Quint 0.32.0 and Rust evaluator
0.6.0. The prepared contexts bind exact source and corpus bytes. Go additionally
binds the shared definitions, fixtures and witness JSON it consumes; isolated
changes to each of those input types were rejected, and restored bytes passed.

| Evidence | SHA256 |
| --- | --- |
| Shared specification input map | `33440b4be7f5b4250734c11d09193eb8cc2c2c97dfab8f8e8880e0577206d8a6` |
| Shared corpus input map (5,445 histories) | `128eb036064d68b712efa0bd38716befabfee877844725b7a9ffc3f411dedec4` |
| TypeScript native replay report | `58790599e546f384093e478dfb5a9b0bd0430597156006c439da77fd475684bb` |
| Go native replay report | `7540d1e9fe3d289e85d4b67d517358556486a847acbd747f20b35537a11f6967` |
| TypeScript mutation report | `bdca31ec11a493186ef3a43e5592659a3f2296b8957ab9d2258b48d66a0db946` |
| Go mutation report | `fe7dad3772cbfe2ef6ae88865a8a51781fd6077fa6dccceb7fd9b6a64d91fc76` |

The two mutation reports independently record corpus SHA256
`2657168b8309540da5a17a2e008fc2aa933973d559af2d933efc61b0f7b82540`.
That fingerprint hashes ordered paths and bytes; completion's corpus fingerprint
hashes its JSON path/hash map. They identify the same history files using
different encodings and are not interchangeable.

Local evidence is retained under `/tmp/dialcache-portability-ci/`, indexed by
`completed-evidence-summary.json`; native replay/context/witness/mutation files
are under `.formal-traces/`. Earlier failed controls and superseded reports
remain diagnostics. The initial Go full run exposed string-based negative
controls modifying new input metadata instead of the core action field; those
controls now target that field and reject ineffective mutations. Completion
also now detects edits to shared Go inputs after their native assertions pass.

These are local results, not a claim about hosted CI status. Acceptance remains
finite evidence for the declared contracts and environment assumptions. Native
binding adaptations, codec domains and the lack of automatic history shrinking
are explicit in [PORTING.md](./PORTING.md) and [GO-PARITY.md](./GO-PARITY.md).

## Earlier behavioral-authority snapshot

This snapshot identifies implementation commit
[`bf8405a9326a09012db4ed243f3f72f326a38a87`](https://github.com/lan17/DialCache/commit/bf8405a9326a09012db4ed243f3f72f326a38a87).
TypeScript/model results identify that commit. Go replay and mutation checks
were restarted at
[`c4fcb34d21cf19bca534926abdaf11d158674004`](https://github.com/lan17/DialCache/commit/c4fcb34d21cf19bca534926abdaf11d158674004),
which changes only two Go test files to include exported effects histories in
witness validation. Production code, models and TypeScript inputs are unchanged.

This records local validation on Darwin arm64; it does not assert hosted CI
status or universal behavioral equivalence. The documentation commit linking
this page may be later than the validated implementation commits.

### Completed scope

| Check | Result |
| --- | --- |
| Quint verification | 26 models, 189 scheduled invariants and 388 named model regressions passed |
| Shared history generation | 5,280 sampled histories plus 165 exported public-action regressions across 15 profiles |
| Quint wire generation | 1,631 generated cases: frames/text/durations, keys/cohorts, envelopes and invalidation |
| TypeScript full conformance run | 7,237 tests passed, including replay and harness controls |
| Go race replay and completion gate | 7,334 leaves passed; exact completion confirmed 5,280 sampled histories, 165 exported regressions, 244 fixed scenarios, 1,477 protocol vectors and all 14 witness profiles |
| Regular TypeScript CI | 2,795 unit tests and 819 real integration tests passed; frozen install, typecheck, build and docs passed |
| Production coverage | 98.03% lines/statements, 97.35% branches, 99.73% functions; existing thresholds unchanged |
| Go static checks | `go vet ./...` and repository formatting passed |
| Ancillary CI | CodeQL JavaScript/TypeScript (87 rules) and Actions (17 rules) reported zero findings; workflow lint and PR-title checks passed |
| Go real integration | 1,019 leaves passed, including 337 invalidation transitions on each of Redis 6.2, Valkey 8 and Redis Cluster |
| Consumer floor | Node 22.15.0 zstd/output-cap smoke and packed-package checks passed; Node 24.20.0 package check also passed |

The complete protocol replay contains 1,477 vectors: 134 fixed and 1,343
Quint-derived primitive rows. Fixed behavioral scenarios contribute 244 cases;
435 required witnesses establish that the selected histories reach their
consequential observations. Real invalidation cases run separately on servers. A
history, witness, test assertion and vector row are different units; their counts
must not be added into a behavioral coverage percentage. All 240 behavioral and
22 wire cases have checked Quint references and Quint-driven implementation
evidence, within their recorded scopes.

### Mutation challenge

All unmodified baselines passed: TypeScript ran 660 ordinary tests, Go ran 125
ordinary tests, and each ran 6,802 generated plus 378 fixed tests. Each positive
portable union contains 7,180 tests/gates. The challenge injects 13 selected
semantic faults; it does not enumerate every possible implementation error.
The generated cohort includes the 5,445 shared histories, their required witness
gates and Quint-derived primitive vectors. Fixed and generated primitive
rows are disjoint. Harness/schema/classifier negative controls receive no
behavioral detection credit.

| Language | Ordinary | Quint-generated | Fixed supplement | Portable union |
| --- | --- | --- | --- | --- |
| TypeScript | 12/13; M12 survived | 13/13 | 12/13; M09 survived | 13/13 |
| Go | 5/13 | 13/13 | 12/13; M09 survived | 13/13 |

Every selected fault must compile, every unmodified baseline must pass, and
required detections must reach actual assertions. A compile error, timeout,
missing witness or incomplete report is a failed measurement, not a detection.
Both generated cohorts detected all 13 faults, including all 11 behavioral
faults and both wire faults. The ordinary Go survivors were M01, M02, M04, M07,
M09, M10, M12 and M13. All 435 required witnesses were reached. No survivor is
excluded from the denominator or labeled equivalent.

### Evidence identity and reproduction

The execution manifest fixes the models, exported regressions, vector artifacts,
backend, seed and bounds. This run used Node 24.20.0, pnpm 10.33.0, Go 1.27.1,
Quint 0.32.0 and the Rust evaluator. The shared history corpus contains 5,445
files with SHA256
`33597e9b2081440269ba8b6500316d452645719634f88cb6348a6868836ec74e`.
Generated wire artifacts carry separate model/library/exporter fingerprints.
The completed TypeScript mutation report has SHA256
`a93ade57fe9accd3233c1aa2d752ae2dd9d7c14e3e25b527118b1848e33e0ba9`;
the completed Go mutation report has SHA256
`c7dd1c777fd5815d9de0ab699c394918e0464c9b4195e664b4f2e3d75e425178`.
The passing Go completion summary identifies replay report SHA256
`e1f4d714dac7940c2e379dc261d2428e490cbf07d41d595a330dfdb8b633e5b8`.

Some regular CI commands ran on the reviewed precommit working tree. Their
reports retain that actual revision and per-file source hashes: the final unit
snapshot differs from the implementation commit only in explanatory TEST-MAP
prose; build/package/integration production inputs are unchanged. These reports
are bound by matching executed inputs, not relabeled as runs on another commit.
Mutation reports retain their actual execution revisions: TypeScript at
`bf8405a`, Go at `c4fcb34`. The Go witness preflight found that its effects gate
counted 512 sampled histories while omitting 18 exported regressions. Shared
path selection now includes both sets, with a missing-regression negative
control; its focused race run passed 532 leaves before the full Go restart.

Local evidence is retained under `/tmp/dialcache-authority-ci/`, with regular CI
indexed by `typescript/regular-ci.json`. Generated replay, witness, mutation and
model artifacts use `.formal-traces/`; CI artifact names and reproduction
commands are documented in [README.md](./README.md) and
[SEMANTIC-COVERAGE.md](./SEMANTIC-COVERAGE.md). Preserve exact report/source/corpus
hashes when copying evidence. Earlier failed attempts remain diagnostics:
stale metadata, blocked metadata subprocesses, the corrected model's local
retention omission, the initial coverage-denominator mismatch, and the Go
effects witness-path omission. These attempts receive no successful gate or
mutation-detection credit.

### Limits of this result

The profiles bound callers, keys, capacities, contexts, payloads and schedules;
they do not prove fairness or refinement over all executions. Native clock and
local-fault seams exercise specified observations without adding production
fault APIs. Atomic primary reads, immutable retained/reused values, suitable
clocks, executor progress and watermark durability remain environmental
assumptions.

Key numeric modeling uses bounded integer magnitudes. Full IEEE754 shortest
formatting and arbitrary bigint widths retain fixed/native evidence. Envelope
rules use independently verified native codec results and encoded sizes; they
do not define zstd or require identical compressed bytes or selection outcomes
from encoders with different sizes. Native stream quirks and the real 512 MiB
resource ceiling remain distinct from small injected cap boundaries. See
[FEATURE-COVERAGE.md](./FEATURE-COVERAGE.md), [PROTOCOL.md](./PROTOCOL.md) and
[GO-PARITY.md](./GO-PARITY.md) for the exact adaptations and assumptions.
