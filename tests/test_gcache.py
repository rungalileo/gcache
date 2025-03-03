import json
import threading
from random import random

import pytest
import redislite

from cachegalileo.base import (
    CacheController,
    CacheLayer,
    Fallback,
    GCache,
    GCacheAlreadyInstantiated,
    GCacheConfig,
    GCacheKey,
    GCacheKeyConfig,
    GCacheKeyConstructionError,
    KeyArgDoesNotExist,
    LocalCache,
    MissingKeyConfig,
    RedisConfig,
    UseCaseIsAlreadyRegistered,
    UseCaseNameIsReserved,
)
from tests.conftest import FakeCacheConfigProvider

from .conftest import REDIS_PORT


def test_gcache_sync(gcache: GCache) -> None:
    v: int = 0

    @gcache.cached(key_type="Test", id_arg="test")
    def cached_func(test: int = 123) -> int:
        nonlocal v
        return v

    # With cache disabled, the function should return updated values
    assert cached_func() == 0
    v = 5
    assert cached_func() == 5

    # With cache enabled, the function should return cached values
    with gcache.enable():
        print("In test", threading.current_thread().name)
        assert cached_func() == 5

        v = 10

        assert cached_func() == 5

        # When we call with different arg then we should get fresh value.
        assert cached_func(test=124) == 10


@pytest.mark.asyncio
async def test_gcache_async(gcache: GCache, redis_server: redislite.Redis) -> None:
    v: int = 0

    @gcache.cached(key_type="Test", id_arg="test")
    async def cached_func(test: int = 123) -> int:
        nonlocal v
        return v

    # With cache disabled, the function should return updated values
    assert await cached_func() == 0
    v = 5
    assert await cached_func() == 5

    # With cache enabled, the function should return cached values
    with gcache.enable():
        print("In test", threading.current_thread().name)
        assert await cached_func() == 5

        v = 10

        assert await cached_func() == 5

    keys = redis_server.keys()
    assert len(keys) == 1


def test_caching_func_with_args(gcache: GCache) -> None:
    v: int = 0

    @gcache.cached(key_type="Test", id_arg="test", ignore_args=["b"])
    def cached_func(test: int = 123, a: int = 1, b: int = 2) -> int:
        nonlocal v
        return v

    with gcache.enable():
        assert cached_func(a=1, b=1) == 0

        v = 10

        assert cached_func(a=1, b=1) == 0
        assert cached_func(a=2, b=1) == 10
        assert cached_func(a=1, b=2) == 0


def test_caching_func_with_arg_adapter(gcache: GCache) -> None:
    v: int = 0

    @gcache.cached(key_type="Test", id_arg="test", arg_adapters={"a": lambda x: x["foo"]})
    def cached_func(test: int, a: dict) -> int:
        nonlocal v
        return v

    with gcache.enable():
        assert cached_func(1, {"foo": 1, "bar": 1}) == 0

        v = 10

        assert cached_func(1, {"foo": 1, "bar": 1}) == 0

        assert cached_func(1, {"foo": 1, "bar": 5}) == 0

        assert cached_func(1, {"foo": 2, "bar": 5}) == 10


def test_id_arg_adapter(gcache: GCache) -> None:
    v: int = 0

    @gcache.cached(key_type="Test", id_arg=("test", lambda x: x["foo"]))
    def cached_func(test: dict) -> int:
        nonlocal v
        return v

    with gcache.enable():
        assert cached_func({"foo": 1, "bar": 1}) == 0

        v = 10

        assert cached_func({"foo": 1, "bar": 1}) == 0
        assert cached_func({"foo": 1, "bar": 123}) == 0

        assert cached_func({"foo": 2, "bar": 123}) == 10


def test_cache_ramp(gcache: GCache, cache_config_provider: FakeCacheConfigProvider) -> None:
    v: int = 0

    @gcache.cached(key_type="Test", id_arg="test", use_case="cached_func")
    def cached_func(test: int = 123) -> int:
        nonlocal v
        return v

    with gcache.enable():
        assert cached_func() == 0

        v = 5

        assert cached_func() == 0

        # We ramp down cache
        cache_config_provider.configs["cached_func"] = GCacheKeyConfig(
            use_case="cached_func",
            ttl_sec={CacheLayer.LOCAL: 1, CacheLayer.REMOTE: 1},
            ramp={CacheLayer.LOCAL: 0, CacheLayer.REMOTE: 0},
        )

        # We don't cache anymore
        assert cached_func() == 5


