# DialCache behavioral specification

Specification revision **0.1.0 (experimental)**. The repository commit identifies
the exact Quint definitions, profile definitions, and evidence used in a
conformance report. **Quint is the source of truth for portable behavior.**
The models registered in [`execution.json`](./execution.json) define transitions
and independently checked properties; this document explains their contracts,
assumptions, and encoding boundaries. [`CONTRACTS.md`](./CONTRACTS.md)
assigns stable obligation IDs and indexes its evidence. [`PROTOCOL.md`](./PROTOCOL.md)
explains wire representation and finite/native boundaries. Scheduled Quint
primitive models compute generated wire expectations; fixed vectors and
Redis/key documentation provide complementary examples and explanation. [`BEHAVIOR.md`](./BEHAVIOR.md)
and [`CONFORMANCE.md`](./CONFORMANCE.md) define controlled execution profiles.

## Definition ownership and executable connections

Shared transition judgments live in [cache-rules.qnt](./cache-rules.qnt): fresh
and recovery age, initial stale classification, insertion expiry and its clock
grid, source deadlines, and strict watermark acceptance. Profiles supply the
captured policy and appropriate clock; they import these definitions instead of
restating the comparison. Wire validity, physical retention and policy validation
remain separate responsibilities.

[cache-contract.qnt](./cache-contract.qnt) defines acquired recovery snapshots
and source executions. A snapshot records its owner, modeled payload/value identity,
timestamp and captured maximum age. A source records its owner, start and budget.
Later environment changes do not rewrite either acquired record.

The connection models execute the actual conformance profile and project its
events into these records. They check retained snapshot identity, source timing,
caller ownership and permitted acceptance for the named scope:

| Profile | Checked connection |
| --- | --- |
| recovery-read | [Acquired payload and recovery return](./dialcache-recovery-connection.qnt) |
| recovery | [Retained flight snapshot and recovery](./dialcache-legacy-recovery-connection.qnt) |
| independent | [Per-caller snapshots and source deadlines](./dialcache-independent-connection.qnt) |
| effects | [Source start and accepted publication timing](./dialcache-effects-connection.qnt) |
| source-budgets | [Captured source origin, budget and follower ownership](./dialcache-source-connection.qnt) |

Properties have different roles. The boundary assertions in
[dialcache-rule-checks.qnt](./dialcache-rule-checks.qnt) state inequalities
directly to challenge the shared predicates. Selected receipt invariants, such
as recovery age and local-hit expiry, also compare independently retained facts.
Connection and composition properties may reuse canonical predicates through
`cache-contract.qnt`; they check capture, ownership and history against those
definitions, rather than independently validating each predicate's meaning.
Compiling model mutations challenge the particular rule or connection property
named in the catalog. Connections establish only their listed obligations under
each profile's bounds; other contracts retain focused models and replay
evidence. Full-system refinement and fairness are not claimed.

## Meaning of conformance

An implementation conforms to a declared profile when, for every admissible
environment history in that profile, its observable history is permitted by the
specified transitions and obligations. Interoperability additionally requires
the declared wire transformations and invalidation transitions. Passing a finite
corpus is evidence for that claim, not a proof of this universal condition.

Conceptually, a transition is a relation, not necessarily a function:

```text
T : (State, Input) -> set of (State, Effects)
```

The relation permits external scheduling and the races stated below. A binding
may choose idiomatic APIs, executors, and storage structures. It may not change
caller results, publication authority, scope ownership, or required ordering
within its declared profile. A test schedule may select one permitted order;
that selection is not a universal ordering requirement between unrelated calls.

The models have explicit finite bounds; they do not define every native API or
unbounded wire input. Scheduled primitive models define selected deterministic
wire transforms; fixed vectors and native tests retain the remaining boundaries.
For a portable behavior change, update Quint first, retain an independent
property and a consequential witness or exported public-action regression,
then replay the same histories in
TypeScript and Go. Prose and implementation must follow that reviewed contract.
A discovered disagreement is resolved explicitly in Quint with a distinguishing
regression; existing implementation behavior is evidence to investigate, not an
alternative oracle. Case-ledger gaps remain visible until their behavior has
been modeled and checked.

