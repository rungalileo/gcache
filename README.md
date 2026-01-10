# GCache

[![PyPI version](https://badge.fury.io/py/gcache.svg)](https://badge.fury.io/py/gcache)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)

A lightweight caching library that gives you fine-grained control over what gets cached, when, and for how long. Built for teams who need observability, runtime controls, and proper invalidation—not just a key-value store.

## Why GCache?

Most caching libraries make simple things easy but hard things impossible. GCache is designed for the messy reality of production systems:

- **Gradual rollout** — Ramp up caching from 0% to 100% per use case, not all-or-nothing
- **Targeted invalidation** — Invalidate all cache entries for a user without knowing every cache key
- **Full observability** — Prometheus metrics out of the box, broken down by use case
- **Safe by default** — Caching is opt-in per request, so you won't accidentally serve stale data during writes

## Installation

```bash
pip install gcache
```

Requires Python 3.10+

## Quick Start

```python
from gcache import GCache, GCacheConfig, GCacheKeyConfig, GCacheKey, CacheLayer

# 1. Define how long things should be cached
async def config_provider(key: GCacheKey) -> GCacheKeyConfig:
    return GCacheKeyConfig(
        ttl_sec={CacheLayer.LOCAL: 60, CacheLayer.REMOTE: 300},
        ramp={CacheLayer.LOCAL: 100, CacheLayer.REMOTE: 100},
    )

# 2. Create the cache instance (singleton)
gcache = GCache(GCacheConfig(cache_config_provider=config_provider))

# 3. Decorate your function
@gcache.cached(key_type="user_id", id_arg="user_id")
async def get_user(user_id: str) -> dict:
    return await db.fetch_user(user_id)  # Your expensive operation

# 4. Use it — caching only happens inside enable() blocks
async def handle_request(user_id: str):
    with gcache.enable():
        user = await get_user(user_id)  # Cached!
    return user
```

That's it. The function works normally outside `enable()` blocks, and caches results inside them.

## How It Works

GCache uses a multi-layer read-through cache. When you call a cached function:

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

## The `@cached` Decorator

The decorator handles both sync and async functions automatically.

### Basic Usage

```python
@gcache.cached(
    key_type="user_id",      # What kind of entity is this?
    id_arg="user_id",        # Which argument contains the ID?
    use_case="GetUserProfile" # Optional: name for metrics (defaults to module.function)
)
async def get_user_profile(user_id: str) -> dict:
    ...
```

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
@gcache.cached(key_type="org_id", id_arg="org_id")
def get_org_settings(org_id: str) -> dict:  # No async needed
    return db.query(...)
```

Under the hood, sync functions run through a thread pool to avoid blocking the event loop.

## Redis Configuration

### No Redis (Local Only)

```python
gcache = GCache(GCacheConfig(cache_config_provider=config_provider))
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

# When user data changes, invalidate all their cached data
await gcache.ainvalidate(key_type="user_id", id="12345")

# Sync version
gcache.invalidate(key_type="user_id", id="12345")
```

This invalidates *all* cache entries for that user—every use case, every argument combination.

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

## Runtime Configuration

The config provider runs for each cache operation, so you can adjust behavior dynamically:

```python
async def config_provider(key: GCacheKey) -> GCacheKeyConfig | None:
    # Disable caching for a specific use case
    if key.use_case == "LegacyEndpoint":
        return None

    # Ramp up gradually
    if key.use_case == "NewFeature":
        return GCacheKeyConfig(
            ttl_sec={CacheLayer.LOCAL: 30, CacheLayer.REMOTE: 120},
            ramp={CacheLayer.LOCAL: 25, CacheLayer.REMOTE: 50},  # 25% local, 50% remote
        )

    # Default config
    return GCacheKeyConfig(
        ttl_sec={CacheLayer.LOCAL: 60, CacheLayer.REMOTE: 300},
        ramp={CacheLayer.LOCAL: 100, CacheLayer.REMOTE: 100},
    )
```

The `ramp` parameter controls what percentage of requests actually use the cache. Start at 0% and increase as you gain confidence.

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
