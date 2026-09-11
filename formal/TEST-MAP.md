# Formal contract and implementation evidence map

Quint transitions and independently checked properties define portable behavior.
Existing tests and documentation provide provenance and help discover missing
rules; they are not a second behavioral oracle. Use this map to find the relevant
slice, then read the exact case and check scope. A link to a test file does not
mean that every assertion in it is modeled.

[CONTRACTS.md](./CONTRACTS.md) assigns obligations;
[semantic-cases.json](./semantic-cases.json) maps cases to histories and vectors;
[quint-case-audit.json](./quint-case-audit.json) states each checked clause;
[feature-coverage.json](./feature-coverage.json) keeps native adaptations separate.
All 240 reviewed behavioral cases now have checked Quint references and
Quint-driven implementation evidence. This accounts for known cases, not every
input or feature combination. [VALIDATION.md](./VALIDATION.md) describes the
validation workflow and report requirements.

## Behavioral map

The verification models emphasize individual rules. Conformance profiles expose
public inputs that both implementations replay. Their current versions, bounds,
sampled trace counts and exported regressions live in
[profiles.json](./profiles.json) and [execution.json](./execution.json).

| Behavior | Model/profile starting points | Implementation provenance and observations | Finite boundary |
| --- | --- | --- | --- |
| Enablement and scopes | Core verification; core/scope/layers profiles | `dialcache-local`, `dialcache-request-local`: disabled pass-through, nested scopes, memo ownership, closure/replacement and later public reuse | Bounded context trees, calls and instances |
| Traversal, local TTL and LRU | Core/policy verification; policy/layers/local-clock profiles | `dialcache-local`, `dialcache-config-ramp`: first hit, value/absence reuse, promotion without renewal, zero capacity and common native millisecond grid | Selected capacities/keys; custom-clock resolution remains native |
| Coalescing and independent calls | Coalescing verification; effects/policy/layers/independent profiles | `dialcache-coalescing`, `dialcache-liveness`: leader/follower results, remaining budget, independent source/error/read identities and publication order | Bounded overlap and operation identities; no fairness proof |
| Runtime policy | Runtime-policy verification; policy/runtime-boundaries/scope profiles | `dialcache-config-ramp`: sparse leaves, null versus omission, defaults, invalid policy, cohort equality and captured snapshots | Native malformed host objects and static API validation remain separate |
| Source/read budgets | Coalescing verification; effects/source-budgets/independent profiles | `dialcache-liveness`, `dialcache-redis-read-deadline`: time begins at actual work, separate budgets, exact deadlines, cancellation and late settlement | Selected integer budgets; precise native timer boundaries have binding tests |
| Cache failures | Core/recovery verification; effects/local-failure/recovery-read profiles | `dialcache-redis`, `dialcache-local`: original source outcomes, failure-specific refill/publication authority and independent probes | Native storage/clock seams inject local faults; not arbitrary heap corruption |
| Tracked invalidation | Tracked verification; effects/layers/recovery-read profiles | `dialcache-invalidation`, `redis-payload`, real/cluster tests: acquired snapshots, both observed-fence checks, marker existence/TTL and delayed writes | Atomic primary snapshots and watermark durability are assumptions |
| Stale recovery | Stale-recovery verification; recovery/recovery-read/independent profiles | `dialcache-stale-on-error`, `dialcache-stale-recovery-policy`: F/M boundaries, original errors, lazy decode, retained bytes, closed scopes and no shared publication | Recovery-read selected-shadow mode admits only stale seeds and failed sources |
| Shadow admission and fills | Shadow verification; shadow/admission/shadow-layers profiles | `dialcache-shadow-validation`, `dialcache-shadow-confirmation`: C0/source order, C1 identity, captured fill policy, mixed capacity, timeout ownership and public publication probes | Bounded keys/jobs/instances; not every remote physical-expiry race |
| Diagnostics | Effects/policy/shadow and composition profiles | `dialcache-metrics`, `shadow-log-json`: actual category/count, age/duration, source identity, future offset and warning eligibility | Exporter registration and complete backend schemas remain native |

File stems above refer to TypeScript tests under `test/`. The Go case ledger and
native inventory name exact corresponding Go symbols and tests. Review those
precise references before claiming that a broad test file establishes a clause.

## New composition boundaries

Six focused profiles close gaps without turning one model into the whole cache:

| Profile | Distinguishing public consequence |
| --- | --- |
| `recovery-read` | A held read crosses freshness; logical recovery survives native expiry; compressed recovery memoizes without shared publication; value work preserves observed marker lifetime; recovered absence starts no selected shadow source |
| `local-failure` | A read fault suppresses later local publication even after the fault clears; a write fault leaves caller/request results intact; a separate request distinguishes reuse from a new source |
| `runtime-boundaries` | Omitted/default/invalid leaves and exact cohort boundaries affect actual invocation, cache and diagnostic outcomes |
| `shadow-layers` | Dark callers publish to request/local storage independently of diagnostic fills; deduplicated jobs retain independent caller sources; served/dark work shares per-instance capacity with different source ownership |
| `local-clock` | Fractional insertion and lookup observations expose local expiry at the common whole-millisecond grid, including instances constructed at different fractional times |
| `source-budgets` | Held policy time does not spend the source budget; default, finite and unbounded calls, followers and disabled/key-error paths preserve their distinct deadlines |

