# GCache

GCache is a lightweight, high-performance library that provides fine-grained observability and runtime controls for multi-layered read-through caching. It enables robust caching with minimal effort while providing full visibility and control over your cache behavior.

- **Dashboard**: https://rungalileo.grafana.net/d/bd8fc1a7-46bd-42ee-ae53-773c10128608/gcache
- **Metrics**: Fine-grained metrics for cache hits, misses, errors, and latency by use case and key type

## Table of Contents

- [Getting Started](#getting-started)
- [Key Concepts](#key-concepts)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Usage Guide](#usage-guide)
  - [Basic Usage](#basic-usage)
  - [Advanced Usage](#advanced-usage)
- [Cache Invalidation](#cache-invalidation)
- [Cache Control](#cache-control)
- [Best Practices](#best-practices)

## Getting Started

### Installation

```bash
pip install cachegalileo
```

### Basic Setup

```python
from cachegalileo import GCache, GCacheConfig, RedisConfig, GCacheKeyConfig

# Define your cache configuration provider
async def config_provider(key):
    # Return cache configuration for specific use cases
    # This is where you can dynamically control TTL and ramp settings
    return GCacheKeyConfig(
        ttl_sec={CacheLayer.LOCAL: 60, CacheLayer.REMOTE: 300},
        ramp={CacheLayer.LOCAL: 100, CacheLayer.REMOTE: 100}
    )

# Initialize the cache
gcache = GCache(
    GCacheConfig(
        cache_config_provider=config_provider,
        redis_config=RedisConfig(host="localhost", port=6379),
        metrics_prefix="my_service_"
    )
)
```

## Key Concepts

GCache is built on several critical concepts that ensure precise control and observability:

### 1. Key Types

Each cache key must reference a key type in addition to the actual ID. For example:
- Key type: `user_email`, ID: `user@example.com`
- Key type: `account_id`, ID: `12345`

Benefits:
- **Targeted invalidation**: Invalidate all caches sharing the same key type and ID
- **Better instrumentation**: Track cache performance metrics grouped by key type

### 2. Use Cases

Each caching scenario requires a unique use case name, which by default is `module_path.function_name`.

Benefits:
- **Granular metrics**: Monitor performance by specific use case
- **Independent control**: Tune or ramp specific use cases individually
- **Clear organization**: Group related cache entries logically

### 3. Cache Layers

GCache provides a multi-layered caching approach:
- **Local cache**: Fast in-memory cache (per-process)
- **Remote cache**: Distributed Redis cache (shared across processes/services)

Each layer can be configured independently with different TTLs and ramp settings.

### 4. Context-Based Control

Caching is disabled by default and must be explicitly enabled via a context manager. This allows precise control over which code blocks use caching, preventing issues like stale data after write operations.

## Architecture

GCache implements a sophisticated multi-layered architecture:

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  ┌─────────────┐       ┌─────────────┐                  │
│  │ Local Cache │───┬───│ Redis Cache │───┐              │
│  └─────────────┘   │   └─────────────┘   │              │
│                    │                     │              │
│     Cache Hit      │      Cache Miss     │  Cache Miss  │
│        ↓           │         ↓           │      ↓       │
│     Return      Cache Miss   Store       │    Execute   │
│      Data          │       and Return    │    Fallback  │
│                    └─────────────────────┘    Function  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

1. **Request Flow**:
   - Check local cache first (fastest)
   - If miss, check Redis cache (distributed)
   - If miss again, execute the original function and cache the result

2. **Key Components**:
   - **CacheInterface**: Base abstraction for all cache implementations
   - **LocalCache**: In-memory TTL-based cache
   - **RedisCache**: Distributed Redis-based cache
   - **CacheController**: Handles metrics, ramp settings and caching decisions
   - **CacheChain**: Chains multiple cache layers together

3. **Observability**:
   - Comprehensive metrics for cache hits, misses, errors by layer/use case/key type
   - Latency tracking for cache operations and fallback execution

## Configuration

### GCache Initialization

The `GCache` constructor accepts a `GCacheConfig` object with these key parameters:

```python
GCacheConfig(
    # Required: Async function returning cache config for a given key
    cache_config_provider: CacheConfigProvider,

    # Optional: Prefix for cache key URNs (default: "urn")
    urn_prefix: str = None,

    # Optional: Prefix for metrics (default: "api_")
    metrics_prefix: str = "api_",

    # Optional: Redis configuration (if None, only local cache is used)
    redis_config: RedisConfig = None,

    # Optional: Custom logger
    logger: Logger = None
)
```

### Cache Key Configuration

For each cache key (use case), you configure TTL and ramp settings per cache layer:

```python
GCacheKeyConfig(
    # TTL in seconds for each cache layer
    ttl_sec={
        CacheLayer.LOCAL: 60,    # 1 minute in local cache
        CacheLayer.REMOTE: 300,  # 5 minutes in Redis
    },

    # Percentage of requests to cache (0-100) for each layer
    ramp={
        CacheLayer.LOCAL: 100,   # 100% of requests use local cache
        CacheLayer.REMOTE: 50,   # 50% of requests use Redis cache
    }
)
```

### Setting TTL Values

When choosing TTL values, consider these factors:

1. **Data volatility**: How frequently does the data change?
   - Highly dynamic data: shorter TTL (seconds to minutes)
   - Stable data: longer TTL (minutes to hours)

2. **Consistency requirements**: How important is fresh data?
   - Critical systems: shorter TTL or targeted invalidation
   - Non-critical systems: longer TTL for better performance

3. **Cache layers**: Different TTLs for different layers
   - Local cache: typically shorter TTL
   - Remote cache: typically longer TTL

4. **Load patterns**: Balance between cache hits and freshness
   - High load periods: consider longer TTLs
   - Predictable updates: time TTLs around update cycles

## Usage Guide

### Basic Usage

1. **Create a GCache instance** (typically as a singleton):

```python
from cachegalileo import GCache, GCacheConfig, CacheLayer, GCacheKeyConfig

# Define config provider
async def cache_config_provider(key):
    # Default configuration for all use cases
    return GCacheKeyConfig(
        ttl_sec={CacheLayer.LOCAL: 60, CacheLayer.REMOTE: 300},
        ramp={CacheLayer.LOCAL: 100, CacheLayer.REMOTE: 100}
    )

# Create the GCache instance
gcache = GCache(GCacheConfig(cache_config_provider=cache_config_provider))
```

2. **Decorate functions to cache**:

```python
@gcache.cached(
    key_type="user_email",  # Type of entity
    id_arg="email",         # Argument holding the entity ID
    use_case="GetUserByEmail"  # Optional: custom use case name
)
def get_user_by_email(db_session, email: str) -> User:
    # Function implementation
    return db_session.query(User).filter(User.email == email).first()
```

3. **Enable caching in your code**:

```python
# Caching is disabled by default
result1 = get_user_by_email(db, "user@example.com")  # Not cached

# Enable caching for a specific block
with gcache.enable():
    # This call will be cached
    result2 = get_user_by_email(db, "user@example.com")

    # Subsequent calls with the same args will use cache
    result3 = get_user_by_email(db, "user@example.com")
```

### Advanced Usage

#### Argument Transformers

For complex function arguments, use transformers to extract relevant cache key parts:

```python
@gcache.cached(
    key_type="user_id",
    # Extract ID from a complex object
    id_arg=("user", lambda user: user.system_user_id),
    # Transform other arguments
    arg_adapters={
        "project_type": lambda project_type: project_type.name,
        "pagination": lambda pagination: f"{pagination.starting_token}-{pagination.limit}"
    },
    # Skip arguments irrelevant to the cache key
    ignore_args=["db_session"]
)
def get_latest_runs(
    db_session, user: User, project_type: ProjectType, pagination: PaginationRequest
):
    # Implementation
    pass
```

#### Ignoring Arguments

Skip arguments that shouldn't affect the cache key:

```python
@gcache.cached(
    key_type="product_id",
    id_arg="product_id",
    # Ignore implementation details
    ignore_args=["db_session", "logger", "metrics_client"]
)
def get_product_details(db_session, product_id: str, logger, metrics_client):
    # Implementation
    pass
```

#### Default Cache Config

Provide default cache config for a specific function:

```python
@gcache.cached(
    key_type="account_id",
    id_arg="account_id",
    # Default config used when config_provider returns None
    default_config=GCacheKeyConfig.enabled(ttl_sec=300, use_case="GetAccountDetails")
)
def get_account_details(account_id: str):
    # Implementation
    pass
```

## Cache Invalidation

GCache provides powerful invalidation mechanisms for maintaining data consistency:

### Basic Invalidation

Invalidate all cache entries for a specific key type and ID:

```python
# After updating a user
def update_user(user_id, new_data):
    # Update in database
    db.update_user(user_id, new_data)

    # Invalidate all caches related to this user
    gcache.invalidate(key_type="user_id", id=user_id)
```

### Future Buffer Invalidation

To prevent race conditions where read operations might occur between invalidation and write completion:

```python
# Invalidate with future buffer
gcache.invalidate(
    key_type="user_id",
    id=user_id,
    fallback_buffer_ms=1000  # Invalidate 1 second into the future
)
```

### Async Invalidation

```python
await gcache.ainvalidate(key_type="user_id", id=user_id)
```

### Tracking for Invalidation

For caches that need precise invalidation tracking:

```python
@gcache.cached(
    key_type="user_id",
    id_arg="user_id",
    track_for_invalidation=True  # Enable tracking for this cache
)
def get_user_preferences(user_id: str):
    # Implementation
    pass
```

## Cache Control

### Context-Based Control

Control caching for specific code blocks:

```python
# In read endpoints (enable caching)
with gcache.enable():
    result = get_user_data(user_id)

# In write endpoints (disable caching to prevent stale reads)
with gcache.enable(False):
    result = get_user_data(user_id)  # Will not use cache
    update_user_data(user_id, new_data)
```

### Ramp Settings

Control the percentage of requests that use caching:

```python
# In your config provider
async def cache_config_provider(key):
    if key.use_case == "HighLoadUseCase":
        return GCacheKeyConfig(
            ttl_sec={CacheLayer.LOCAL: 60, CacheLayer.REMOTE: 300},
            ramp={
                CacheLayer.LOCAL: 100,  # 100% for local cache
                CacheLayer.REMOTE: 50   # 50% for Redis cache
            }
        )
    # Default config for other use cases
    return GCacheKeyConfig.enabled(ttl_sec=60, use_case=key.use_case)
```

## Best Practices

### Naming Key Types

Choose key types that clearly identify the entity type:
- Use noun-based names: `user_id`, `account_email`, `product_sku`
- Be consistent: follow patterns like `entity_identifier`
- Be specific: `user_email` is better than generic `email`

### Naming Use Cases

Choose descriptive use case names that indicate the operation:
- Method-based: `GetUserByEmail`, `ListProductsByCategory`
- Group related operations: use common prefixes for related use cases
- Align with business domain: names should make sense to product/business teams

### TTL Configuration

- **Layer-specific TTLs**:
  - Local cache: shorter TTL (faster invalidation)
  - Remote cache: longer TTL (less network overhead)

- **Use case specific TTLs**:
  - Critical data: shorter TTL
  - Stable data: longer TTL

### Invalidation Strategy

- Invalidate at write time
- Use appropriate key types to target invalidation precisely
- Consider using `fallback_buffer_ms` in high concurrency environments

### Performance Considerations

- **Cache key complexity**: Keep cache keys small and simple
- **Cache value size**: Be mindful of large objects in local cache
- **Instrumentation**: Monitor cache hit rates to tune TTLs

### Error Handling

GCache is designed to gracefully fallback to the original function when errors occur:
- Cache key construction errors
- Redis connectivity issues
- Serialization/deserialization errors

The system will log these errors and collect metrics, but your application will continue functioning.
