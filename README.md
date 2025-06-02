# GCache

GCache is a lightweight library that provides fine-grained observability and runtime controls for read-through caching. It's designed to be flexible, performant, and easy to integrate into your application.

> **TODO**
> Shadowing cache reads against SoT is not implemented yet

## Core Concepts

### Key Structure and Organization

GCache organizes cache entries using a structured key system that consists of three main components:

1. **Key Type**: Identifies the type of entity being cached (e.g., `user_email`, `user_id`, `organization_id`)
2. **ID**: The specific identifier for that entity (e.g., `user@example.com`, `12345`)
3. **Arguments**: Additional parameters that differentiate cache entries for the same entity

This structured approach provides several benefits:

- **Targeted Invalidation**: Invalidate all cache entries for a specific entity type and ID
- **Comprehensive Monitoring**: Track cache performance metrics by entity type
- **Hierarchical Organization**: Group related cache entries logically

### Use Cases

Every unique use case in GCache is associated with a "use case" - a unique identifier for a specific caching scenario. By default, this is the module path + function name, but custom use case names are recommended for clarity.

Use cases enable:

- **Granular Instrumentation**: Monitor cache hit/miss rates for specific use cases
- **Targeted Runtime Control**: Enable, disable, or adjust caching behavior for individual use cases
- **Documentation**: Self-document the purpose of each cache operation

### Cache Layers

GCache supports multiple caching layers:

- **Local Cache**: In-memory cache for ultra-fast access
- **Remote Cache**: Redis-based distributed cache for shared access across instances

## Getting Started

### Basic Usage

`GCache` is designed to be instantiated once as a singleton:

```python
from gcache import GCache, GCacheConfig, GCacheKeyConfig

# Create GCache instance
gcache = GCache(
    GCacheConfig(
        # Configure cache settings
        cache_config_provider=your_config_provider,
        # Optional Redis configuration
        redis_config=redis_config
    )
)
```

## Caching Functions

The `@cached` decorator is the primary way to cache function results. It works with both synchronous and asynchronous functions:

### Simple Example

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

### Advanced Example: Argument Transformers

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
