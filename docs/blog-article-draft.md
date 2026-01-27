# GCache: Building a Production-Ready Caching Library for Moving Fast Without Breaking Things

*How we designed an opinionated caching layer that makes the right thing easy and the wrong thing hard.*

---

At Galileo, we've scaled from a handful of services to a complex microservices architecture handling millions of requests. Like every growing engineering team, we faced the eternal question: where and how should we add caching?

The naive answer—"cache everything"—leads to subtle bugs, stale data, and debugging nightmares. The cautious answer—"cache nothing"—leaves performance on the table. We needed something in between: a caching library that makes developers think about what they're doing, while making the right patterns easy to implement.

That's why we built **GCache**, an open-source Python caching library designed for teams that need to add caching strategically while maintaining control and observability.

## The Problem: Caching Is Easy, Safe Caching Is Hard

Every developer has written code like this:

```python
@cache(ttl=300)
def get_user(user_id: str) -> User:
    return db.fetch_user(user_id)
```

Simple, right? But then you encounter edge cases:

- **The Write Path Problem**: You update a user, but the cache still returns stale data. Now you need to remember to invalidate everywhere.
- **The Key Collision Problem**: Two functions with the same arguments produce the same cache key, serving incorrect data.
- **The Rollout Problem**: You want to enable caching gradually, but your caching library is all-or-nothing.
- **The Debugging Problem**: Production is misbehaving. Which cache keys are involved? What's in them? Nobody knows.
- **The Kill Switch Problem**: A cache is causing issues, but you need to redeploy to disable it.

We experienced all of these. GCache is our answer.

## Core Philosophy: Explicit Over Implicit

GCache's most controversial design decision is that **caching is disabled by default**. To use cached functions, you must explicitly enable caching:

```python
# Without enable(), this just calls the underlying function
user = await get_user(user_id)  # No caching

# Caching only happens inside an enable() block
with gcache.enable():
    user = await get_user(user_id)  # Cached!
```

Why require this ceremony? Because it forces developers to think about context.

Consider a typical request handler:

```python
async def handle_update_user(request):
    user_id = request.user_id

    # Read current state (want cache)
    with gcache.enable():
        user = await get_user(user_id)

    # Perform update (DON'T want to cache stale reads)
    await update_user(user_id, request.changes)

    # Invalidate so next read gets fresh data
    await gcache.ainvalidate("user_id", user_id)

    # Return fresh data (want cache populated with new data)
    with gcache.enable():
        return await get_user(user_id)
```

The explicit blocks make the intent clear: cache during reads, skip during writes, populate after mutations. No accidents.

## Multi-Layer Architecture

GCache implements a two-tier read-through cache:

```
Request → LOCAL CACHE → REDIS → Your Function
              ↓            ↓           ↓
           <1ms        1-10ms      10-100ms+
```

The local cache (in-memory TTLCache) handles hot paths with sub-millisecond latency. Redis provides a shared cache across your fleet for less frequent but still cacheable data.

Each layer can be configured independently:

```python
@gcache.cached(
    key_type="user_id",
    id_arg="user_id",
    use_case="GetUserProfile",
    default_config=GCacheKeyConfig(
        ttl_sec={
            CacheLayer.LOCAL: 60,    # Local: 1 minute
            CacheLayer.REMOTE: 3600, # Redis: 1 hour
        },
        ramp={
            CacheLayer.LOCAL: 100,   # 100% local cache
            CacheLayer.REMOTE: 50,   # 50% Redis rollout
        },
    ),
)
async def get_user_profile(user_id: str) -> dict:
    return await db.fetch_user(user_id)
```

## Human-Readable Cache Keys

Every cache key follows a URN format that's immediately understandable:

```
urn:gcache:user_id:12345?page=1&sort=created#GetUserPosts
     ↑        ↑      ↑          ↑               ↑
  prefix  key_type   id    extra args      use_case
```

When you're debugging in production and inspect Redis, you see:
- `urn:gcache:user_id:12345#GetUserProfile`
- `urn:gcache:user_id:12345?page=2#GetUserPosts`
- `urn:gcache:organization_id:org-789#GetOrgSettings`

No more mysterious hashed keys. You know exactly what's cached and why.

## Smart Invalidation with Watermarks

Traditional cache invalidation deletes keys. But what if you have thousands of keys for the same entity across different use cases?

GCache uses **watermarks** instead of deletion:

```python
await gcache.ainvalidate("user_id", "12345", future_buffer_ms=5000)
```

This sets a single timestamp. Any cached value created before that timestamp is automatically considered stale—across all use cases for that entity. The `future_buffer_ms` parameter handles race conditions where a read starts before a write finishes.

One invalidation call, complete coverage, no key scanning.

## Gradual Rollout with Ramp Percentages

Adding caching to a production system shouldn't require courage. GCache's ramp percentage lets you roll out gradually:

```python
# Start at 0%—caching is disabled
GCacheKeyConfig(
    ttl_sec={CacheLayer.LOCAL: 60, CacheLayer.REMOTE: 300},
    ramp={CacheLayer.LOCAL: 0, CacheLayer.REMOTE: 0},
)

# Monitor, increase to 10%, then 50%, then 100%
# All controlled via configuration—no redeploys
```

At 50% ramp, half of requests use the cache while half hit the source. You can compare metrics between cached and uncached paths in production.