Each exportable regression invokes actual public model actions. Explicit
`input: { name, choice }` survives Quint test export and drives both ports.
Expected state supplies assertions only. Native local-failure and local-clock
seams control the environment while exercising real cache behavior; they do not
add production fault APIs or redefine the model's expected outcome.

The common driver holds source, read, decode, dump and write effects where the
profile requires them. Actual effect counters and public probes establish reuse
or publication. Source-ownership monitors independently associate writes with
their actual accepted source callback. Prefix witness classifiers require both
the command sequence and its distinguishing public observations; negative
controls remove those consequences and must lose witness credit.

## Wire transforms

The wire models are deterministic transforms with finite input domains, not
concurrency profiles. Their `vectorExport` entries in `execution.json` identify
the generator, committed artifact, sources and complete required row count.

| Transform | Quint authority | Complementary evidence and limits |
| --- | --- | --- |
| Key identity, argument order and cohorts | `dialcache-key-protocol.qnt`, `wire-text.qnt`, `cohort-boundaries.qnt` | Real key APIs replay escaped identities, UTF-16 ordering, strict invalid inputs and integer hash numerators. Full IEEE754 shortest decimal formatting and arbitrary bigint widths remain fixed/native boundaries |
| Frames, text and duration validation | `dialcache-frame-vectors.qnt`, `wire-text.qnt` | Real writer/decoder APIs check bytes, malformed UTF-8, timestamp domain, classification order and safe duration bounds. Frame decoding and core timestamp acceptance are distinct stages |
| Invalidation | `dialcache-invalidation-transition.qnt` | Real Redis/Valkey/Cluster protocol execution checks cutoff, type/content, TTL/persistence and rejection before mutation. Server elapsed time is measured rather than replaced by fixed tolerance |
| Envelope and compression selection | `dialcache-envelope-vectors.qnt` | Marker escaping, fallback, byte thresholds, cap boundaries and strict shrink use native codec results/sizes as independently verified inputs. Exact zstd output bytes and arbitrary stream behavior are not modeled |

[PROTOCOL.md](./PROTOCOL.md) records representation rules and native resource
boundaries. Fixed protocol and invalidation vectors remain required; generated
artifacts supplement them and carry source provenance. Their exporters translate
Quint outputs instead of recomputing expectations with the implementation.

## Native obligations

[FEATURE-COVERAGE.md](./FEATURE-COVERAGE.md) and its JSON inventory retain exact
API, execution, value-domain, exporter and adapter tests. Examples include
registration snapshots, borrowed object references, Promise/thenable versus
Go context/error bindings, custom clocks, precise source/read/shadow timing,
Prometheus collector ownership, cancellation forwarding and complete-frame
Redis command dispatch. These are explicit adaptations and assumptions, not
additional portable case counts.

The local-clock profile now models one previously native timing boundary. It
does not imply that every native clock test is modeled. Likewise, injected
small compression caps exercise wrapper decisions without allocating the real
512 MiB ceiling; native resources and stream quirks still need their own tests.

## Evidence and measurement

Run the commands in [README.md](./README.md#generating-and-replaying-behavior)
and inspect `node formal/check-semantic-coverage.mjs` for current accounting.
Checking a model, reaching a witness and replaying its observations are separate
requirements. Both implementation completion gates derive the exact sampled
corpus, exported regressions and wire inventory from metadata.

Regular CI explicitly measures `src/**/*.ts`, retaining the existing root-barrel
exclusion and unchanged 95% line/function/statement and 90% branch thresholds.
Every shipped implementation module remains in scope. Imported formal tooling
has separate parser, provenance, model, replay and mutation checks; importing a
checker directly must not silently change the library coverage denominator.
The full unit and production-coverage gate passed with this explicit scope.

Earlier Vitest/V8 code-coverage measurements predate this expansion. They remain
historical observations of their recorded source/instrumentation snapshot:

| Historical cohort | Library lines | Library branches | Main engine lines | Main engine branches |
| --- | --- | --- | --- | --- |
| 660 ordinary unit tests | 97.96% | 97.06% | 96.16% | 95.35% |
| 4,000 configured generated traces | 70.71% | 71.62% | 83.94% | 84.59% |
| 229 scenarios, 102 protocol cases and four audit checks | 72.54% | 72.50% | 82.72% | 79.21% |
| Generated plus portable, 4,335 positive tests | 75.00% | 77.49% | 85.34% | 85.33% |

These percentages are not current-suite coverage, assertion strength or a
percentage of behavior formalized. A new schedule can strengthen ownership
checks while revisiting the same branch. Recompute with identical source and
instrumentation maps before comparing another run. Keep positive behavioral
execution separate from parser, classifier and deliberately broken-driver
controls. [SEMANTIC-COVERAGE.md](./SEMANTIC-COVERAGE.md) explains the independent
mutation measurements and their retained historical reports.

When behavior disagrees, review the intended contract, change Quint with an
independent regression, replay it in both ports, and update explanatory docs and
case mappings. A formal model is authoritative only within its declared scope;
its notation does not remove the need to review the actual consequence.