def test_duplicate_use_cases(gcache: GCache) -> None:
    @gcache.cached(key_type="Test", id_arg="test", use_case="cached_func")
    def cached_func(test: int = 123) -> int:
        return 0

    with pytest.raises(UseCaseIsAlreadyRegistered):

        @gcache.cached(key_type="Test", id_arg="test", use_case="cached_func")
        def another_cached_func(test: int = 123) -> int:
            return 0


def test_key_arg_does_not_exist(gcache: GCache) -> None:
    with pytest.raises(KeyArgDoesNotExist):
        with gcache.enable():

            @gcache.cached(key_type="Test", id_arg="doesnt_exist", use_case="cached_func")
            def cached_func(test: int = 123) -> int:
                return 0

            cached_func()


def test_reserved_use_case_name(gcache: GCache) -> None:
    with pytest.raises(UseCaseNameIsReserved):
        with gcache.enable():

            @gcache.cached(key_type="Test", id_arg="test", use_case="watermark")
            def cached_func(test: int = 123) -> int:
                return 0

            cached_func()


def test_missing_key_config(gcache: GCache, cache_config_provider: FakeCacheConfigProvider) -> None:
    with pytest.raises(MissingKeyConfig):
        with gcache.enable():
            cache_config_provider.configs["cached_func"] = None

            @gcache.cached(key_type="Test", id_arg="test", use_case="cached_func")
            def cached_func(test: int = 123) -> int:
                return 0

            cached_func()


def test_error_in_fallback(gcache: GCache) -> None:
    with pytest.raises(KeyError):
        with gcache.enable():

            @gcache.cached(key_type="Test", id_arg="test", use_case="cached_func")
            def cached_func(test: int = 123) -> int:
                raise KeyError("foo")

            cached_func()


def test_error_in_cache(gcache: GCache, cache_config_provider: FakeCacheConfigProvider) -> None:
    class FailingCache(LocalCache):
        async def get(self, key: GCacheKey, fallback: Fallback) -> None:
            raise Exception("I'm giving up!")

    gcache._cache = CacheController(FailingCache(cache_config_provider), cache_config_provider)  # type: ignore[assignment]

    with gcache.enable():

        @gcache.cached(key_type="Test", id_arg="test", use_case="cached_func")
        def cached_func(test: int = 123) -> str:
            return "IM ALIVE"

        assert "IM ALIVE" == cached_func()


def test_default_key_config(gcache: GCache, cache_config_provider: FakeCacheConfigProvider) -> None:
    with gcache.enable():
        cache_config_provider.configs["cached_func"] = None

        @gcache.cached(
            key_type="Test",
            id_arg="test",
            use_case="cached_func",
            default_config=GCacheKeyConfig.enabled(60, "cached_func"),
        )
        def cached_func(test: int = 123) -> int:
            return 0

        cached_func()


@pytest.mark.skip
@pytest.mark.asyncio
async def test_high_load_async(gcache: GCache, cache_config_provider: FakeCacheConfigProvider) -> None:
    cache_config_provider.configs["cached_func"] = GCacheKeyConfig.enabled(60, "cached_func")

    @gcache.cached(key_type="test", id_arg="test", use_case="cached_func")
    async def cached_func(test: int = 123) -> int:
        return 0

    with gcache.enable():
        for i in range(100_000):
            await cached_func(int(random() * 100))


@pytest.mark.skip
def test_high_load(gcache: GCache, cache_config_provider: FakeCacheConfigProvider) -> None:
    cache_config_provider.configs["cached_func"] = GCacheKeyConfig.enabled(60, "cached_func")

    @gcache.cached(key_type="test", id_arg="test", use_case="cached_func")
    def cached_func(test: int = 123) -> int:
        return test

    with gcache.enable():
        for i in range(100_000):
            cached_func(int(random() * 100))


