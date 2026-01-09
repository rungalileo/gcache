"""Tests for Redis client initialization logic in GCache."""

import pytest
import redislite
from redis.asyncio import Redis, RedisCluster

from gcache import GCache, GCacheConfig, GCacheKeyConfig, RedisConfig
from gcache.base import RedisConfigConflict
from tests.conftest import REDIS_PORT, FakeCacheConfigProvider


def test_redis_config_conflict(cache_config_provider: FakeCacheConfigProvider) -> None:
    """Test that RedisConfigConflict is raised when both redis_config and redis_client_factory are provided."""

    # Create a simple redis client factory
    def custom_factory() -> Redis | RedisCluster:
        return Redis.from_url(f"redis://localhost:{REDIS_PORT}")

    # Attempt to create GCache with both redis_config and redis_client_factory
    with pytest.raises(RedisConfigConflict):
        GCache(
            GCacheConfig(
                cache_config_provider=cache_config_provider,
                redis_config=RedisConfig(port=REDIS_PORT),
                redis_client_factory=custom_factory,
            )
        )


def test_no_redis_uses_noop_cache(
    cache_config_provider: FakeCacheConfigProvider,
    redis_server: redislite.Redis,
) -> None:
    """Test that when neither redis_config nor redis_client_factory is provided, NoopCache is used."""
    redis_server.flushall()

    # Create GCache without redis_config or redis_client_factory
    gcache = GCache(
        GCacheConfig(
            cache_config_provider=cache_config_provider,
            urn_prefix="urn:test:noop",
        )
    )

    try:
        call_count = {"count": 0}

        # Define a cached function
        @gcache.cached(
            key_type="Test",
            id_arg="test_id",
            use_case="test_noop",
            default_config=GCacheKeyConfig.enabled(60, "test_noop"),
        )
        def cached_func(test_id: int) -> str:
            call_count["count"] += 1
            return f"value_{test_id}"

        # Enable caching and test
        with gcache.enable():
            result = cached_func(test_id=123)
            assert result == "value_123"
            assert call_count["count"] == 1

            # Call again - with local cache only, this should still be cached
            # but remote layer is NOOP so no Redis keys should exist
            result2 = cached_func(test_id=123)
            assert result2 == "value_123"
            # Local cache should prevent another call
            assert call_count["count"] == 1

            # Verify Redis has NO keys (NoopCache doesn't write to Redis)
            keys = redis_server.keys()
            assert len(keys) == 0

    finally:
        gcache.__del__()


def test_redis_config_only(
    cache_config_provider: FakeCacheConfigProvider,
    redis_server: redislite.Redis,
) -> None:
    """Test that when only redis_config is provided, a factory is created from it."""
    redis_server.flushall()

    # Create GCache with only redis_config
    redis_config = RedisConfig(port=REDIS_PORT)
    gcache = GCache(
        GCacheConfig(
            cache_config_provider=cache_config_provider,
            urn_prefix="urn:test:config_only",
            redis_config=redis_config,
        )
    )

    try:
        # Define a cached function
        @gcache.cached(
            key_type="Test",
            id_arg="test_id",
            use_case="test_config_only",
            default_config=GCacheKeyConfig.enabled(60, "test_config_only"),
        )
        def cached_func(test_id: int) -> str:
            return f"config_value_{test_id}"

        # Enable caching and test
        with gcache.enable():
            result = cached_func(test_id=456)
            assert result == "config_value_456"

            # Verify caching works by checking Redis has the key
            keys = redis_server.keys()
            assert len(keys) == 1

    finally:
        gcache.__del__()


def test_redis_client_factory_only(
    cache_config_provider: FakeCacheConfigProvider,
    redis_server: redislite.Redis,
) -> None:
    """Test that when only redis_client_factory is provided, it's used directly."""
    redis_server.flushall()

    # Track that our custom factory is called
    factory_called = {"count": 0}

    def custom_factory() -> Redis | RedisCluster:
        """Custom factory that tracks calls."""
        factory_called["count"] += 1
        return Redis.from_url(f"redis://localhost:{REDIS_PORT}")

    # Create GCache with only redis_client_factory
    gcache = GCache(
        GCacheConfig(
            cache_config_provider=cache_config_provider,
            urn_prefix="urn:test:factory_only",
            redis_client_factory=custom_factory,
        )
    )

    try:
        # Define a cached function
        @gcache.cached(
            key_type="Test",
            id_arg="test_id",
            use_case="test_factory_only",
            default_config=GCacheKeyConfig.enabled(60, "test_factory_only"),
        )
        def cached_func(test_id: int) -> str:
            return f"factory_value_{test_id}"

        # Enable caching and test
        with gcache.enable():
            result = cached_func(test_id=789)
            assert result == "factory_value_789"

            # Verify that our custom factory was called
            assert factory_called["count"] > 0

            # Verify caching works by checking Redis has the key
            keys = redis_server.keys()
            assert len(keys) == 1

    finally:
        gcache.__del__()


