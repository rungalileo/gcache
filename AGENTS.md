# AGENTS.md

## Project Overview

gcache is a fine-grained caching library with multi-layer support (local + Redis) and a decorator-based API. It works with both sync and async functions.

## Structure

```
src/gcache/
├── __init__.py              # Public API exports
├── config.py                # GCacheKey, GCacheKeyConfig, GCacheConfig, RedisConfig, Serializer
├── exceptions.py            # All exception classes
├── gcache.py                # GCache main class and @cached decorator
└── _internal/               # Implementation details (not public API)
    ├── constants.py         # Named constants (cache sizes, TTLs, thresholds)
    ├── event_loop_thread.py # EventLoopThread, EventLoopThreadPool
    ├── local_cache.py       # LocalCache (TTLCache-based)
    ├── metrics.py           # GCacheMetrics (Prometheus)
    ├── redis_cache.py       # RedisCache
    └── wrappers.py          # CacheController, CacheChain

tests/
├── conftest.py              # Fixtures (redis_server, gcache, cache_config_provider)
└── test_*.py                # Test suites
```

## Key Components

- **GCache**: Singleton main class, provides `@cached` decorator
- **CacheLayer**: Enum - `NOOP`, `LOCAL` (TTLCache), `REMOTE` (Redis)
- **CacheChain**: Chains local → redis with read-through strategy
- **EventLoopThreadPool**: Runs async code from sync cached functions (16 threads)
- **GCacheKey**: Frozen dataclass for cache keys (key_type, id, use_case, args)

## Critical Patterns

1. **Context-based enable**: Cache is disabled by default - use `with gcache.enable():`

2. **Sync functions use thread pool**: Sync `@cached` functions run through `EventLoopThreadPool`

3. **Don't call sync cached functions from async**: Blocks event loop (logs warning)

4. **No reentrant sync calls**: Raises `ReentrantSyncFunctionDetected` - convert to async

5. **Thread-local Redis clients**: `RedisCache` stores client per-thread via `threading.local()`

## Code Conventions

- Type hints required, line length 120, ruff + mypy
- Python 3.10+ (uses `|` union syntax)
- Always use `poetry run` for all commands including git (e.g., `poetry run pytest`, `poetry run git push`)

## Testing

```bash
poetry run pytest tests/
```

## Common Gotchas

- GCache is singleton - second instantiation raises `GCacheAlreadyInstantiated`
- "watermark" is reserved use_case name
- Local cache cannot be invalidated across instances (TTL-only)
- `WATERMARK_TTL_SECONDS` (4 hours) must exceed your longest cache TTL for invalidation to work
- uvloop is optional - falls back to asyncio on Windows/PyPy

## Dependencies

Core: pydantic, prometheus-client, cachetools, redis
Optional: uvloop