def test_invalidation(gcache: GCache, cache_config_provider: FakeCacheConfigProvider) -> None:
    v: int = 0

    config = GCacheKeyConfig.enabled(3600, "cached_func")
    config.ramp[CacheLayer.LOCAL] = 0

    cache_config_provider.configs["cached_func"] = config

    @gcache.cached(
        key_type="Test",
        id_arg="test",
        use_case="cached_func",
        track_for_invalidation=True,
    )
    def cached_func(test: int = 123) -> int:
        nonlocal v
        return v

    with gcache.enable():
        assert 0 == cached_func()

        v = 10

        assert 0 == cached_func()

        gcache.invalidate("Test", "123")

        assert 10 == cached_func()


def test_enforce_singleton(gcache: GCache, cache_config_provider: FakeCacheConfigProvider) -> None:
    with pytest.raises(GCacheAlreadyInstantiated):
        GCache(GCacheConfig(cache_config_provider=cache_config_provider))


def test_key_lambda_fail(gcache: GCache) -> None:
    with gcache.enable():

        @gcache.cached(key_type="Test", id_arg=("test", lambda x: x["a"]))
        def cached_func(test: int = 123) -> int:
            return 0

        with pytest.raises(GCacheKeyConstructionError):
            cached_func()


@pytest.mark.asyncio
async def test_do_not_write_if_invalidated(
    gcache: GCache, cache_config_provider: FakeCacheConfigProvider, redis_server: redislite.Redis
) -> None:
    with gcache.enable():
        # Given: We have a function that is cached and tracked for invalidation.

        @gcache.cached(key_type="Test", id_arg="test", track_for_invalidation=True)
        async def cached_func(test: int) -> int:
            return 0

        # When: We invalidate it and then invoke it.
        await gcache.ainvalidate("Test", "123", 1000)

        await cached_func(123)

        # Then: We should not write cache to Redis, only the watermark entry should exist.
        keys = redis_server.keys()
        assert 1 == len(keys)
        assert keys[0] == b"{urn:galileo:test:Test:123}#watermark"


@pytest.mark.asyncio
async def test_flush_all(gcache: GCache, redis_server: redislite.Redis) -> None:
    with gcache.enable():
        v = 0

        # Given: A  cached function in both layers.
        @gcache.cached(key_type="Test", id_arg="test")
        async def cached_func(test: int = 123) -> int:
            nonlocal v
            return v

        # When: We first invoke it then we should hit source of truth and populate the cache.
        assert 0 == await cached_func()

        # When: We update the value to return in SoT.
        v = 10

        # Then: We should still be getting cached value back.
        assert 0 == await cached_func()

        # When: We flush all caches.
        await gcache.aflushall()

        # Then: There should be no keys in redis.
        redis_keys = redis_server.keys()
        assert 0 == len(redis_keys)

        # Then: Cached function should also return SoT.
        assert 10 == await cached_func()


def test_gcache_serialize() -> None:
    # Test that we can dump a key to json and then load it either from a string of json itself, or from a dict.
    key = GCacheKeyConfig.enabled(10, "test")

    json_str = key.dumps()

    key2 = GCacheKeyConfig.loads(json_str)

    key3 = GCacheKeyConfig.loads(json.loads(json_str))

    assert key == key2

    assert key == key3


@pytest.mark.parametrize("redis_config", [RedisConfig(port=REDIS_PORT - 1), None])
def test_redis_down(
    cache_config_provider: FakeCacheConfigProvider, redis_server: redislite.Redis, redis_config: RedisConfig | None
) -> None:
    redis_server.flushall()

    gcache = GCache(
        GCacheConfig(
            cache_config_provider=cache_config_provider, urn_prefix="urn:galileo:test", redis_config=redis_config
        )
    )
    try:

        @gcache.cached(
            key_type="Test", id_arg="foo", use_case="test", default_config=GCacheKeyConfig.enabled(60, "test")
        )
        def cached_func(foo: int) -> int:
            return 123

        with gcache.enable():
            assert 123 == cached_func(foo=7)

        assert 0 == len(redis_server.keys())

    finally:
        gcache.__del__()