## State and environmental inputs

The abstract state consists of the following independently owned records:

| State | Owner and contents |
| --- | --- |
| Contexts | Per cache instance: enabled flag, outer scope identity, open/closed lifetime, request memo, and registered request flights |
| Local entries | Per cache instance: key, value (including absence), insertion-time expiry, and LRU order |
| Process flights | Per cache instance and logical key: registered execution and its followers |
| Executions | Invocation's accepted policy, participating layers, acquired frame/fence, source/error identity, deadlines, and publication authority |
| Remote environment | Shared value frames, physical expiry, and entity invalidation watermarks |
| Shadow jobs | Per cache instance: admitted key, captured policy, deadline, retained C0, and owned unfinished effects |

Inputs are logical invocation/scope/maintenance operations, policy replies,
atomic remote observations, external source/codec/write/comparator outcomes,
wall-clock observations, elapsed time, and timer delivery. A source's rejection
is distinct from a cache-plumbing failure. Miss is a tagged state, never a
particular value such as null, false, zero, empty text, or absence.

Effects include public values or logical errors, source and adapter invocations,
value writes, invalidation results, cancellation requests, and selected public
diagnostics. Private state is not an implementation observation. A later public
probe must witness reuse, expiration, or fencing; a write acknowledgement alone
does not establish readability.

## Admission, policy, and traversal

1. **Invocation admission (C01–C04).** Without a live enabled context, invoke the
   source directly: no key construction, policy resolution, cache traversal,
   sharing, or DialCache source deadline. Nested enable/disable changes the
   nested enabled flag and preserves a live outer memo holder. Enabling without
   a live holder creates a new outer scope. Closing the
   outer scope clears its memo and prevents late memo publication. Detached
   calls using that closed context pass through. An invocation admitted while
   enabled that loses its scope while awaiting policy still uses its enabled
   source deadline, but does not cache.
2. **Policy snapshot (C16–C23).** Resolve once per enabled invocation. Each
   omitted runtime leaf inherits the operation leaf; an omitted operation
   leaf uses the library default. A whole-provider null/absent reply inherits
   the operation policy. An explicitly null leaf is an invalid supplied value,
   not omission. Capture the resulting policy for this execution; later
   updates neither rewrite existing entry expiry nor change accepted work.
3. **Request layer (C05–C07, C12, C18–C19).** If request memoization participates,
   join/register the request flight before memo lookup when sharing is enabled.
   An existing leader wins over a newer independently published memo value.
   Otherwise return a present memo before lower traversal. A disabled request policy bypasses
   the memo without deleting it. Different outer scopes never share their
   request memo, but their misses may join the same process execution.
4. **Shared layers (C05, C08–C15).** When a shared serving layer participates,
   join/register a process flight before the first such layer. Otherwise do
   not create a process flight. Traverse local before remote; a hit stops
   lower traversal. A local hit promotes LRU order without renewing expiry.
   Coalescing disabled means independent traversal/source/publication, while
   already settled caches remain usable. Independent publication is ordered
   by actual writes, not invocation order.

| Setting | Library default / invalid-runtime consequence |
| --- | --- |
| Request memoization | Off; invalid flag bypasses caching for the invocation |
| Coalescing | On; invalid flag bypasses caching for the invocation |
| Local/remote TTL | Omitted disables the layer; valid seconds are safe integers in [1, 31,536,000]; invalid TTL disables only that layer |
| Serving ramp | A configured valid TTL implies 100 unless a ramp is supplied; finite [0, 100], admission is sample strictly less than ramp; invalid ramp disables only that layer |
| Recovery | Off; zero disables inheritance; a positive maximum age must be a safe integer greater than remote TTL and at most 31,536,000 seconds; invalid optional age disables recovery |
| Shadow | Off; valid independent ramp, outcome hook, and capacity are required; invalid optional policy preserves ordinary serving |
| Mismatch logging | Off; malformed logging flag disables warnings |
| Read deadline | Runtime -> operation -> instance -> 50 ms; positive safe integer at most 2,147,483,647 ms; invalid runtime budget bypasses caching |
| Source deadline | Operation budget, otherwise 60,000 ms; explicit unbounded is allowed; finite budget has the same integer domain as read deadlines |
| Local capacity / shadow capacity | 10,000 / 1 per instance; zero local capacity preserves eligible sharing |

