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
switches to a JSON framing that the TypeScript and Go clients also understand, so all three
can share one entry and one invalidation:

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
- **TypeScript interop needs URL-safe key components and a matching prefix.** `gcache-ts`
  percent-encodes every key component and Python interpolates raw, so a `use_case` like
  `SessionService::identity` renders as `SessionService%3A%3Aidentity` there and the two
  compute different keys — zero sharing, no error. Until the encoding is unified, keep key
  components URL-safe. Go and Python agree today.
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

Three things to know:

- **`envelope` and `serializer` are not part of the key.** `key_type`, `id`, `args` and
  `use_case` are, so getting one of those wrong just means the two participants never see
  each other's entries. Getting the envelope wrong is worse: both then share one key with
  incompatible framing, each overwrites the other, and neither can read what it finds. Within
  one process the library now catches it — a direct key whose envelope contradicts a
  `@cached` declaration on the same `use_case` raises — but across languages it cannot.
- **`aput` raises on a cache-layer failure**, unlike a read. That matches `adelete` and
  `ainvalidate`. "Prime" reads as best-effort, so a caller on a request path should decide
  what to do with a Redis timeout rather than let it propagate.
- **A prime is sampled by the ramp, like a read.** `_should_cache` calls `random()` per
  invocation, per layer, so a use case at ramp 50 drops about half its primes and `aput`
  still returns normally. On a read that costs one uncached call; on a prime it throws away
  work already done and the entry another process waits for never appears. Ramp a shared
  use case to 100 or 0, not through the middle.
- **A prime inside an active invalidation window is lost silently — on the Redis layer.**
  The entry is written with `createdAtMs` below the watermark, so remote reads find it stale
  until the window closes and a read rewrites it. That is the invalidation doing its job, but
  `aput` still returns normally. Go behaves the same way; the TypeScript client returns
  `false` here. The **local** layer never reads watermarks, so a later `aget` in the same
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

The Go counterpart is `orbit/libs/go/gcache/protocodec.ProtoJSON`, and the two set the same
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

### Full Flush

For testing or emergencies:

```python
gcache.flushall()       # Sync
await gcache.aflushall()  # Async
```

## Metrics

GCache exports Prometheus metrics automatically:

| Metric | Type | Description |
|--------|------|-------------|
| `gcache_request_counter` | Counter | Total cache requests |
| `gcache_miss_counter` | Counter | Cache misses |
| `gcache_disabled_counter` | Counter | Requests where caching was skipped (labels: `reason`) |
| `gcache_error_counter` | Counter | Errors during cache operations (labels: `layer`, `error`, `in_fallback`) |
| `gcache_degraded_read_counter` | Counter | Reads that found an entry but could not use it, so degraded to a miss and rewrote it (labels: `reason`) |
| `gcache_invalidation_counter` | Counter | Invalidation calls |
| `gcache_get_timer` | Histogram | Cache get latency |
| `gcache_fallback_timer` | Histogram | Time spent in the underlying function |
| `gcache_serialization_timer` | Histogram | Pickle serialization time |
| `gcache_size_histogram` | Histogram | Size of cached values |

All metrics include `use_case` and `key_type` labels for filtering.

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

Both are now a **miss that heals**: the entry is rewritten, and the event is counted in
`gcache_degraded_read_counter` instead. Strictly better behaviour, but an operator alerting
on `gcache_error_counter` loses both signals silently. The `reason` label distinguishes
them:

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
