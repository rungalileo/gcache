# GCache

GCache is a lightweight library that provides fine-grained observability, runtime controls and invalidation mechanics for read-through caching.

It's designed for rapidly adding new cache use cases with safety and structure in place.

## Core Concepts

### Key Structure and Organization

GCache organizes cache entries using a structured key system that consists of four main components:

1. **Key Type**: Identifies the type of entity being cached (e.g., `user_email`, `user_id`, `organization_id`)
2. **ID**: The specific identifier for that entity (e.g., `user@example.com`, `12345`)
3. **Arguments**: Additional parameters that differentiate cache entries for the same entity
4. **Use Cases**: Every unique use case in GCache is associated with a "use case" - a unique identifier for a specific caching scenario. By default, this is the module path + function name, but custom use case names are recommended for clarity.

Structured arguments provide several benefits:

- **Targeted Invalidation**: Invalidate all cache entries for a specific key type and ID
- **Comprehensive Monitoring**: Track cache performance metrics by key type
- **Hierarchical Organization**: Group related cache entries logically

Use cases enable:

- **Granular Instrumentation**: Monitor cache hit/miss rates for specific use cases
- **Targeted Runtime Control**: Enable, disable, or adjust caching behavior for individual use cases
- **Documentation**: Self-document the purpose of each cache operation

