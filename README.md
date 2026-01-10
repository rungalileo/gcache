# GCache

[![PyPI version](https://badge.fury.io/py/gcache.svg)](https://badge.fury.io/py/gcache)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)

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
    default_config=GCacheKeyConfig(
        ttl_sec={CacheLayer.LOCAL: 60, CacheLayer.REMOTE: 300},
        ramp={CacheLayer.LOCAL: 100, CacheLayer.REMOTE: 100},
    ),
)
async def get_user(user_id: str) -> dict:
    return await db.fetch_user(user_id)  # Your expensive operation

# Use it — caching only happens inside enable() blocks
with gcache.enable():
    user = await get_user("123")  # Cached!
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

Real functions have complex arguments. Use `id_arg` tuples and `arg_adapters` to handle them:

```python
@gcache.cached(
    key_type="user_id",
    id_arg=("user", lambda u: u.id),  # Extract ID from User object
    arg_adapters={
        "filters": lambda f: f.to_cache_key(),  # Convert complex objects
        "page": str,  # Simple conversion
    },
    ignore_args=["db_session", "logger"],  # Don't include these in cache key
)
async def search_user_posts(
    user: User,
    filters: SearchFilters,
    page: int,
    db_session: Session,
    logger: Logger,
) -> list[Post]:
    ...
```

### Sync Functions Work Too

```python
@gcache.cached(key_type="org_id", id_arg="org_id", use_case="GetOrgSettings")
def get_org_settings(org_id: str) -> dict:  # No async needed
    return db.query(...)
```

Under the hood, sync functions run through a thread pool to avoid blocking the event loop. This adds some overhead, so **prefer async functions when possible** for better performance.

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
        cache_config_provider=config_provider,
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
        cache_config_provider=config_provider,
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
| `gcache_error_counter` | Counter | Errors during cache operations |
| `gcache_invalidation_counter` | Counter | Invalidation calls |
| `gcache_get_timer` | Histogram | Cache get latency |
| `gcache_fallback_timer` | Histogram | Time spent in the underlying function |
| `gcache_serialization_timer` | Histogram | Pickle serialization time |
| `gcache_size_histogram` | Histogram | Size of cached values |

All metrics include `use_case` and `key_type` labels for filtering.

You can add a prefix to avoid collisions:

```python
GCacheConfig(
    cache_config_provider=config_provider,
    metrics_prefix="myapp_",  # Metrics become myapp_gcache_request_counter, etc.
)
```

## Error Handling

GCache is designed to fail open. If Redis is down or an error occurs:

1. The underlying function executes normally
2. The error is logged and counted in `gcache_error_counter`
3. Your request succeeds (just without caching)

This means a cache failure never breaks your application.

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