Invalid policy container shapes and provider/key failures take the uncached
enabled source path (C20/C27). Statically invalid operation/instance setup may
be rejected at the binding's documented construction boundary; accepting a
runtime input and then bypassing caching is a separate contract.

## Remote acquisition and publication

A tracked read atomically acquires value and watermark from an authoritative
primary. Its frame may pass the fence only if `createdAtMs > observedWatermarkMs`;
a missing marker is zero. Decoder classification order and malformed markers
follow W04/W09. Core accepts timestamps only in the safe integer domain, rejects
future frames, and accepts fresh age exactly when `0 <= age < remoteTTL` at the
observation after the read settles, before fresh decoding. An acquired fresh
value is not age-rechecked after asynchronous decoding. Physical expiry belongs
to the remote environment and is not
extended by a reader's current policy (C22/C33).

The source path and publication consequences are:

| Acquired path | Source success consequences (C27–C35) |
| --- | --- |
| Local only, remote unavailable/disabled, or remote ramp excluded the key | Eligible local publication remains allowed, including for a tracked key |
| Successful untracked remote miss | Prepare/write remotely and populate participating local/request layers as permitted by fail-open execution |
| Successful tracked remote miss | Conditional remote publication; suppress direct local publication; a later validated remote hit may warm local |
| Remote read error/deadline | No remote refill; untracked local publication remains eligible; tracked read failure suppresses direct local publication |
| Fresh payload decoding fails | Fall through to source; the successful remote read can still authorize refill |
| Source fails or expires | No shared publication; attempt only eligible retained recovery |

When a tracked semantic miss supplies a valid observed fence, conditional
publication uses that **same fence** twice: wall time must clear it before
preparation, and the final frame stamp must clear it after preparation before
dispatch. A frame returned by the adapter does not supply this miss metadata;
an age miss or fresh-decode failure does not synthesize a fence or reread Redis.
A value write is one native SET of the
complete version-1 frame; it does not mutate or extend the watermark. The final
writer stamp starts frame age. A dark fill's authority comes from the acquired
semantic miss, any supplied fence, and live job/source acceptance. It is a normal
SET, not a compare-and-set against current remote absence, and may overwrite an
intervening refresh. Tracked physical value retention is at most
one hour; this does not clamp logical freshness/recovery or local insertion TTL.

Key/config/cache/codec/write failures fail open without replacing the source
outcome. Failed local reads disable local publication for that execution.
Failure of an explicit maintenance mutation is surfaced. Observer failures
cannot change source, cache, or maintenance outcomes (C27–C30).

## Time, source acceptance, and progress

Wall time supplies frame/invalidation timestamps. Monotonic elapsed time governs
local expiry and deadlines. Local insertion and lookup use whole monotonic
milliseconds on one process grid; source/read/shadow budgets retain their
native elapsed precision. The local-clock profile exposes fractional environment
time to distinguish that expiry rule, while native tests cover precise timers
and custom-clock resolution. Wall rollback neither renews local TTL nor grants
more deadline time. For a finite source budget B and its actual invocation time
S, the deadline is `D = S + B`, independent of preceding policy/read/decode time.

Source settlement at elapsed time `t < D` may be accepted. At `t >= D` it is a
timeout even if the timer has not yet run. Deadline delivery removes registered
flight ownership; it does not require the raw source to stop. Followers inherit
the remaining leader budget and its outcome. A new execution may overlap an old
abandoned source; late settlement cannot publish or disturb the replacement.
Accepted results may finish serialization/publication after D (C23–C26).

The remote read has its own budget, starts when that read is invoked, and ends
on acquisition/error/deadline. Deadline requests cooperative cancellation once;
raw work can remain pending. A read deadline starts a fresh source budget and
does not authorize refill. Successful acquisition ends the read budget before
application-owned fresh decoding (C56/C59).

These are safety requirements. Eventual return additionally assumes executor
progress and finite completion/budgets for policy, decoding, accepted publication,
and any explicitly unbounded source. Arbitrary scheduler starvation is outside
the progress claim. Local expiry and elapsed deadlines do not prove real-time
service bounds under a stalled executor.