## Dynamic Configuration Without Redeploys

The ramp percentage isn't static. GCache accepts a configuration provider that runs on every request:

```python
async def config_provider(key: GCacheKey) -> GCacheKeyConfig | None:
    # Fetch from LaunchDarkly, database, config file, etc.
    config = await feature_flags.get_cache_config(key.use_case)
    if not config:
        return None  # Use default_config
    return GCacheKeyConfig(
        ttl_sec={
            CacheLayer.LOCAL: config.local_ttl,
            CacheLayer.REMOTE: config.remote_ttl,
        },
        ramp={
            CacheLayer.LOCAL: config.local_ramp,
            CacheLayer.REMOTE: config.remote_ramp,
        },
    )

gcache = GCache(GCacheConfig(cache_config_provider=config_provider))
```

Now you can:
- Increase TTLs during high load
- Kill a misbehaving cache instantly (set ramp to 0%)
- A/B test different caching strategies
- Roll out per-use-case without coordinated deploys

## Built-In Prometheus Metrics

Every GCache operation is instrumented:

```
gcache_request_counter      # Total cache requests
gcache_miss_counter         # Cache misses (by layer)
gcache_disabled_counter     # Requests skipped (with reason labels)
gcache_error_counter        # Errors during cache operations
gcache_invalidation_counter # Invalidation calls
gcache_get_timer            # Cache read latency
gcache_fallback_timer       # Underlying function latency
gcache_serialization_timer  # Pickle serialization time
gcache_size_histogram       # Cached value sizes
```

All metrics include `use_case` and `key_type` labels, so you can slice by specific caching scenarios:

```promql
# Cache hit rate for GetUserProfile
1 - (
  sum(rate(gcache_miss_counter{use_case="GetUserProfile"}[5m])) /
  sum(rate(gcache_request_counter{use_case="GetUserProfile"}[5m]))
)
```

## Handling Complex Function Arguments

Real functions have complex signatures. GCache provides tools to handle them:

```python
@gcache.cached(
    key_type="user_id",
    id_arg=("user", lambda u: u.id),  # Extract ID from User object
    arg_adapters={
        "filters": lambda f: f.to_cache_key(),  # Custom serialization
        "page": str,                             # Convert to string
    },
    ignore_args=["db_session", "logger"],        # Exclude from cache key
)
async def search_user_posts(
    user: User,
    filters: SearchFilters,
    page: int,
    db_session: Session,
    logger: Logger,
) -> list[Post]:
    return await db.search(user.id, filters, page)

# Cache key: urn:gcache:user_id:123?filters=status:active&page=2#search_user_posts
```

The `id_arg` can be a simple string for direct arguments, or a tuple with an extractor function for nested values. The `arg_adapters` transform complex objects into cache key components. The `ignore_args` skip infrastructure objects that shouldn't affect caching.

## Sync and Async Transparency

GCache handles both sync and async functions:

```python
@gcache.cached(key_type="user_id", id_arg="user_id", use_case="GetUser")
def get_user_sync(user_id: str) -> User:
    return db.fetch_user(user_id)

@gcache.cached(key_type="user_id", id_arg="user_id", use_case="GetUserAsync")
async def get_user_async(user_id: str) -> User:
    return await db.fetch_user(user_id)
```

For sync functions called from async contexts, GCache runs them in a dedicated thread pool to avoid blocking the event loop.

## Fail Open by Design

Cache failures should never break your application. GCache is designed to fail open:

- If Redis is down → Execute the underlying function
- If serialization fails → Execute the underlying function
- If the config provider errors → Use default config or skip cache

Every failure increments `gcache_error_counter` with detailed labels, so you'll know something's wrong—but your users won't.

## Getting Started

Install from PyPI:

```bash
pip install gcache
```

Basic setup:

```python
from gcache import GCache, GCacheConfig, GCacheKeyConfig, CacheLayer

# Initialize (local-only caching)
gcache = GCache(GCacheConfig())

# Or with Redis
gcache = GCache(
    GCacheConfig(
        redis_config=RedisConfig(host="redis.example.com", port=6379),
    )
)

# Decorate your functions
@gcache.cached(
    key_type="user_id",
    id_arg="user_id",
    use_case="GetUser",
    default_config=GCacheKeyConfig(
        ttl_sec={CacheLayer.LOCAL: 300, CacheLayer.REMOTE: 3600},
        ramp={CacheLayer.LOCAL: 100, CacheLayer.REMOTE: 100},
    ),
)
async def get_user(user_id: str) -> dict:
    return await fetch_from_database(user_id)

# Use in your application
with gcache.enable():
    user = await get_user("user-123")
```

## Conclusion

Caching is one of those "simple" problems that becomes complex at scale. GCache embodies the lessons we learned the hard way:

1. **Make caching opt-in** so developers think about context
2. **Use structured keys** so debugging is possible
3. **Support gradual rollout** so adding caching isn't scary
4. **Build in observability** so you know what's happening
5. **Fail open** so cache problems don't become user problems

GCache is [open source on GitHub](https://github.com/rungalileo/gcache). We'd love your feedback, contributions, and stories about your own caching adventures.

---

*GCache is maintained by the Galileo engineering team. We're building tools to help ML teams ship better models faster. If that sounds interesting, [we're hiring](https://rungalileo.io/careers).*
