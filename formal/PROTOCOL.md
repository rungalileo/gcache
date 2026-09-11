# Portable keys, frames, envelopes and invalidation

These rules supplement the [wire protocol reference](../docs/redis.md#advanced-wire-protocol)
and the W01–W09 obligations in [CONTRACTS.md](./CONTRACTS.md). They define
interoperability behavior independently of a host language's string or Redis API.
Quint primitive models define the selected transforms; their generators export
expected outputs into shared artifacts. Fixed vectors supplement those domains.
Passing the finite examples does not replace implementing the stated rules.

## Authority and generated artifacts

`execution.json` schedules each primitive model's independent properties,
regressions and `vectorExport`. That entry records the generator, artifact,
complete case count and source files. `generate-traces.sh` checks the committed
artifact against fresh Quint output. An intentional model change uses its
`generate-*-vectors.mjs --write` command, followed by review and `--check`.
Do not hand-edit the expected output or compute it with production code.

| Model and artifact | Defined behavior | Explicit boundary |
| --- | --- | --- |
| `dialcache-key-protocol.qnt` → `quint-key-vectors.json` | Component validation/escaping, tracked tags, ordered arguments, UTF-16 name order, integer normalization, FNV-1a numerators and strict cohort admission | Finite strings and signed integer magnitudes; full IEEE754 shortest formatting and arbitrary bigint widths remain fixed/native evidence |
| `dialcache-frame-vectors.qnt` → `quint-frame-vectors.json` | Complete version-1 bytes, text conversion, tracked/untracked classification order, writer timestamp validation and duration rounding | Finite byte/text/numeric inputs; core freshness and recovery are separate behavioral stages |
| `dialcache-invalidation-transition.qnt` → `quint-invalidation-vectors.json` | Decimal validation before mutation, monotonic cutoff, type repair and exact retention/persistence | Redis supplies atomic script execution and measured physical time |
| `dialcache-envelope-vectors.qnt` → `quint-envelope-vectors.json` | Marker escaping, decode fallback, UTF-8 byte thresholds, caps and strict smaller-representation choice | Decoder results and native encoder lengths are verified environment inputs; zstd itself is not implemented in Quint |

Exporters only translate representation: model byte lists become hex, UTF-16
units/scalars become JSON strings, and tagged observations become vector fields.
The expected key, bytes, classification, cutoff, TTL or wrapper decision comes
from Quint. Native readers exercise the real APIs and compare their observations.
Provenance hashes reject changed models, libraries or exporters until the artifact
is regenerated and reviewed. Completeness checks reject missing/duplicate rows.

These additions are an expansion of the fixed `protocol-vectors.json` schema 3
and `invalidation-vectors.json` schema 2 corpora, which remain required. Current
counts come from the execution manifest and semantic checker; vector row totals
are not distinct behavioral obligations. [VALIDATION.md](./VALIDATION.md) explains
how to produce current reports and retain their source/corpus identity.


## Text payload domain

A frame's text payload, and the decompressed bytes of a `0x01` envelope, can
contain any byte sequence. Decode them as UTF-8 with U+FFFD replacement for each
maximal ill-formed subpart. Malformed UTF-8 does **not** itself produce a cache
miss or a payload-encoding error. The resulting string still passes through the
configured serializer, which may independently reject it. The unknown frame
encoding tag remains an error subject to the existing frame/fence precedence.

Use the [UTF-8 decoder](https://encoding.spec.whatwg.org/#utf-8-decoder) with
replacement error handling and **without BOM removal**. This matches the
existing TypeScript behavior. Preserve U+FEFF, Unicode noncharacters, embedded
NUL, and normalization distinctions. Do not use a fatal decoder, replace every
byte of an incomplete valid prefix separately, or merge adjacent invalid leads
into one replacement.

An equivalent byte-consumption rule is:

1. Emit ASCII directly. A leading byte in `C2..DF`, `E0..EF`, or `F0..F4`
   starts a sequence of two, three, or four bytes. Any other leading byte emits
   U+FFFD and consumes exactly that byte.
2. Continuations are `80..BF`, except the first continuation after `E0` must be
   `A0..BF`, after `ED` must be `80..9F`, after `F0` must be `90..BF`, and after
   `F4` must be `80..8F`.
3. For a complete sequence, emit its scalar. At an invalid continuation or end
   of input, emit one U+FFFD for the lead plus its accepted continuation prefix.
   Reprocess an invalid continuation as the next leading byte.

Representative outcomes are fixed by both direct-frame and compressed-text
vectors:

| Bytes | Decoded code points |
| --- | --- |
| `22 FF 22` | U+0022 U+FFFD U+0022 |
| `E2 82` | U+FFFD |
| `E2 82 41` | U+FFFD U+0041 |
| `ED A0 80` | U+FFFD U+FFFD U+FFFD |
| `F4 90 80 80` | Four U+FFFD code points |
| `EF BB BF 61` | U+FEFF U+0061 |

Binary frame payloads and decompressed `0x02` envelopes retain their exact
bytes, including bytes that are invalid UTF-8. Text decoding occurs only at a
text boundary. Invalid zstd data retains the original marked bytes with the
existing `fallback_raw` outcome; replacement text decoding applies only after
successful decompression.

## Input strings and key escaping

Text writers encode Unicode scalars as UTF-8 without normalization or a BOM
prefix. A binding exposing UTF-16 code units combines valid surrogate pairs and
replaces each unpaired surrogate with U+FFFD before encoding a **payload**.
The frame vectors include both unpaired-surrogate cases. Scalar-only host
strings can perform this conversion at their fixture/input boundary.

Key escaping has a different contract: unpaired surrogates are rejected, so a
host must not silently substitute U+FFFD and construct another key. A binding
whose string type excludes unpaired surrogates may reject them while decoding
fixture input. Valid scalar strings follow the existing UTF-8 percent-escaping
and UTF-16 ordering rules. The invalid-key vectors include these rejection
cases separately from payload conversion.

## Key normalization and rollout

Logical identity includes namespace, key type, entity ID, use case and ordered
argument pairs. Tracked variants share the entity watermark/hash tag while
value keys retain operation/argument dimensions and the frame-version suffix.
Key construction preserves supplied ordered pairs, including duplicate argument
names. The separate record-normalization helper omits undefined entries and
sorts names lexicographically by UTF-16 code units; it preserves value association.
These are different input contracts.

Scalar identity uses the documented JavaScript-compatible spelling for strings,
null, booleans, numbers and integers. The Quint numeric normalization domain
covers signed safe integers and bounded signed integer magnitudes through the
signed 64-bit range. Its decimal-digit rules preserve those magnitudes exactly.
It does not establish arbitrary bigint widths or the complete IEEE754 shortest
round-trip formatting algorithm, including fractions, exponent thresholds,
negative zero, NaN and infinities. Fixed vectors and native tests retain these
binding obligations explicitly.

Rollout hashes the logical key plus the layer/shadow discriminator with FNV-1a
32-bit arithmetic over UTF-16 units. The sample is `hash / 2^32 * 100`, and the
cohort admits exactly when the sample is strictly less than the ramp. Quint
computes integer hash numerators; drivers translate that numerator to the public
number representation. Below/equal/above tests distinguish the strict boundary
without using the production hash as the expected-value oracle.

## Envelope selection and codec environment

Raw binary data beginning with `00`, `01` or `02` receives one leading `00`
escape. Reading removes exactly one escape only for a prefix the writer can
produce; an escaped compressed marker remains literal bytes. Successful `01`
decoding returns text with the UTF-8 rule above; `02` returns exact binary bytes.
Unknown markers pass through. Failed compressed decoding preserves the original
marked bytes with `fallback_raw`.

Read compatibility is independent of the policy for new writes. The reader has
no compression-enable parameter. The envelope model states this independence;
behavioral recovery/read histories also exercise already-compressed entries
through instances configured not to compress new writes.

Write selection measures UTF-8 bytes for text and escaped bytes for the raw
stored alternative. Threshold comparison precedes the output-size cap. A
compressed representation wins only when its native encoded length plus one
marker byte is strictly smaller than the escaped raw representation. Equality
keeps the raw representation. Text and binary retain their original logical type.

The envelope model takes each native encoder's level-3 output length and each
fixed decoder fixture's result as explicit environmental inputs. Both native
runners independently verify those inputs using their actual codecs before
checking the real wrapper. TypeScript and Go may choose different valid
representations because their encoders produce different lengths; compressed
bytes and compression outcome labels are therefore not universally identical.
The preserved logical bytes/type and the selection rule are portable.

The generated decoder domain includes fixed raw-block frames with valid,
malformed, incomplete, BOM and supplementary text bytes, plus selected invalid
or truncated headers. It does not cover arbitrary zstd windows, dictionaries,
trailers or concatenated streams. Native tests retain those decoder/resource
boundaries. Small per-call limits exercise before/exact/after cap decisions;
they do not allocate or prove enforcement of the production 512 MiB resource
ceiling under every runtime condition.

## Invalidation vector schema 2

Both fixed `invalidation-vectors.json` and generated `quint-invalidation-vectors.json`
contain a `vectors` array; the latter additionally records model/source provenance. Each item supplies a
unique `name`, `existing`, raw decimal argument text `futureBufferMs` and
`invalidatedAtMs`, and `expected` with optional `error` and required `state`.
Both `existing` and `expected.state` use this tagged state vocabulary:

| `kind` | Required content | `ttlMs` |
| --- | --- | --- |
| `absent` | No content fields | `-2` |
| `string` | `value`: exact string | `-1` for persistent, or positive finite TTL |
| `list` | `values`: nonempty ordered array of exact strings | `-1` for persistent, or positive finite TTL |

On success, the transition returns numeric `1` and produces the expected
string watermark and retention under the [invalidation rules](../docs/invalidation.md#watermark-lifetime).
With `error: true`, it must reject before any mutation and preserve the entire
original state: absence, type, content, list ordering, persistence, and remaining
TTL. Malformed strings and unrelated lists must remain unrepaired after invalid
arguments. Validation applies before the successful-transition repair rules.

Rejected argument classes are crossed with absence, valid/malformed strings and
ordered lists; finite and persistent states are separate inputs. Generated
transitions additionally check the declared decimal grammar, safe sum bounds,
canonical output, exact retention floors and wrong-type repair. Adapters must inspect type before reading content when
replaying these vectors. An unconditional `GET` cannot observe preserved lists.

TTLs describe the logical transition. Real-server replay may subtract only the
server time measured around atomic fixture setup, transition, and observation.
Persistence (`-1`) and absence (`-2`) remain exact; no fixed network tolerance
is permitted. Drivers must reject unsupported schema versions. Version 2
replaces version 1's string-only `expected.watermark`/`expected.ttlMs` fields
with `expected.state`; it is intentionally incompatible.
