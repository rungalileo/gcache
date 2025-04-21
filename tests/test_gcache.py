import json
import threading
from collections.abc import Generator
from random import random

import pytest
import redislite
from prometheus_client import generate_latest

from cachegalileo.base import (
    CacheController,
    CacheLayer,
    Fallback,
    GCache,
    GCacheAlreadyInstantiated,
    GCacheConfig,
    GCacheKey,
    GCacheKeyConfig,
    LocalCache,
    RedisConfig,
    UseCaseIsAlreadyRegistered,
    UseCaseNameIsReserved,
)
from tests.conftest import FakeCacheConfigProvider

from .conftest import REDIS_PORT


def get_func_metric(name: str) -> float:
    metrics = generate_latest().decode("utf-8")
    for line in metrics.split("\n"):
        if line.startswith(name):
            return float(line.split(" ")[-1])
    return 0


def test_gcache_sync(gcache: GCache, redis_server: redislite.Redis, reset_prometheus_registry: Generator) -> None:
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

        # When we disable cache then we should get fresh value.
        with gcache.enable(False):
            assert cached_func() == 10

        # When we are back in the enabled contextg we should still get cached value
        assert cached_func() == 5

        # When we call with different arg then we should get fresh value.
        assert cached_func(test=124) == 10

    # We should have count 3 for disableed metric since we made 3 calls when gcache was disabled.
    assert get_func_metric("api_gcache_disabled_counter") == 3

    # We should have 2 keys.  One for 123 and one for 124 args.
    keys = redis_server.keys()
    assert len(keys) == 2


@pytest.mark.asyncio
async def test_gcache_async(
    gcache: GCache, redis_server: redislite.Redis, reset_prometheus_registry: Generator
) -> None:
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

        # When we disable cache then we should get fresh value.
        with gcache.enable(False):
            assert await cached_func() == 10

        # When we are back in the enabled contextg we should still get cached value
        assert await cached_func() == 5

        # When we call with different arg then we should get fresh value.
        assert await cached_func(test=124) == 10

    # We should have count 3 for disableed metric since we made 3 calls when gcache was disabled.
    assert get_func_metric("api_gcache_disabled_counter") == 3

    # We should have 2 keys.  One for 123 and one for 124 args.
    keys = redis_server.keys()
    assert len(keys) == 2


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


def test_key_arg_does_not_exist(gcache: GCache, reset_prometheus_registry: Generator) -> None:
    with gcache.enable():
        # Given: Function that is cached, but id arg is incorrect
        @gcache.cached(key_type="Test", id_arg="doesnt_exist", use_case="cached_func")
        def cached_func(test: int = 123) -> int:
            return 0

        # When: Function is called
        # Then: Fallback is used
        0 == cached_func()

        # Then: Error counter is incremented
        assert 1 == get_func_metric("api_gcache_error_counter_total")


def test_reserved_use_case_name(gcache: GCache) -> None:
    with pytest.raises(UseCaseNameIsReserved):
        with gcache.enable():

            @gcache.cached(key_type="Test", id_arg="test", use_case="watermark")
            def cached_func(test: int = 123) -> int:
                return 0

            cached_func()


def test_missing_key_config(
    gcache: GCache,
    cache_config_provider: FakeCacheConfigProvider,
    redis_server: redislite.Redis,
    reset_prometheus_registry: Generator,
) -> None:
    with gcache.enable():
        cache_config_provider.configs["cached_func"] = None

        @gcache.cached(key_type="Test", id_arg="test", use_case="cached_func")
        def cached_func(test: int = 123) -> int:
            return 0

        cached_func()

        assert 1 == get_func_metric(
            'api_gcache_disabled_counter_total{key_type="Test",layer="REMOTE",reason="missing_config",use_case="cached_func"}'
        )
        assert 0 == len(redis_server.keys())


@pytest.mark.parametrize("layer", [CacheLayer.LOCAL, CacheLayer.REMOTE])
def test_missing_key_config_ttl(
    gcache: GCache,
    cache_config_provider: FakeCacheConfigProvider,
    redis_server: redislite.Redis,
    reset_prometheus_registry: Generator,
    layer: CacheLayer,
) -> None:
    with gcache.enable():
        cache_config_provider.configs["cached_func"] = GCacheKeyConfig.enabled(60, "cached_func")
        del cache_config_provider.configs["cached_func"].ttl_sec[layer]

        @gcache.cached(key_type="Test", id_arg="test", use_case="cached_func")
        def cached_func(test: int = 123) -> int:
            return 0

        cached_func()

        assert 1 == get_func_metric(
            'api_gcache_disabled_counter_total{key_type="Test",layer="%s",reason="missing_config",use_case="cached_func"}'  # noqa: UP031
            % (layer.name)  # noqa: UP031
        )


