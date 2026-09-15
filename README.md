<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-wordmark.png" />
    <source media="(prefers-color-scheme: light)" srcset="assets/logo-wordmark-light.png" />
    <img src="assets/logo-wordmark.png" alt="GCache" width="520" />
  </picture>
</p>

<p align="center">
  <a href="https://badge.fury.io/py/gcache"><img src="https://badge.fury.io/py/gcache.svg" alt="PyPI version" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="https://www.python.org/downloads/"><img src="https://img.shields.io/badge/python-3.10+-blue.svg" alt="Python 3.10+" /></a>
  <a href="https://codecov.io/gh/rungalileo/gcache"><img src="https://codecov.io/gh/rungalileo/gcache/graph/badge.svg" alt="codecov" /></a>
</p>

A caching library built for moving fast without breaking things. GCache lets you rapidly add new caching use cases while maintaining structure and runtime control guardrails—so you can ramp up gradually, kill a bad cache instantly, and have full observability into what's cached across your system.

## Why GCache?

Most caching libraries give you a key-value store and leave the rest to you. GCache takes a different approach:

- **Opinionated structure** — Enforced key format (`key_type` + ID + use case, e.g., `user_id:123`) keeps your caching organized and enables the features below
- **Runtime controls** — Enable/disable caching per request, ramp from 0-100% per use case, adjust configuration without redeploying
- **Targeted invalidation** — Invalidate all cache entries for a `key_type` + ID (e.g., all caches for a specific user, org, or project) with one call
- **Full observability** — Prometheus metrics out of the box, broken down by use case and `key_type`

## Installation

```bash
pip install gcache
```

Requires Python 3.10+

## Quick Start

```python
from gcache import GCache, GCacheConfig, GCacheKeyConfig, CacheLayer

# Create the cache instance (singleton)
gcache = GCache(GCacheConfig())

# Decorate your function
@gcache.cached(
    key_type="user_id",
    id_arg="user_id",
    use_case="GetUser",
    default_config=GCacheKeyConfig(
        ttl_sec={CacheLayer.LOCAL: 60, CacheLayer.REMOTE: 300},
        ramp={CacheLayer.LOCAL: 100, CacheLayer.REMOTE: 100},
    ),
)
async def get_user(user_id: str) -> dict:
    return await db.fetch_user(user_id)  # Your expensive operation

# Use it — caching only happens inside enable() blocks
with gcache.enable():
    user = await get_user("123")  # Cache key: urn:gcache:user_id:123#GetUser
```

That's it. The function works normally outside `enable()` blocks, and caches results inside them.

## How It Works

### Cache Layers

GCache uses a multi-layer read-through cache:

```
Request
   │
   ▼
┌─────────────────┐
│  LOCAL CACHE    │ ◄─── Hit? Return immediately
│  (in-memory)    │
└────────┬────────┘
         │ Miss
         ▼
┌─────────────────┐
│  REDIS CACHE    │ ◄─── Hit? Store in local, return
│  (distributed)  │
└────────┬────────┘
         │ Miss
         ▼
┌─────────────────┐
│  YOUR FUNCTION  │ ◄─── Execute, store in both caches, return
└─────────────────┘
```

Local cache is fast but per-instance. Redis is shared across your fleet. Use both for best performance, or just local if you don't need Redis.

### Key Format

GCache constructs structured cache keys in URN format:

```
urn:prefix:key_type:id?arg1=val1&arg2=val2#use_case
```

For example: `urn:gcache:user_id:123?page=1#GetUserPosts`

This structure is useful for:
- **Debugging** — Keys are human-readable when inspecting Redis
- **Grouping** — All caches for a `key_type:id` pair share a common prefix, making it easy to find related entries
- **Targeted invalidation** — The structure enables invalidating all entries for a specific `key_type` + ID

### Runtime Controls

Caching doesn't happen automatically—you control when it's active:

- **`enable()` context** — Caching only happens inside `with gcache.enable():` blocks. Outside of them, your function runs normally. This lets you disable caching during write operations to avoid stale reads.

