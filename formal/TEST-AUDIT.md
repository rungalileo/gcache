# Docs and test behavior audit

[`source-audit.json`](./source-audit.json) records reviewed ordinary test declarations and documentation sections. Each entry names its source location and the obligations or boundaries in [`CONTRACTS.md`](./CONTRACTS.md). Parameterized declarations and loops count once here; Vitest expands them into more executions. Get current inventory counts from `node formal/check-source-audit.mjs`; they are not a behavioral coverage percentage.

The audit separates three questions:

1. What rule does the test assertion or documentation impose? Repeated examples and API variants can establish the same rule.
2. What executable artifact captures that portable rule? The inventory points to a model, fixed behavioral scenario, protocol vector, or a combination. A verification model is not automatically implementation replay.
3. Which assertions instead concern a binding (`B`), environment assumption (`E`), or explicitly optional integration/resource profile (`X`)? Those dispositions preserve the ordinary test requirement; they do not relabel an implementation test as formal coverage.

Mappings record the reviewed semantic obligations of each declaration, including assertions that share an obligation with another test. They do not promise one formal transition per assertion, equivalence between two test programs, exhaustive interleavings, or identical APIs in every language. A public documentation section can contain several independent prose clauses; assigning that section contract IDs does not prove every clause is formalized or consistent with its executable evidence. Navigation, examples, installation, and release tooling use the binding/deployment dispositions. Reviewing changed prose remains necessary even when the inventory check passes.

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

The [semantic coverage measurement](./SEMANTIC-COVERAGE.md) refines those broad obligations into named cases and checks explicit evidence links. Its isolated mutation comparison challenges actual assertions and reports ordinary/generated/portable detection separately. Full disposition of source declarations must not be confused with universal generated coverage: the finer inventory records each case's checked scope and remaining finite limits. The [historical baseline](./VALIDATION.md#historical-results) preserves the completed mutation measurements and survivors. [Current validation](./VALIDATION.md) describes how to produce fresh evidence.
