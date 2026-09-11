# Docs and test behavior audit

[`source-audit.json`](./source-audit.json) records reviewed ordinary test declarations and documentation sections. Each entry names its source location and the obligations or boundaries in [`CONTRACTS.md`](./CONTRACTS.md). Parameterized declarations and loops count once here; Vitest expands them into more executions. Get current inventory counts from `node formal/check-source-audit.mjs`; they are not a behavioral coverage percentage.

The audit separates three questions:

1. What rule does the test assertion or documentation impose? Repeated examples and API variants can establish the same rule.
2. What executable artifact captures that portable rule? The inventory points to a model, fixed behavioral scenario, protocol vector, or a combination. A verification model is not automatically implementation replay.
3. Which assertions instead concern a binding (`B`), environment assumption (`E`), or explicitly optional integration/resource profile (`X`)? Those dispositions preserve the ordinary test requirement; they do not relabel an implementation test as formal coverage.

Mappings record the reviewed semantic obligations of each declaration, including assertions that share an obligation with another test. They do not promise one formal transition per assertion, equivalence between two test programs, exhaustive interleavings, or identical APIs in every language. A public documentation section can contain several independent prose clauses; assigning that section contract IDs does not prove every clause is formalized or consistent with its executable evidence. Navigation, examples, installation, and release tooling use the binding/deployment dispositions. Reviewing changed prose remains necessary even when the inventory check passes.

## Gaps closed by this audit

| Evidence in existing tests/docs | Previously missing portable consequence | Executable addition |
| --- | --- | --- |
| `dialcache-local`: failed active local reads/writes; `dialcache-logger`: simultaneous observer failures | The core model lacked local storage failure outcomes despite its broad fail-open description | Core local read/write health outcomes, two invariants, four deterministic regressions; source/remote results and eligible request memo survive failed local writes |
| `dialcache-redis`: custom frames, legacy replies, invalid tracked fences; `dialcache-metrics`: untrusted metadata; `docs/redis.md` custom-client contract | Wire decoder vectors did not test the core's separate semantic-adapter trust boundary | 16 caller-level reply scenarios, including discriminator precedence, reason/fence independence, malformed metadata, and untracked fence removal (C55) |
| `dialcache-redis-read-deadline`: read context, cooperative abort, late settlement, independent budgets | Read timeout results were checked without observing cancellation requests at the adapter | Five schedules recording supplied budget and actual cancellation events, including late resolve/reject before timer delivery (C56) |
| `dialcache-config-ramp`, `dialcache-shadow-validation`, `docs/configuration.md` | Hash samples had vectors, but the exact membership comparison lacked public-call evidence | Local, remote, and shadow scenarios exclude equality and admit just above the independently calculated sample (W03/C47) |
| `dialcache-stale-on-error`: compressed retained values and corrupt envelopes | Decompression and recovery were covered separately | Valid/corrupt compressed stale candidates through the actual recovery path; no shared publication; original failure preserved (W08/C45) |
| `dialcache-redis`: unsupported encoding; `dialcache-redis-read-deadline`: reader-clock sampling | Decoder classification needed caller-level refill/age consequences | Tracked/untracked encoding failures suppress refill; freshness is measured after a held read settles (W04/C22/C28) |
| `dialcache-metrics`, shadow tests, `docs/observability.md` | Value age/clock diagnostics were mostly outside portable scenarios | Recovery age after decode, no age on failed recovery, original-C0 shadow age with rollback clamp, and serving/dark/confirmation future-offset attribution (C57) |
| `dialcache-metrics`, `docs/observability.md` | Broad failure-isolation scenarios did not check stable categories or shared-execution event counts | Failure-site categories, one coalesced leader trail, request/process follower scopes, recovered source failure, and no second error from late rejection (C58) |
| `dialcache-liveness`, `dialcache-metrics`, `docs/observability.md` | Phase budgets were modeled but duration/size observations were not linked to those phases | Fresh decode included in remote-get duration; accepted source duration excludes later preparation/write; UTF-8 byte sizes are observed before dispatch (C59) |
| `dialcache-shadow-confirmation`, `docs/shadow-validation.md` | Confirmed mismatch outcome did not test opt-in warning eligibility | Logging omitted/enabled with match, mismatch, and superseded verdicts (C60) |

This historical audit added **55 fixed scenarios**, taking that corpus from 174 to **229**. It reused the shared driver then used by nine generated profiles. Subsequent expansions added profiles and scenarios; [execution.json](./execution.json) and [FEATURE-COVERAGE.md](./FEATURE-COVERAGE.md) describe the current inventory. The optional `observe` fixture selects public diagnostic/adapter events; all unselected observations and cache internals remain outside that event stream. Expected events never enter execution. A negative harness check corrupts a miss expectation and requires replay to fail.