- **`ramp` percentage** — Each cache layer has a ramp from 0-100%. At 50%, half the requests use the cache, half go straight to the source. Start at 0% when adding a new use case, then ramp up as you gain confidence.

- **Dynamic config** — The config provider runs on each request, so you can adjust TTLs or ramp percentages without redeploying.

### Why Explicit `enable()`?

GCache requires you to explicitly enable caching with `with gcache.enable():`. This is intentional.

Caching in write paths can cause subtle bugs—a stale read might get cached right before a write, leading to inconsistent data. By requiring explicit opt-in, GCache forces you to consciously decide where caching is safe:

```python
# Read path — caching is safe
with gcache.enable():
    user = await get_user(user_id)

# Write path — no caching, function runs normally
await update_user(user_id, new_data)
await gcache.ainvalidate("user_id", user_id)
```

This design prevents accidental caching in dangerous places.

## Runtime Configuration

For dynamic control, provide a config provider when creating GCache. This lets you adjust caching behavior without redeploying:

```python
from gcache import GCache, GCacheConfig, GCacheKeyConfig, GCacheKey, CacheLayer

async def config_provider(key: GCacheKey) -> GCacheKeyConfig | None:
    # Fetch from your config source: LaunchDarkly, database, config file, etc.
    config = await config_service.get_cache_config(key.use_case)

    if config is None:
        return None  # Fall back to default_config on the decorator

    return GCacheKeyConfig(
        ttl_sec={CacheLayer.LOCAL: config.local_ttl, CacheLayer.REMOTE: config.remote_ttl},
        ramp={CacheLayer.LOCAL: config.local_ramp, CacheLayer.REMOTE: config.remote_ramp},
    )

gcache = GCache(GCacheConfig(cache_config_provider=config_provider))
```

This enables:
- **Kill switches** — Set ramp to 0% to instantly disable a problematic cache
- **Gradual rollout** — Start at 10%, monitor metrics, increase to 100%
- **Per-use-case tuning** — Different TTLs and ramp percentages for different use cases

### ⚠️ Breaking: a tracked key's TTL is now capped at 4 hours

If a use case sets `invalidation_tracking=True` **and** a remote `ttl_sec` above
`WATERMARK_TTL_SECONDS` (4 hours), writes now raise `TrackedTTLExceedsWatermark` (also a
`ValueError`). This was previously accepted, and `GCacheKeyConfig` still types `ttl_sec` as a
plain `int` — the bound is a property of invalidation, not of the type.

**What you will see if you are affected.** `aput`/`put` raise. A `@cached` miss does *not* —
`CacheController` catches the write error, increments `gcache_error_counter`, and returns the
fallback value. So the caller keeps working and **the cache silently never populates**: the
symptom is a use case whose hit rate sits at zero with a rising `gcache_error_counter`, not an
outage. Check that counter, not your latency.

**Migration:** either lower `ttl_sec` to 4 hours or less, or turn off `invalidation_tracking`
for that key. An untracked key may use any TTL — it has no watermark to outlive.

**Why not just cap it silently:** a cap gives you a shorter TTL than you configured *and*
hides the misconfiguration from the read guards below, so it would surface nowhere.

**Reads are guarded too, in two ways**, because a write cap only binds entries this process
writes and the keyspace is shared:

- a tracked JSON entry whose envelope *declares* a lifetime over 4 hours is a miss
  (`gcache_miss_counter{reason="lifetime_exceeds_watermark"}`)
- a tracked entry of **either** framing that is *older* than 4 hours is a miss
  (`reason="age_exceeds_watermark"`). This is the one that covers legacy pickle entries,
  which carry no `expiresAtMs` for the first check to read. An entry can only reach that age
  if its TTL exceeded 4 hours, so a correctly configured key never triggers it.

**The invariant behind all of this:** invalidation marks entries stale by writing a watermark
that lives 4 hours. An entry outliving its watermark stops looking stale the moment the
watermark expires, and an invalidated value **resurrects** for the rest of its own TTL —
silently. Go has enforced both halves from the start (`maxEntryTTL` on write,
`ResultDistrusted` on read); Python previously enforced neither, so the two clients disagreed
about the same key.

### ⚠️ Breaking: `urn_prefix=""` now raises