@pytest.mark.parametrize("layer", [CacheLayer.LOCAL, CacheLayer.REMOTE])
def test_missing_key_config_ramp(
    gcache: GCache,
    cache_config_provider: FakeCacheConfigProvider,
    redis_server: redislite.Redis,
    reset_prometheus_registry: Generator,
    layer: CacheLayer,
) -> None:
    with gcache.enable():
        cache_config_provider.configs["cached_func"] = GCacheKeyConfig.enabled(60, "cached_func")
        del cache_config_provider.configs["cached_func"].ramp[layer]

        @gcache.cached(key_type="Test", id_arg="test", use_case="cached_func")
        def cached_func(test: int = 123) -> int:
            return 0

        cached_func()

        assert 1 == get_func_metric(
            'api_gcache_disabled_counter_total{key_type="Test",layer="%s",reason="missing_config",use_case="cached_func"}'  # noqa: UP031
            % (layer.name)  # noqa: UP031
        )


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

        assert 0 == cached_func()
        assert 1 == get_func_metric("api_gcache_error_counter_total")


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


def test_id_arg_also_in_args(gcache: GCache, redis_server: redislite.Redis) -> None:
    # Given: A function where we want id arg to also be part of args because we want to extract different value.
    @gcache.cached(key_type="Test", id_arg="a", arg_adapters={"a": lambda _: "foo"})
    def cached_func(a: int) -> int:
        return 0

    # When: We call the cached func.
    with gcache.enable():
        cached_func(123)

    # Then: We should generate a new key where id_arg is 123 but the key also has a as an arg with value foo
    keys = keys = redis_server.keys("*")
    assert b"urn:galileo:test:Test:123?a=foo#tests.test_gcache.cached_func" in keys


def test_config_serialization_deserialization() -> None:
    # Test that we can dump a key to json and then load it either from a string of json itself, or from a dict.
    configs = {
        "old_schema_use_case": GCacheKeyConfig(
            ttl_sec={"local": 10, "remote": 1},
            ramp={"local": 0, "remote": 0},
        ),
        "defaults": {
            "test": GCacheKeyConfig(
                ttl_sec={"local": 5, "remote": 6},
                ramp={"local": 100, "remote": 100},
            ),
        },
        "customer_foo": {
            "test": GCacheKeyConfig(
                ttl_sec={"local": 7, "remote": 8},
                ramp={"local": 0, "remote": 0},
            ),
        },
    }

    # In previous release the gcache key configs were encoded as a string instead of dict, so we can test if
    # new approach will parse older format correctly.
    old_config_json = """
{
    "old_schema_use_case": "{\\"ttl_sec\\": {\\"local\\": 10, \\"remote\\": 1}, \\"ramp\\": {\\"local\\": 0, \\"remote\\": 0}}",
    "defaults": {
        "test": "{\\"ttl_sec\\": {\\"local\\": 5, \\"remote\\": 6}, \\"ramp\\": {\\"local\\": 100, \\"remote\\": 100}}"
    },
    "customer_foo": {
        "test": "{\\"ttl_sec\\": {\\"local\\": 7, \\"remote\\": 8}, \\"ramp\\": {\\"local\\": 0, \\"remote\\": 0}}"
    }
}
    """

    json_str = GCacheKeyConfig.dump_configs(configs)  # type: ignore[arg-type]
    configs_deserialized = GCacheKeyConfig.load_configs(json_str)
    assert configs == configs_deserialized

    assert GCacheKeyConfig.load_configs(old_config_json) == configs


def test_preserve_func_metadata(gcache: GCache) -> None:
    class FooBar:
        @gcache.cached(key_type="Test", id_arg="test")
        def some_method(self, test: int = 123) -> int:
            return 123

    assert FooBar.some_method.__name__ == "some_method"


def test_preserve_func_metadata_async(gcache: GCache) -> None:
    class FooBar:
        @gcache.cached(key_type="Test", id_arg="test")
        async def some_method(self, test: int = 123) -> int:
            return 123

    assert FooBar.some_method.__name__ == "some_method"


def test_delete_key(gcache: GCache) -> None:
    """
    Test that we can manually delete a cache key
    :param gcache:
    :return:
    """
    v = 0

    @gcache.cached(key_type="Test", id_arg="test", use_case="cached_func")
    def cached_func(test: int = 123) -> int:
        nonlocal v
        return v

    with gcache.enable():
        assert 0 == cached_func()
        v = 10
        assert 0 == cached_func()

        gcache.delete(GCacheKey(key_type="Test", id="123", use_case="cached_func"))

        assert 10 == cached_func()


@pytest.mark.asyncio
async def test_serialization_instrumentation(
    gcache: GCache, cache_config_provider: FakeCacheConfigProvider, reset_prometheus_registry: Generator
) -> None:
    # Given: A cached function with local layer turned off.
    cache_config_provider.configs["cached_func"] = GCacheKeyConfig.enabled(60, "cached_func")
    cache_config_provider.configs["cached_func"].ramp[CacheLayer.LOCAL] = 0

    @gcache.cached(key_type="Test", id_arg="test", use_case="cached_func")
    async def cached_func(test: int = 123) -> str:
        return "foobar"

    # When: We call it twice in a row.
    with gcache.enable():
        await cached_func(123)
        await cached_func(123)

    # Then: we should have recorded some store/load metrics.
    assert (
        get_func_metric(
            'api_gcache_serialization_timer_bucket{key_type="Test",layer="REMOTE",le="+Inf",operation="dump",use_case="cached_func"}'
        )
        == 1.0
    )
    assert (
        get_func_metric(
            'api_gcache_serialization_timer_bucket{key_type="Test",layer="REMOTE",le="+Inf",operation="load",use_case="cached_func"}'
        )
        == 1.0
    )