All of these components are represented as an [URN](https://en.wikipedia.org/wiki/Uniform_Resource_Name) which becomes final cache key:
`urn:galileo:<Key Type>:<ID>?<Arguments>#<Use case>`

### Cache Layers

GCache supports multiple caching layers:

- **Local Cache**: In-memory cache for ultra-fast access
- **Remote Cache**: Redis-based distributed cache for shared access across instances

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Multi-Layer Read-Through Cache Flow                     │
└─────────────────────────────────────────────────────────────────────────────┘

    CLIENT REQUEST
         │
         ▼
    ┌─────────┐
    │ @cached │ ──── "get_user(id=123)"
    └────┬────┘
         │
         ▼
┌─────────────────┐     HIT ✓
│  LOCAL CACHE    │ ◄──────────► {"id": 123, "name": "Alice"}
│  (In-Memory)    │               ↑ RETURN IMMEDIATELY
│  TTL: 5 min     │
└────────┬────────┘
         │ MISS ✗
         ▼
┌─────────────────┐     HIT ✓
│  REDIS CACHE    │ ◄──────────► {"id": 123, "name": "Alice"}
│  (Distributed)  │               ↑ POPULATE LOCAL + RETURN
│  TTL: 1 hour    │
└────────┬────────┘
         │ MISS ✗
         ▼
┌─────────────────┐
│ SOURCE OF TRUTH │ ──── Database Query / API Call
│  (Database/API) │      SELECT * FROM users WHERE id = 123
└────────┬────────┘
         │
         ▼
    FETCH DATA: {"id": 123, "name": "Alice"}
         │
         ├──► POPULATE REDIS CACHE
         ├──► POPULATE LOCAL CACHE
         └──► RETURN TO CLIENT
```


## Getting Started

### Basic Usage

`GCache` is designed to be instantiated once as a singleton:

```python
from gcache import GCache, GCacheConfig, GCacheKeyConfig, GCacheKey, CacheLayer

async def config_provider(key: GCacheKey) -> GCacheKeyConfig:
    return GCacheKeyConfig(
        ttl_sec={CacheLayer.LOCAL: 5, CacheLayer.REMOTE: 10},
        ramp={CacheLayer.LOCAL: 100, CacheLayer.REMOTE: 100},
    )

# Create GCache instance
gcache = GCache(
    GCacheConfig(
        cache_config_provider=config_provider,
        redis_config=RedisConfig(port=6379),  # Optional
    )
)
```

### Redis Configuration

GCache supports flexible Redis configuration. You can disable Redis entirely (local cache only), use standard Redis configuration, or provide a custom client factory for advanced use cases.

#### Option 1: No Redis (Local Cache Only)

If neither `redis_config` nor `redis_client_factory` is provided, GCache uses only local in-memory cache:

```python
gcache = GCache(
    GCacheConfig(
        cache_config_provider=config_provider,
        # No redis_config or redis_client_factory = local cache only
    )
)
```

#### Option 2: Using RedisConfig

Provide Redis connection parameters via `RedisConfig`:

```python
from gcache import RedisConfig

gcache = GCache(
    GCacheConfig(
        cache_config_provider=config_provider,
        redis_config=RedisConfig(
            host="redis.example.com",
            port=6379,
            username="myuser",
            password="mypassword",
            protocol="redis",  # or "rediss" for TLS
            cluster=False,  # Set to True for Redis Cluster
            redis_py_options={
                "socket_connect_timeout": 1,
                "socket_timeout": 1,
                "max_connections": 100,
            },
        ),
    )
)
```

#### Option 3: Custom Redis Client Factory

For advanced scenarios (e.g., dynamic credentials, token refresh, custom connection logic), provide a custom `redis_client_factory`:

```python
import threading
from redis.asyncio import Redis, RedisCluster

def create_custom_redis_factory():
    """Factory with thread-local storage for Redis clients."""
    _thread_local = threading.local()

    def factory() -> Redis | RedisCluster:
        if not hasattr(_thread_local, "client"):
            # Custom logic: fetch credentials, handle token refresh, etc.
            token = get_auth_token_from_vault()
            _thread_local.client = Redis.from_url(
                f"redis://:{token}@redis.example.com:6379",
                socket_connect_timeout=1,
                socket_timeout=1,
            )
        return _thread_local.client

    return factory

gcache = GCache(
    GCacheConfig(
        cache_config_provider=config_provider,
        redis_client_factory=create_custom_redis_factory(),
    )
)
```

**Important**: Your custom factory must implement thread-local storage to ensure each thread gets its own Redis client instance.

**Note**: You cannot provide both `redis_config` and `redis_client_factory`. If both are provided, a `RedisConfigConflict` exception will be raised.

### Caching Functions

The `@cached` decorator is the primary way to cache function results. It works with both synchronous and asynchronous functions.

#### Simple Example

```python
# Simple caching example
@gcache.cached(
    key_type="user_id",
    id_arg="user_id",
    use_case="GetUserProfile"
)
def get_user_profile(user_id: str) -> dict:
    # Expensive operation to fetch user profile
    return expensive_db_query(user_id)

# This won't use cache (caching is disabled by default)
profile = get_user_profile("12345")

# Enable caching for a specific block of code
with gcache.enable():
    # This will use cache
    profile = get_user_profile("12345")
    # Subsequent calls with the same user_id will return cached results
    profile_again = get_user_profile("12345")  # Cache hit!
```

#### Advanced Example: Argument Transformers

For complex objects, you can use argument transformers to extract only the relevant parts for cache keys:

```python
@gcache.cached(
    key_type="user_id",
    # Extract ID from a complex object
    id_arg=("user", lambda user: user.system_user_id),
    use_case="GetUserLatestRuns",
    # Transform complex arguments into simple strings for the cache key
    arg_adapters={
        "project_type": lambda project_type: project_type.name,
        "pagination": lambda pagination: f"{pagination.starting_token}-{pagination.limit}"
    },
    # Exclude arguments that don't affect the result
    ignore_args=["db_read"],
)
def get_latest_runs(
    db_read: Session,
    user: User,
    project_type: ProjectType,
    pagination: PaginationRequestMixin
) -> GetUserLatestRuns:
    # Implementation...
    return db_results
```

### Controlling Cache Behavior

#### Enabling/Disabling Cache

Caching is **disabled by default** for safety. To enable caching, use the `enable()` context manager:

```python
# Cache is disabled here
result1 = cached_function()  # No caching occurs

# Enable caching for this block
with gcache.enable():
    result2 = cached_function()  # First call, cache miss
    result3 = cached_function()  # Subsequent call, cache hit

# Cache is disabled again
result4 = cached_function()  # No caching occurs
```

This design allows precise control over when caching is active, particularly useful in write operations where you want to avoid stale reads.

#### Ramping up Caching

A use case must be ramped up to enable caching in addition to being executed in "enabled" context.  Use runtime config to ramp up your particular use case.

Cache config provider given to GCache constructor is invoked for each unique use case to determine ramp % as well as TTL config.

## Cache Invalidation
### Targeted Invalidation

Invalidate all cache entries for a specific entity:

```python
@gcache.cached(
    key_type="user_id",
    id_arg="user_id",
    track_for_invalidation=True  # Enable tracking for invalidation
)
def get_user_profile(user_id: str) -> dict:
    # ...

# Invalidate all cache entries for user with ID "12345"
gcache.invalidate(key_type="user_id", id="12345")

# Async version
await gcache.ainvalidate(key_type="user_id", id="12345")
```

This invalidates all cache entries that share the same key type and ID, regardless of additional arguments or use case.

### Future Invalidation Buffer

To prevent race conditions where a read happens just before a write, you can set a future buffer:

```python
# Invalidate with a 5-second buffer into the future
gcache.invalidate(
    key_type="user_id",
    id="12345",
    fallback_buffer_ms=5000
)
```

This ensures that any cache entry created right before the invalidation will also be considered invalid.

### Complete Cache Flush

For testing or emergency scenarios:

```python
# Clear all cache entries (local and remote)
gcache.flushall()

# Async version
await gcache.aflushall()
```

## Guidelines for caching

### When to use caching
We can break up caching use cases by eventual consistency constraints.
#### 1: Can tolerate stale cache
In certain use cases, it's acceptable to have a few seconds - minutes of delay for updates to take effect. In these situations its safe to use local and remote cache and to rely soley on TTL.

Monitoring cache hit rates is crucial for performance optimization; adjusting the TTL settings can help improve this metric.

In this scenario, there's no need to implement shadowing to monitor cache accuracy.

#### 2: Cannot tolerate stale cache
In these use cases cache must be updated immediately, otherwise we will cause regression.

We can only use remote caching in these cases since local cache cannot be invalidated.

In this scenario we need a robust cache invalidation mechanic.  Right before or after write you must make sure all cache is invalidated.

In order to demonstrate efficacy of cache invalidation you will also need to shadow cache reads for consistency against SoT.

Good news is that we can set TTL on remote cache to be quite long as long as invalidation is proven to be correct.


## Performance Considerations

- **Local Cache**: Ultra-fast in-memory cache, but not shared between instances.  Cannot be invalidated by other instances.
- **Remote Cache**: Shared between instances, but slightly higher latency.  Can be invalidated by other instances.
- **Argument Transformers**: Use them to keep cache keys small and focused


## Monitoring and Observability

GCache automatically collects metrics for:

- Cache hit/miss rates by use case and key type
- Cache operation latency
- Cache size
- Invalidation frequency