`GCacheConfig(urn_prefix="")` raises `EmptyUrnPrefixNotSupported` (also a `ValueError`, so an
existing `except ValueError` around construction still catches it).

**If you pass it today, your keys are not what you think.** It used to be silently ignored, so
the previous prefix stayed in force — `"urn"` by default. The error tells you that; it does not
change the keys you were actually getting.

**Migration:** omit `urn_prefix` to keep the default `"urn"`, or pass a non-empty prefix. There
is no configuration that reproduces the old behaviour, because the old behaviour was "use the
previous value", not "use no prefix".

**Why rejected rather than made to work:** an empty prefix writes into an unnamespaced key
space that no namespaced deployment reads, so the cache never hits and nothing errors at write
time. The Go client refuses it at construction for the same reason.

That is a different problem from the encoding question below, which is an encoding
defect with a fix — align the two clients and every non-empty prefix interoperates. An empty
one still would not, because that divergence is structural. It is the one case that survives
the fix, which is why it gets an error instead of a caveat.

## The `@cached` Decorator

The decorator handles both sync and async functions automatically.

### Basic Usage

```python
@gcache.cached(
    key_type="user_id",           # What kind of entity is this?
    id_arg="user_id",             # Which argument contains the ID?
    use_case="GetUserProfile",    # Identifies this specific caching use case
)
async def get_user_profile(user_id: str) -> dict:
    ...
```

**Tip:** Always define `use_case` explicitly. It identifies the specific caching scenario (e.g., `GetUserProfile`, `ListOrgProjects`) and appears in cache keys, metrics, and logs. It defaults to `module.function_name`, but an explicit name ensures consistency if you refactor your code.

### Working with Complex Arguments

Options for mapping function arguments to cache keys.

#### `id_arg` (required)

Specifies which argument contains the entity ID for the cache key.

**String form** — use when the argument itself is the ID:
```python
id_arg="user_id"  # user_id argument is the ID
```

**Tuple form** — use when the ID needs to be extracted from an object:
```python
id_arg=("user", lambda u: u.id)  # Extract ID from User object
```

#### `arg_adapters`

Converts complex arguments to strings for the cache key. Only needed for non-primitive types.

```python
arg_adapters={
    "filters": lambda f: f.to_cache_key(),  # Complex object
    "page": str,                             # Simple conversion
}
```

#### `ignore_args`

Excludes arguments that don't affect the cached result.

```python
ignore_args=["db_session", "logger"]
```

#### Example

```python
@gcache.cached(
    key_type="user_id",
    id_arg=("user", lambda u: u.id),
    arg_adapters={"filters": lambda f: f.to_cache_key()},
    ignore_args=["db_session", "logger"],
)
async def search_user_posts(
    user: User,
    filters: SearchFilters,
    page: int,
    db_session: Session,
    logger: Logger,
) -> list[Post]:
    ...

# Cache key: urn:gcache:user_id:123?filters=active&page=2#SearchUserPosts
```

The `id_arg` becomes `:123`, `arg_adapters` produce `?filters=active&page=2`, and `ignore_args` are excluded.

### Sync Functions Work Too

```python
@gcache.cached(key_type="org_id", id_arg="org_id", use_case="GetOrgSettings")
def get_org_settings(org_id: str) -> dict:  # No async needed
    return db.query(...)
```

Under the hood, sync functions run through a thread pool to avoid blocking the event loop. This adds some overhead, so **prefer async functions when possible** for better performance.

### Sharing a Cache With Other Languages

By default a value is stored as a Python pickle, which only Python can read. `envelope=`
switches to a JSON framing the Go client also understands, so both can share one entry and
one invalidation:

```python
from gcache import Envelope, JsonSerializer

@gcache.cached(
    key_type="session_id",
    id_arg="session_id",
    use_case="session-identity",
    envelope=Envelope.JSON,
    serializer=JsonSerializer(),   # required: JSON carries a serialized payload
    track_for_invalidation=True,   # so another language's invalidation reaches this entry
)
async def get_session(session_id: str) -> dict:
    return await db.fetch(session_id)
```

Four constraints:

- **Only JSON-representable values.** The payload is a string on the wire, so the serializer
  has to be able to produce and restore one. `JsonSerializer` covers dicts, lists and
  scalars; anything else needs your own `Serializer`.
- **`serializer=` is the same trap.** Adding one to a live use case is undetectable in a
  pickle envelope: a pod on the older code hands the raw serialized payload back to its
  caller instead of the value, with nothing logged. The JSON case *is* caught — the reader
  knows it needs a serializer and treats the entry as a miss — but the pickle one cannot be.
  New `use_case` for that too.
- **Key components are interpolated raw, in both clients.** Neither Python nor Go
  percent-encodes, so a component containing `:`, `#`, `?`, `&` or `=` can collide with a
  differently-structured key that renders identically — `id="a#u2"` with `use_case="u"`
  renders the same as `id="a"` with `use_case="u2#u"`. Both clients agree, so this is a
  property of the key grammar rather than a divergence, but it means component values should
  not carry the grammar's own delimiters.
- **Never flip this on a live use case.** A rolling deploy runs both pod generations at
  once: an old pod (pickle, no serializer) treats a JSON entry as a miss and writes pickle
  over it, and a new pod refuses that pickle and writes JSON again. Each destroys the
  framing the other needs, so the key's hit rate sits near zero for the whole rollout.
  Migrate under a **new `use_case`** — the two generations then use different keys and never
  fight.

Reads sniff the framing they actually find rather than trusting `envelope=`, so a JSON key
reads a JSON entry whoever wrote it. The one exception is that a JSON key refuses to
unpickle: unpickling executes arbitrary code, and the reader cannot tell a migration
leftover from a payload injected by anyone with keyspace access.

Note that `track_for_invalidation=True` only reaches the Redis layer. `LocalCache` does not
consult watermarks, so an invalidation from another language does not clear a Python pod's
in-process copy until its local TTL expires — keep the local TTL short (or the local ramp at
0) for a use case shared across languages.

#### Reading and writing one key directly

`@cached` fits whenever the value is a pure function of a call's arguments. A shared cache
often is not: the key comes from data that is nobody's parameter, and the value is something
the caller already fetched. `aget`/`aput` (and their sync `get`/`put`) take a key you build:

```python
from gcache import Envelope, GCacheKey, JsonSerializer

def identity_key(project_id: str, session_id: str) -> GCacheKey:
    return GCacheKey(
        key_type="session_id",
        id=f"{project_id}:{session_id}",
        use_case="session-identity",
        envelope=Envelope.JSON,
        serializer=JsonSerializer(),
        invalidation_tracking=True,
    )

# Read. The fallback runs only on a miss, so the caller can reuse whatever it fetched --
# a plain get would make it read its source of truth twice.
async def resolve(project_id: str, session_id: str) -> dict:
    fetched: dict | None = None

    async def load() -> dict:
        nonlocal fetched
        fetched = await db.fetch_session(project_id, session_id)
        return fetched

    with gcache.enable():
        return await gcache.aget(identity_key(project_id, session_id), load)

# Write. For priming an entry ANOTHER process will read, when this one already has the
# value and does not want the read that would otherwise populate it.
with gcache.enable():
    await gcache.aput(identity_key(project_id, session_id), {"session_id": session_id})
```

Both honour `enable()` and the use case's ramp, exactly as the decorator does — a write
outside an `enable()` block, or for a use case ramped to 0, does nothing.

Four things to know:

- **`envelope` and `serializer` are not part of the key.** `key_type`, `id`, `args` and
  `use_case` are, so getting one of those wrong just means the two participants never see
  each other's entries. Getting the envelope wrong is worse: both then share one key with
  incompatible framing, each overwrites the other, and neither can read what it finds. Within
  one process the library now catches it — a direct key whose envelope contradicts a
  `@cached` declaration on the same `use_case` raises — but across languages it cannot.
- **`aput` raises on a cache-layer failure; `aget` does not.** `aput` matches `adelete` and
  `ainvalidate` in propagating, so a caller on a request path decides what to do with a Redis
  timeout rather than having "prime" silently read as best-effort. `aget` is the opposite and
  deliberately so: it catches `GCacheError`, logs, increments `gcache_error_counter` and reads
  through uncached, because a cache must not be able to fail a request. Plan error handling
  around both — a `try` that wraps only the read is wrapping the half that cannot raise.
