from random import random

import pytest
import threading

from gcache.gcache import (
    CacheLayer,
    GCacheKeyConfig,
    UseCaseIsAlreadyRegistered,
    KeyArgDoesNotExist,
    UseCaseNameIsReserved,
    MissingKeyConfig,
    CacheController,
    Fallback,
    GCacheKey,
    LocalCache,
    GCacheAlreadyInstantiated,
    GCacheConfig,
    GCache,
    GCacheKeyConstructionError,
)


@pytest.mark.asyncio
def test_gcache_sync(gcache):
    v = 0

    @gcache.cached(key_type="Test", id_arg="test")
    def cached_func(test=123):
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
async def test_gcache_async(gcache):
    v = 0

    @gcache.cached(key_type="Test", id_arg="test")
    async def cached_func(test=123):
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


def test_caching_func_with_args(gcache):
    v = 0

    @gcache.cached(key_type="Test", id_arg="test", ignore_args=["b"])
    def cached_func(test=123, a=1, b=2):
        nonlocal v
        return v

    with gcache.enable():
        assert cached_func(a=1, b=1) == 0

        v = 10

        assert cached_func(a=1, b=1) == 0
        assert cached_func(a=2, b=1) == 10
        assert cached_func(a=1, b=2) == 0


def test_caching_func_with_arg_adapter(gcache):
    v = 0

    @gcache.cached(
        key_type="Test", id_arg="test", arg_adapters={"a": lambda x: x["foo"]}
    )
    def cached_func(test, a: dict):
        nonlocal v
        return v

    with gcache.enable():
        assert cached_func(1, {"foo": 1, "bar": 1}) == 0

        v = 10

        assert cached_func(1, {"foo": 1, "bar": 1}) == 0

        assert cached_func(1, {"foo": 1, "bar": 5}) == 0

        assert cached_func(1, {"foo": 2, "bar": 5}) == 10


def test_id_arg_adapter(gcache):
    v = 0

    @gcache.cached(key_type="Test", id_arg=("test", lambda x: x["foo"]))
    def cached_func(test: dict):
        nonlocal v
        return v

    with gcache.enable():
        assert cached_func({"foo": 1, "bar": 1}) == 0

        v = 10

        assert cached_func({"foo": 1, "bar": 1}) == 0
        assert cached_func({"foo": 1, "bar": 123}) == 0

        assert cached_func({"foo": 2, "bar": 123}) == 10


def test_cache_ramp(gcache, cache_config_provider):
    v = 0

    @gcache.cached(key_type="Test", id_arg="test", use_case="cached_func")
    def cached_func(test=123):
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


def test_duplicate_use_cases(gcache):
    @gcache.cached(key_type="Test", id_arg="test", use_case="cached_func")
    def cached_func(test=123):
        return 0

    with pytest.raises(UseCaseIsAlreadyRegistered):

        @gcache.cached(key_type="Test", id_arg="test", use_case="cached_func")
        def another_cached_func(test=123):
            return 0


def test_key_arg_does_not_exist(gcache):
    with pytest.raises(KeyArgDoesNotExist):
        with gcache.enable():

            @gcache.cached(
                key_type="Test", id_arg="doesnt_exist", use_case="cached_func"
            )
            def cached_func(test=123):
                return 0

            cached_func()


def test_reserved_use_case_name(gcache):
    with pytest.raises(UseCaseNameIsReserved):
        with gcache.enable():

            @gcache.cached(key_type="Test", id_arg="test", use_case="watermark")
            def cached_func(test=123):
                return 0

            cached_func()


def test_missing_key_config(gcache, cache_config_provider):
    with pytest.raises(MissingKeyConfig):
        with gcache.enable():
            cache_config_provider.configs["cached_func"] = None

            @gcache.cached(key_type="Test", id_arg="test", use_case="cached_func")
            def cached_func(test=123):
                return 0

            cached_func()


def test_error_in_fallback(gcache):
    with pytest.raises(KeyError):
        with gcache.enable():

            @gcache.cached(key_type="Test", id_arg="test", use_case="cached_func")
            def cached_func(test=123):
                raise KeyError("foo")

            cached_func()


def test_error_in_cache(gcache, cache_config_provider):
    class FailingCache(LocalCache):
        async def get(self, key: GCacheKey, fallback: Fallback):
            raise Exception("I'm giving up!")

    gcache.cache = CacheController(
        FailingCache(cache_config_provider), cache_config_provider
    )

    with gcache.enable():

        @gcache.cached(key_type="Test", id_arg="test", use_case="cached_func")
        def cached_func(test=123):
            return "IM ALIVE"

        assert "IM ALIVE" == cached_func()


def test_default_key_config(gcache, cache_config_provider):
    with gcache.enable():
        cache_config_provider.configs["cached_func"] = None

        @gcache.cached(
            key_type="Test",
            id_arg="test",
            use_case="cached_func",
            default_config=GCacheKeyConfig.enabled(60, "cached_func"),
        )
        def cached_func(test=123):
            return 0

        cached_func()


@pytest.mark.skip
@pytest.mark.asyncio
async def test_high_load_async(gcache, cache_config_provider):
    cache_config_provider.configs["cached_func"] = GCacheKeyConfig.enabled(
        60, "cached_func"
    )

    # cache_config_provider.configs["cached_func"].ramp[CacheLayer.LOCAL] = 0
    @gcache.cached(key_type="test", id_arg="test", use_case="cached_func")
    async def cached_func(test=123):
        return 0

    with gcache.enable():
        for i in range(100_000):
            await cached_func(int(random() * 100))


@pytest.mark.skip
def test_high_load(gcache, cache_config_provider):
    cache_config_provider.configs["cached_func"] = GCacheKeyConfig.enabled(
        60, "cached_func"
    )

    # cache_config_provider.configs["cached_func"].ramp[CacheLayer.LOCAL] = 0
    @gcache.cached(key_type="test", id_arg="test", use_case="cached_func")
    def cached_func(test=123):
        return 0

    with gcache.enable():
        for i in range(100_000):
            cached_func(int(random() * 100))


def test_invalidation(gcache, cache_config_provider):
    v = 0

    config = GCacheKeyConfig.enabled(3600, "cached_func")
    config.ramp[CacheLayer.LOCAL] = 0

    cache_config_provider.configs["cached_func"] = config

    @gcache.cached(
        key_type="Test",
        id_arg="test",
        use_case="cached_func",
        track_for_invalidation=True,
    )
    def cached_func(test=123):
        nonlocal v
        return v

    with gcache.enable():
        assert 0 == cached_func()

        v = 10

        assert 0 == cached_func()

        gcache.invalidate("Test", "123")

        assert 10 == cached_func()


def test_enforce_singleton(gcache, cache_config_provider):
    with pytest.raises(GCacheAlreadyInstantiated):
        GCache(GCacheConfig(cache_config_provider=cache_config_provider))


def test_key_lambda_failer(gcache):
    with gcache.enable():

        @gcache.cached(key_type="Test", id_arg=("test", lambda x: x["a"]))
        def cached_func(test=123):
            return 0

        with pytest.raises(GCacheKeyConstructionError):
            cached_func()