## Keeping the audit current

Run:

```bash
node formal/check-source-audit.mjs
```

Normal TypeScript tests run the check too, without Quint. It fails when a source file is added/removed, its contents change, a test/section is added or moved, or an entry lacks a known contract disposition. SHA-256 fingerprints include inline fixture and assertion changes, not just test titles. Shared helper changes must still be reviewed with their consuming tests; helpers are not independently fingerprinted. This prevents a green *stale inventory* from silently being reused after source drift; it cannot judge whether a mapping is correct.

For a changed file, read the changed assertions/prose and any affected fixtures, then:

- Reuse an existing obligation when it already captures the rule. Verify its named executable evidence, including negative/boundary consequences.
- Add a scenario/vector/model and update the inventory when a portable consequence is missing. Record a specific binding/assumption/optional-profile disposition otherwise.
- Update that source's entries and fingerprint only after the review. Do not refresh fingerprints merely to satisfy the check. `sourceSnapshot()` in the checker extracts current locations and hashes; it never assigns contract dispositions.
- Run the focused implementation and formal checks. A mapping is evidence bookkeeping, not a substitute for those checks.

The `sources` inventory covers `README.md`, every current top-level `docs/*.md` page, and ordinary `test/*.test.ts` files, including real Redis/Cluster integration declarations. The formal harness/corpora test themselves. Fixture helpers have no independent case declarations; their meaning is reviewed with the consuming tests. Packed-package checks and compile-time examples retain the public binding boundary, and continue running in normal CI.

### Formal and Go guide review

`reviewedGuides` additionally covers every top-level `formal/*.md` guide and
`go/README.md`. Each record preserves the complete content hash and heading
inventory, with a reviewed purpose and scope. Contract guides name the relevant
obligations; tooling and coverage guides describe workflow or evidence accounting
without manufacturing behavioral coverage. Historical evidence records name
their original implementation revisions. Those old counts and report hashes
remain attached to the executions they describe.

The same checker rejects an added, removed or edited guide, changed headings,
missing review scope, invalid contract IDs, and historical evidence without
revision identities. `guideSnapshot()` extracts current content hashes and
headings; it does not supply review metadata. After reading a changed guide,
review its claims against the relevant model, source, manifest or historical
report before updating the snapshot and its explanation.

Guide review is file-level freshness and scope accounting, separate from the
public section-to-contract mappings. Neither mechanism proves every prose clause
or infers that a model change still agrees with an unchanged guide. Go's
applicability ledger retains the public `sources` mappings; its audit hash also
binds these guide reviews without counting them as additional Go tests.

## Claim boundary

All inventoried sources have an explicit disposition. This does **not** mean all Vitest assertions are formalized or every implementation branch is exercised by portable replay. Local storage failure consequences now have Quint-driven replay in the `local-failure` profile, using native storage/clock fault seams to observe caller results and later publication. The seam is a driver capability, not a new public library API. Exporter schemas/registries, exact JSON logging truncation, compression implementation/resource ceilings, transport/connection lifecycle, and TypeScript API/type/Promise details still use the documented B/E/X boundaries. Porting those integrations requires their own checks.

Within the portable scope, the inventory now names 60 behavioral and nine protocol obligations with executable evidence. Remaining assurance work includes larger mixed-feature histories, broader generated exploration, and more combinations of source/codec/adapter faults. The Go implementation now replays every profile in `execution.json`, fixed scenarios and protocol groups, with separate real interoperability tests. No finite source inventory or sampled trace count proves semantic completeness.

The [semantic coverage measurement](./SEMANTIC-COVERAGE.md) refines those broad obligations into named cases and checks explicit evidence links. Its isolated mutation comparison challenges actual assertions and reports ordinary/generated/portable detection separately. Full disposition of source declarations must not be confused with universal generated coverage: the finer inventory records each case's checked scope and remaining finite limits. [VALIDATION.md](./VALIDATION.md#mutation-evidence) records the completed measurements in which both languages' generated and portable cohorts detected all 13 selected faults; ordinary and fixed cohorts retain their separately reported survivors.

The subsequent historical Go milestone added nine fixed scenarios (238 total), including tracked-local exceptions, explicit null leaves, sparse/default policy, malformed logging, and expired deferred dark work. Those additions are separate from the 55-scenario source audit above. The current behavioral expansion brings the fixed corpus to 244 scenarios; [FEATURE-COVERAGE.md](./FEATURE-COVERAGE.md) explains its full assignment to named cases without changing this historical audit denominator. The real-server vector wrapper now observes preserved key types/contents on rejected invalidations; its source fingerprint and unchanged W09 declaration disposition were reviewed together.