- **A prime is sampled by the ramp, like a read.** `_should_cache` calls `random()` per
  invocation, per layer, so a use case at ramp 50 drops about half its primes and `aput`
  still returns normally. On a read that costs one uncached call; on a prime it throws away
  work already done and the entry another process waits for never appears. Ramp a shared
  use case to 100 or 0, not through the middle.
- **A prime inside an active invalidation window is lost silently — on the Redis layer.**
  The entry is written with `createdAtMs` below the watermark, so remote reads find it stale
  until the window closes and a read rewrites it. That is the invalidation doing its job, but
  `aput` still returns normally. Go behaves the same way. The **local** layer never reads
  watermarks, so a later `aget` in the same
  process returns the primed value regardless — keep the local ramp at 0 for a shared use
  case, as above.

#### Prefer a protobuf payload over a hand-written dict

`JsonSerializer` leaves the payload *schema* as something each language writes by hand, and
that is where cross-language caches actually break: not in the framing, which is tested, but
in a field one side renamed, retyped, or made optional. Review of the first shared use case
here turned up six such divergences, every one found by a person rather than a test.

`ProtoJsonSerializer` takes a generated protobuf message instead, so one `.proto` defines
the payload for every language:

```python
from gcache import Envelope, ProtoJsonSerializer
from libs.python.schemas.cache.proto import session_identity_pb2

@gcache.cached(
    key_type="session_id",
    id_arg="session_id",
    use_case="session-identity",
    envelope=Envelope.JSON,
    serializer=ProtoJsonSerializer(session_identity_pb2.SessionIdentity),
    track_for_invalidation=True,
)
async def get_session(session_id: str) -> session_identity_pb2.SessionIdentity: ...
```

Requires the extra: `pip install 'gcache[protobuf]'`. Importing gcache without it is fine;
only constructing `ProtoJsonSerializer` raises.

The Go counterpart is `go/protocodec.ProtoJSON` in this repo, and the two set the same
two non-default options — snake_case field names, and tolerating unknown fields so a rolling
deploy that adds a field does not make each pod generation reject the other's entries. Both
are enforced by tests on each side.

**Do not compare the two languages' bytes.** Go's protojson deliberately emits unstable
whitespace — it appends a random extra space after each comma, decided per binary build — and
Python's `MessageToJson` spaces differently again. This is harmless, because both sides parse
JSON, but it means a conformance test has to compare parsed values, never raw output.

## Redis Configuration

### No Redis (Local Only)

```python
gcache = GCache(GCacheConfig())
```

### With Redis

```python
from gcache import RedisConfig

gcache = GCache(
    GCacheConfig(
        redis_config=RedisConfig(
            host="redis.example.com",
            port=6379,
            password="secret",
        ),
    )
)
```

### Custom Redis Factory

For dynamic credentials, token refresh, or connection pooling:

```python
import threading
from redis.asyncio import Redis

def make_redis_factory():
    local = threading.local()

    def factory() -> Redis:
        if not hasattr(local, "client"):
            token = fetch_token_from_vault()
            local.client = Redis.from_url(f"redis://:{token}@redis:6379")
        return local.client

    return factory

gcache = GCache(
    GCacheConfig(
        redis_client_factory=make_redis_factory(),
    )
)
```

**Important:** Custom factories must use thread-local storage. Each thread needs its own client.

#### ⚠️ `decode_responses=True` is unsafe if any pickle value can be reached

Reachable two ways — `RedisConfig.redis_py_options` and a custom factory — and it is a
process-wide decision, because one `GCache` uses one client for **every** use case.

The option makes redis-py decode every reply as UTF-8. A pickle blob starts `0x80`, which is
not a valid UTF-8 start byte, so `client.get` raises `UnicodeDecodeError` **inside redis-py**,
before gcache sees the value. That error escapes the read path: `gcache_error_counter` moves,
the fallback re-runs, and the entry is **not** rewritten — so every read of every
`Envelope.PICKLE` use case in that process fails for its full TTL. It does not self-heal,
because a rewrite would fail identically on the next read.

