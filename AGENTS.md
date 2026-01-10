# AGENTS.md

## Project Overview

gcache is a fine-grained caching library with multi-layer support (local + Redis) and a decorator-based API. It works with both sync and async functions.

## Structure

```
src/gcache/
├── __init__.py          # Public API exports
├── base.py              # Core implementation (~1000 lines)
└── event_loop_thread.py # Sync/async bridge for threading
tests/
├── conftest.py          # Fixtures (redis_server, gcache, cache_config_provider)
├── test_gcache.py       # Main test suite
└── test_*.py            # Specialized tests
```

## Key Components

- **GCache**: Singleton main class, provides `@cached` decorator
- **CacheLayer**: Enum - `NOOP`, `LOCAL` (TTLCache), `REMOTE` (Redis)
- **CacheChain**: Chains local → redis with read-through strategy
- **EventLoopThreadPool**: Runs async code from sync cached functions (16 threads)
- **GCacheKey**: URN-formatted cache keys with invalidation tracking

## Core Pattern: @cached Decorator

```python
@gcache.cached(
    key_type="user_id",           # Entity type
    id_arg="user_id",             # Arg name for cache key
    use_case="GetUser",           # Unique identifier
    arg_adapters={"request": lambda r: r.id},  # Complex arg → string
    ignore_args=["logger"],       # Args not in cache key
)
async def get_user(user_id: str, request: Request, logger: Logger) -> User:
    ...
```

## Critical Patterns

1. **Context-based enable**: Cache is disabled by default
   ```python
   with gcache.enable():
       result = cached_func()  # Actually uses cache
   ```

2. **Sync functions use thread pool**: Sync `@cached` functions run through `EventLoopThreadPool` to avoid blocking

3. **No reentrant sync calls**: Sync cached function calling another sync cached function raises `ReentrantSyncFunctionDetected` - convert to async

4. **Thread-local Redis clients**: `RedisCache` stores client per-thread via `threading.local()`

5. **Watermark invalidation**: Uses timestamps to invalidate without deleting keys

## Code Conventions

- **Type hints required**: `mypy --disallow_untyped_defs`
- **Line length**: 120 chars
- **Linting**: ruff (E4, E7, E9, F, I, UP, ASYNC)
- **Docstrings**: Numpy style
- **Python**: 3.10+ (uses `|` union syntax)

## Testing

- pytest + pytest-asyncio
- `redislite` for in-memory Redis
- Always test both sync and async paths
- Key fixtures: `gcache`, `redis_server`, `cache_config_provider`

Run tests:
```bash
pytest tests/
```

## When Modifying

1. **Update both sync/async paths** - changes typically affect both
2. **Preserve context variables** - critical for `gcache.enable()` across threads
3. **Test both redis_config and redis_client_factory paths**
4. **Add Prometheus metrics** for new cache behaviors
5. **Run pre-commit** - ruff format, mypy, poetry-check

## Common Gotchas

- GCache is singleton - second instantiation raises `GCacheAlreadyInstantiated`
- "watermark" is a reserved use_case name
- Local cache cannot be invalidated (TTL-only expiration)
- Large payloads (>50KB) serialize in executor to avoid blocking

## Dependencies

Core: pydantic, prometheus-client, cachetools, redis, uvloop