## Recovery, shadow work, and invalidation races

Recovery (C40–C46) retains bytes from the single initial read only when their age
is `F <= age < M`, with F the fresh TTL and M the exclusive maximum age. Invalid,
future, or fenced values are excluded. Source success skips retained decoding.
On eligible source failure, classifier precedence is operation -> instance ->
timeout-only default; denial/classifier failure preserves the original error.
Recheck `0 <= age < M` before and after asynchronous decode using captured
policy; rollback need not leave the retained value at or above F. A
recovered value may memoize in each still-open participating request scope but
never repopulates shared caches or admits served-hit shadow work, including
when the recovered value is absence.

Shadow work (C47–C54) is diagnostic. Served-hit jobs invoke a detached source
under disabled caching. Dark jobs reuse the caller source, overlap C0 with it,
never serve C0, and never delay the caller on dark reads/fills. Admission captures
policy and requires independent cohort, valid remote TTL, an outcome hook, and
per-instance capacity/deduplication. An unequal C0/source comparison requires
one C1 payload confirmation; changed/absent/fenced C1 is superseded. A present C0
is never repaired, even if undecodable. Only semantic misses permit conditional
fill. Expired work cannot start new phases; owned raw effects retain capacity
until they settle. A dark job waiting on an independently owned caller source
can release its slot at its own deadline while that unbounded caller continues;
a served job owns its detached raw source and retains capacity until settlement.
C0 retained while fresh is not reclassified after it ages. C1 confirms payload
identity even after freshness expiry or wall rollback; mismatch age clamps to
zero, while future-frame diagnostics retain their exact layer and offset.
Mismatch warnings require opt-in and a confirmed verdict.

Invalidation (C32–C39/W09) groups all tracked use-case/argument variants of the
same namespace/type/id. It validates arguments before any mutation, advances
the cutoff monotonically, and preserves/extends marker retention according to
the protocol. It does **not** revoke acquired frames, retained stale candidates,
local entries, request memo, or already registered work. A delayed old write can
complete after invalidation and still be rejected by subsequent tracked reads.
No global linearizable source/cache snapshot or synchronous cross-instance local
invalidation is promised.

## Assumptions, evidence, and claims

The environment supplies atomic primary tracked reads, stable retained bytes,
complete-frame native writes, clocks, and the controlled external outcomes.
Keys include every value dimension; same-key callers agree on serialization and
shared source selection. Reused values are not externally mutated. Watermark
availability must survive the required fencing lifetime; future buffers need a
bound on stale-write visibility and writer-clock lead. See E01–E05 for deployment
and binding responsibilities.

A report identifies specification revision, implementation revision, supported
profiles and vector groups, tool versions, seed, bounds, and exact corpus. It
must list unsupported features. [`profiles.json`](./profiles.json) registers the
profile formats and both implementations' declared coverage. Both ports must check every registered
profile, sampled history, exported regression and wire artifact, with separate real Redis/Valkey/Cluster
interoperability evidence. A claim requires those current-revision checks;
passing one profile does not imply the others.

The source-deadline verification model and the actual-effects history monitor
check selected C23/C25/C26 properties: source-relative duration and full budget,
strictly pre-deadline success acceptance, and publication requiring a preceding
accepted success. A second monitor in both drivers associates each dispatched
write with its actual source callback and invocation context, then requires
that exact source to have succeeded before its own deadline. It reads no
expected model state. Negative checks distinguish a late source, another
invocation's source, and valid publication after an accepted source's deadline.
This necessary condition does not prove payload provenance, refill fences, or
all publication authority; those have their own replay observations. Pending prefixes
are allowed and establish no eventual completion. This is a bounded checked
connection, not a full refinement proof for all verification and replay models.


The current case inventory gives every reviewed behavioral case a checked
Quint clause and Quint-driven implementation evidence. This is finite case
accounting; it does not prove every admissible history. Native clock/fault seams,
codec outcomes and encoded sizes, host numeric formatting, Redis atomicity and
resource ceilings retain explicit scope notes. [VALIDATION.md](./VALIDATION.md)
defines current report requirements and reproduction commands.