**"All my use cases are `Envelope.JSON`" is not sufficient**, and an earlier version of this
section wrongly said it was. Reads **sniff** the framing rather than trusting the declaration
— that is exactly what makes a no-flag-day migration possible — so a JSON-declared key is
*expected* to meet legacy pickle values for as long as any remain in the keyspace. Those reads
fail at the client, before gcache sees a byte, and never heal.

So the real condition is stronger: turn it on only when **no pickle value can be reached on
that client at all** — every use case on it is `Envelope.JSON` *and* no pre-migration pickle
entries survive for those keys. In practice that means after a full TTL has elapsed since the
last pickle writer stopped.

gcache logs a warning once per `RedisCache`, on the first read of any kind through a text-mode
client — deliberately not gated on the key's declared envelope, since the declaration is the
thing that cannot be trusted here. It cannot fix the configuration for you.

This is new as of the envelope work. Before `decode()` accepted a `str`, the option broke
JSON reads too, so nobody could turn it on — making the JSON path work is what made the
pickle path reachable.

## Invalidation

When data changes, you need to invalidate the cache. GCache makes this easy with targeted invalidation.

### Basic Invalidation

```python
# Mark the function for invalidation tracking
@gcache.cached(
    key_type="user_id",
    id_arg="user_id",
    track_for_invalidation=True,  # Enable this
)
async def get_user(user_id: str) -> dict:
    ...

# When data changes, invalidate all cached entries for that key_type + ID
await gcache.ainvalidate(key_type="user_id", id="12345")

# Sync version
gcache.invalidate(key_type="user_id", id="12345")
```

This invalidates *all* cache entries for that `key_type` + ID—every use case, every argument combination.

### Handling Race Conditions

If a read happens right before a write, the stale data might get cached. Use a future buffer:

```python
await gcache.ainvalidate(
    key_type="user_id",
    id="12345",
    future_buffer_ms=5000,  # Also invalidate anything cached in the next 5 seconds
)
```

### A watermark outlives the kill switch

Ramping a use case to 0%, or leaving the `enable()` context, stops reads and writes but does
**not** clear watermarks — an invalidation written just before the switch survives in Redis
for the watermark key's own 4-hour TTL. Only `flushall()` or that TTL expiring removes it.

It is usually harmless: the watermark suppresses entries created at or before it, so each
affected entity costs one miss and then repopulates. `future_buffer_ms` is the case to know
about — a watermark set in the future also blocks write-back (`_exec_fallback` re-puts only
once the watermark is in the past), so those entities keep missing until the buffer elapses.

### Full Flush

For testing or emergencies:

```python
gcache.flushall()       # Sync
await gcache.aflushall()  # Async
```

## Metrics

GCache exports Prometheus metrics automatically:

Labels are listed in full per metric, because they are **not** uniform -- a query written
against the wrong label set returns nothing rather than erroring.

| Metric | Type | Labels |
|--------|------|--------|
| `gcache_request_counter` | Counter | `use_case`, `key_type`, `layer` |
| `gcache_miss_counter` | Counter | `use_case`, `key_type`, `layer`, `reason` |
| `gcache_disabled_counter` | Counter | `use_case`, `key_type`, `layer`, `reason` |
| `gcache_error_counter` | Counter | `use_case`, `key_type`, `layer`, `error`, `in_fallback` |
| `gcache_invalidation_counter` | Counter | `key_type`, `layer` |
| `gcache_get_timer` | Histogram | `use_case`, `key_type`, `layer` |
| `gcache_fallback_timer` | Histogram | `use_case`, `key_type`, `layer` |
| `gcache_serialization_timer` | Histogram | `use_case`, `key_type`, `layer`, `operation` |
| `gcache_size_histogram` | Histogram | `use_case`, `key_type`, `layer` |

`gcache_invalidation_counter` is the exception worth knowing -- it carries **no `use_case`**:
invalidation is keyed on
`(key_type, id)` and carries no use case, so it cannot be broken down or joined by
`use_case`. An earlier version of this section claimed "all metrics include `use_case` and
`key_type`", which was false for exactly that metric.

