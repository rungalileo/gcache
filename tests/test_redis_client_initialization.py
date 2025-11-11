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