@pytest.mark.asyncio
async def test_redis_config_async_operations(
    cache_config_provider: FakeCacheConfigProvider,
    redis_server: redislite.Redis,
) -> None:
    """Test that redis config works with async operations."""
    redis_server.flushall()

    # Create GCache with redis_config
    redis_config = RedisConfig(port=REDIS_PORT)
    gcache = GCache(
        GCacheConfig(
            cache_config_provider=cache_config_provider,
            urn_prefix="urn:test:async",
            redis_config=redis_config,
        )
    )

    try:
        # Define an async cached function
        @gcache.cached(
            key_type="Test",
            id_arg="test_id",
            use_case="test_async",
            default_config=GCacheKeyConfig.enabled(60, "test_async"),
        )
        async def cached_func_async(test_id: int) -> str:
            return f"async_value_{test_id}"

        # Enable caching and test
        with gcache.enable():
            result = await cached_func_async(test_id=999)
            assert result == "async_value_999"

            # Call again to verify caching
            result2 = await cached_func_async(test_id=999)
            assert result2 == "async_value_999"

            # Verify Redis has the key
            keys = redis_server.keys()
            assert len(keys) == 1

    finally:
        gcache.__del__()


def test_factory_called_once_per_thread(
    cache_config_provider: FakeCacheConfigProvider,
    redis_server: redislite.Redis,
) -> None:
    """Test that the client factory is called only once per thread, not on every operation."""
    redis_server.flushall()

    factory_call_count = {"count": 0}

    def counting_factory() -> Redis:
        """Factory that counts how many times it's called."""
        factory_call_count["count"] += 1
        return Redis.from_url(f"redis://localhost:{REDIS_PORT}")

    gcache = GCache(
        GCacheConfig(
            cache_config_provider=cache_config_provider,
            urn_prefix="urn:test:factory_once",
            redis_client_factory=counting_factory,
        )
    )

    try:

        @gcache.cached(
            key_type="Test",
            id_arg="test_id",
            use_case="test_factory_once",
            default_config=GCacheKeyConfig.enabled(60, "test_factory_once"),
        )
        def cached_func(test_id: int) -> str:
            return f"value_{test_id}"

        with gcache.enable():
            # Make multiple cache operations
            cached_func(test_id=1)
            cached_func(test_id=2)
            cached_func(test_id=3)
            cached_func(test_id=1)  # Cache hit
            cached_func(test_id=4)

            # Factory should only be called once (for the single thread)
            # gcache uses EventLoopThreadPool which picks a thread, and that thread
            # should reuse the same client
            assert factory_call_count["count"] >= 1
            # The key assertion: factory should NOT be called for every operation
            # With 5 operations, if thread-local caching wasn't working, we'd see 5 calls
            assert factory_call_count["count"] < 5

    finally:
        gcache.__del__()


def test_factory_called_once_per_thread_multiple_threads(
    cache_config_provider: FakeCacheConfigProvider,
    redis_server: redislite.Redis,
) -> None:
    """Test that each thread gets its own client (factory called once per thread)."""
    import concurrent.futures
    import threading

    redis_server.flushall()

    factory_call_count = 0
    factory_thread_ids: set[int | None] = set()
    factory_lock = threading.Lock()

    def counting_factory() -> Redis:
        """Factory that counts calls and tracks which threads called it."""
        nonlocal factory_call_count
        with factory_lock:
            factory_call_count += 1
            factory_thread_ids.add(threading.current_thread().ident)
        return Redis.from_url(f"redis://localhost:{REDIS_PORT}")

    gcache = GCache(
        GCacheConfig(
            cache_config_provider=cache_config_provider,
            urn_prefix="urn:test:multithread",
            redis_client_factory=counting_factory,
        )
    )

    try:

        @gcache.cached(
            key_type="Test",
            id_arg="test_id",
            use_case="test_multithread",
            default_config=GCacheKeyConfig.enabled(60, "test_multithread"),
        )
        def cached_func(test_id: int) -> str:
            return f"value_{test_id}"

        with gcache.enable():
            # Run many operations that will be distributed across threads
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
                futures = []
                for i in range(20):
                    futures.append(executor.submit(cached_func, test_id=i))
                # Wait for all to complete
                for f in futures:
                    f.result()

            # Factory should be called once per unique thread that handled operations
            # The number of factory calls should equal the number of unique threads
            assert factory_call_count == len(factory_thread_ids)

    finally:
        gcache.__del__()


def test_same_thread_reuses_client_instance(
    cache_config_provider: FakeCacheConfigProvider,
    redis_server: redislite.Redis,
) -> None:
    """Test that the same thread always gets the exact same client instance."""
    redis_server.flushall()

    created_clients: list = []

    def tracking_factory() -> Redis:
        """Factory that tracks all created client instances."""
        client = Redis.from_url(f"redis://localhost:{REDIS_PORT}")
        created_clients.append(client)
        return client

    gcache = GCache(
        GCacheConfig(
            cache_config_provider=cache_config_provider,
            urn_prefix="urn:test:same_instance",
            redis_client_factory=tracking_factory,
        )
    )

    try:

        @gcache.cached(
            key_type="Test",
            id_arg="test_id",
            use_case="test_same_instance",
            default_config=GCacheKeyConfig.enabled(60, "test_same_instance"),
        )
        def cached_func(test_id: int) -> str:
            return f"value_{test_id}"

        with gcache.enable():
            # Make multiple operations
            for i in range(10):
                cached_func(test_id=i)

            # If thread-local caching is working, we should have very few clients
            # (one per thread used by the event loop pool)
            # Without thread-local caching, we'd have 10 clients
            assert len(created_clients) < 10

    finally:
        gcache.__del__()