**`reason` values.**

`gcache_miss_counter`: empty for an ordinary miss, otherwise `undecodable`,
`json_without_serializer`, `lifetime_exceeds_watermark`, `envelope_expired`,
`age_exceeds_watermark`, `unloadable_payload`, `unreadable_watermark`,
`non_finite_watermark`.

`unreadable_watermark` self-heals -- a watermark that is not a number at all is deleted, so
the next read caches again. `non_finite_watermark` does not: `nan`/`inf` parse as numbers, so
they could be a format this client does not understand yet, and every entry for that
`(key_type, id)` stays suppressed until the watermark key's own 4-hour TTL expires.

`gcache_disabled_counter`: `ramped_down`, `context`, `server_down`, `missing_config`,
`config_error`.

You can add a prefix to avoid collisions:

```python
GCacheConfig(
    metrics_prefix="myapp_",  # Metrics become myapp_gcache_request_counter, etc.
)
```

## Error Handling

GCache is designed to fail open. If Redis is down or an error occurs:

1. The underlying function executes normally
2. The error is logged and counted in `gcache_error_counter`
3. Your request succeeds (just without caching)

This means a cache failure never breaks your application.

### ⚠️ Alerting change: two signals moved off `gcache_error_counter`

A **corrupt pickle** and a **serializer `load` failure** used to raise out of
`RedisCache.get`, which incremented `gcache_error_counter` and re-ran the fallback
*without* writing back — so the bad entry stayed for its whole TTL and failed every read.

A read that finds an entry it cannot use -- a corrupt pickle, a serializer `load`
failure -- used to raise `gcache_error_counter` and leave the entry in place for its
full TTL. It is now a miss that rewrites the entry, counted as
`gcache_miss_counter{reason="..."}`. **An operator alerting on `gcache_error_counter`
loses those two signals**; the equivalent alert is a non-empty `reason` on the miss
counter. Note this means every existing exact-match query on `gcache_miss_counter`
needs `reason=""` adding, or it will match nothing.

| `reason` | What was found |
|---|---|
| `undecodable` | The envelope itself could not be parsed (corrupt, or an unknown version) |
| `json_without_serializer` | A JSON entry on a key that declares no `Serializer` — typically a rolling deploy where new pods have started writing JSON |
| `envelope_expired` | Present in Redis but past the writer's own `expiresAtMs` (see the clock-skew requirement under interop) |
| `unloadable_payload` | The envelope parsed, but the `Serializer` could not load the payload — e.g. another language changed the payload schema |

A sustained nonzero rate on any of these means the entry is being rewritten on every read,
which costs a fallback each time even though the answers stay correct.

## Caching Strategy Guide

### When stale data is acceptable

Use both local and remote cache, rely on TTL:

```python
GCacheKeyConfig(
    ttl_sec={CacheLayer.LOCAL: 300, CacheLayer.REMOTE: 3600},
    ramp={CacheLayer.LOCAL: 100, CacheLayer.REMOTE: 100},
)
```

Good for: feature flags, configuration, rarely-changing data.

### When data must be fresh

Use remote cache only (local can't be invalidated across instances), with invalidation:

```python
# In config
GCacheKeyConfig(
    ttl_sec={CacheLayer.LOCAL: 0, CacheLayer.REMOTE: 3600},  # No local cache
    ramp={CacheLayer.LOCAL: 0, CacheLayer.REMOTE: 100},
)

# In your write path
async def update_user(user_id: str, data: dict):
    await db.update_user(user_id, data)
    await gcache.ainvalidate(key_type="user_id", id=user_id)
```

Good for: user profiles, permissions, anything that needs immediate consistency.

## Contributing

Contributions are welcome! The project uses:

- **pytest** for testing (`pytest tests/`)
- **ruff** for formatting and linting
- **mypy** for type checking
- **pre-commit** for automated checks

```bash
# Setup
poetry install

# Run tests
pytest tests/

# Run all checks
pre-commit run --all-files
```

## License

MIT License — see [LICENSE](LICENSE) for details.
