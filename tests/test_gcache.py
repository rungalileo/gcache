import json
import pickle
import threading
from collections.abc import Generator
from random import random
from typing import Any

import pytest
import redislite
from prometheus_client import generate_latest

from gcache import (
    CacheLayer,
    GCache,
    GCacheConfig,
    GCacheKey,
    GCacheKeyConfig,
    RedisConfig,
)
from gcache._internal.cache_interface import Fallback
from gcache._internal.local_cache import LocalCache
from gcache._internal.wrappers import CacheController
from gcache.config import Serializer
from gcache.exceptions import (
    GCacheAlreadyInstantiated,
    ReentrantSyncFunctionDetected,
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
        cache_config_provider.configs["cached_func"] = GCacheKeyConfig.enabled(60)
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
        cache_config_provider.configs["cached_func"] = GCacheKeyConfig.enabled(60)
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
            default_config=GCacheKeyConfig.enabled(60),
        )
        def cached_func(test: int = 123) -> int:
            return 0

        cached_func()


@pytest.mark.skip
@pytest.mark.asyncio
async def test_high_load_async(gcache: GCache, cache_config_provider: FakeCacheConfigProvider) -> None:
    cache_config_provider.configs["cached_func"] = GCacheKeyConfig.enabled(60)

    @gcache.cached(key_type="test", id_arg="test", use_case="cached_func")
    async def cached_func(test: int = 123) -> int:
        return 0

    with gcache.enable():
        for i in range(100_000):
            await cached_func(int(random() * 100))


@pytest.mark.skip
def test_high_load(gcache: GCache, cache_config_provider: FakeCacheConfigProvider) -> None:
    cache_config_provider.configs["cached_func"] = GCacheKeyConfig.enabled(60)

    @gcache.cached(key_type="test", id_arg="test", use_case="cached_func")
    def cached_func(test: int = 123) -> int:
        return test

    with gcache.enable():
        for i in range(100_000):
            cached_func(int(random() * 100))


def test_invalidation(gcache: GCache, cache_config_provider: FakeCacheConfigProvider) -> None:
    v: int = 0

    config = GCacheKeyConfig.enabled(3600)
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
    key = GCacheKeyConfig.enabled(10)

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

        @gcache.cached(key_type="Test", id_arg="foo", use_case="test", default_config=GCacheKeyConfig.enabled(60))
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
    cache_config_provider.configs["cached_func"] = GCacheKeyConfig.enabled(60)
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


@pytest.mark.asyncio
async def test_custom_serializer(
    gcache: GCache, redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # Given: A cached function with local layer turned off.
    # and a custom serializer which will always load and dump values that are actually different
    # from what is returned from cached func.
    cache_config_provider.configs["cached_func"] = GCacheKeyConfig.enabled(60)
    cache_config_provider.configs["cached_func"].ramp[CacheLayer.LOCAL] = 0

    class CustomSerializer(Serializer):
        async def dump(self, obj: Any) -> bytes | str:
            return b"baz"

        async def load(self, data: bytes | str) -> Any:
            return "behhh"

    @gcache.cached(key_type="Test", id_arg="test", use_case="cached_func", serializer=CustomSerializer())
    async def cached_func(test: int = 123) -> str:
        return "foobar"

    with gcache.enable():
        # When: We call cached func first time, we should get the right value back.
        assert "foobar" == await cached_func(123)
        # We should store "baz" as payload in redis.
        keys = redis_server.keys()
        assert pickle.loads(redis_server.get(keys[0])).payload == b"baz"
        # When: We call twice we should get "behhh" back because we hardcoded it in serializer.
        assert "behhh" == await cached_func(123)


@pytest.mark.asyncio
async def test_large_payload(
    gcache: GCache, reset_prometheus_registry: Generator, cache_config_provider: FakeCacheConfigProvider
) -> None:
    # Test async unpickling for larger objects.
    # Given: A cached function which returns a large payload (50k+ bytes)
    cache_config_provider.configs["cached_func"] = GCacheKeyConfig.enabled(60)
    cache_config_provider.configs["cached_func"].ramp[CacheLayer.LOCAL] = 0

    @gcache.cached(key_type="Test", id_arg="test", use_case="cached_func")
    async def cached_func(test: int = 123) -> str:
        return "f" * 100_000

    with gcache.enable():
        # When we invoke the function twice we should not get errors
        await cached_func(123)
        assert "f" * 100_000 == await cached_func(123)

        assert get_func_metric("api_gcache_error_counter_total") == 0.0


def test_recursive_caching(gcache: GCache) -> None:
    @gcache.cached(key_type="Test", id_arg="test")
    def cached_func_a(test: int) -> str:
        return "foo"

    @gcache.cached(key_type="Test", id_arg="test")
    def cached_func(test: int = 123) -> str:
        return cached_func_a(test)

    with gcache.enable():
        with pytest.raises(ReentrantSyncFunctionDetected):
            cached_func()


# =============================================================================
# Metrics tests
# =============================================================================


@pytest.mark.asyncio
async def test_miss_counter_incremented(
    gcache: GCache, reset_prometheus_registry: Generator, cache_config_provider: FakeCacheConfigProvider
) -> None:
    """Test that api_gcache_miss_counter is incremented on cache miss."""
    cache_config_provider.configs["test_miss"] = GCacheKeyConfig.enabled(60)

    @gcache.cached(key_type="Test", id_arg="test", use_case="test_miss")
    async def cached_func(test: int) -> str:
        return "value"

    with gcache.enable():
        # First call is a cache miss
        await cached_func(1)
        # Check miss counter was incremented (both LOCAL and REMOTE layers)
        miss_count = get_func_metric(
            'api_gcache_miss_counter_total{key_type="Test",layer="LOCAL",use_case="test_miss"}'
        )
        assert miss_count >= 1.0


@pytest.mark.asyncio
async def test_request_counter_incremented(
    gcache: GCache, reset_prometheus_registry: Generator, cache_config_provider: FakeCacheConfigProvider
) -> None:
    """Test that api_gcache_request_counter is incremented on each request."""
    cache_config_provider.configs["test_request"] = GCacheKeyConfig.enabled(60)

    @gcache.cached(key_type="Test", id_arg="test", use_case="test_request")
    async def cached_func(test: int) -> str:
        return "value"

    with gcache.enable():
        # Make 3 requests
        await cached_func(1)
        await cached_func(1)  # cache hit
        await cached_func(2)  # different key, cache miss

        # Check request counter was incremented
        request_count = get_func_metric(
            'api_gcache_request_counter_total{key_type="Test",layer="LOCAL",use_case="test_request"}'
        )
        assert request_count == 3.0


@pytest.mark.asyncio
async def test_get_timer_records_observations(
    gcache: GCache, reset_prometheus_registry: Generator, cache_config_provider: FakeCacheConfigProvider
) -> None:
    """Test that api_gcache_get_timer histogram has observations."""
    cache_config_provider.configs["test_get_timer"] = GCacheKeyConfig.enabled(60)

    @gcache.cached(key_type="Test", id_arg="test", use_case="test_get_timer")
    async def cached_func(test: int) -> str:
        return "value"

    with gcache.enable():
        await cached_func(1)

        # Check histogram has observations (using +Inf bucket which counts all)
        timer_count = get_func_metric(
            'api_gcache_get_timer_bucket{key_type="Test",layer="LOCAL",le="+Inf",use_case="test_get_timer"}'
        )
        assert timer_count >= 1.0


@pytest.mark.asyncio
async def test_fallback_timer_records_observations(
    gcache: GCache, reset_prometheus_registry: Generator, cache_config_provider: FakeCacheConfigProvider
) -> None:
    """Test that api_gcache_fallback_timer histogram has observations on cache miss."""
    cache_config_provider.configs["test_fallback_timer"] = GCacheKeyConfig.enabled(60)

    @gcache.cached(key_type="Test", id_arg="test", use_case="test_fallback_timer")
    async def cached_func(test: int) -> str:
        return "value"

    with gcache.enable():
        # First call triggers fallback (source of truth call)
        await cached_func(1)

        # Check fallback timer histogram has observations (includes layer label)
        timer_count = get_func_metric(
            'api_gcache_fallback_timer_bucket{key_type="Test",layer="REMOTE",le="+Inf",use_case="test_fallback_timer"}'
        )
        assert timer_count >= 1.0


@pytest.mark.asyncio
async def test_size_histogram_records_on_put(
    gcache: GCache, reset_prometheus_registry: Generator, cache_config_provider: FakeCacheConfigProvider
) -> None:
    """Test that api_gcache_size_histogram records size when caching values (REMOTE layer only)."""
    cache_config_provider.configs["test_size"] = GCacheKeyConfig.enabled(60)

    @gcache.cached(key_type="Test", id_arg="test", use_case="test_size")
    async def cached_func(test: int) -> str:
        return "some_value_to_cache"

    with gcache.enable():
        await cached_func(1)

        # Check size histogram has observations (REMOTE layer only - size tracked on Redis put)
        size_count = get_func_metric(
            'api_gcache_size_histogram_bucket{key_type="Test",layer="REMOTE",le="+Inf",use_case="test_size"}'
        )
        assert size_count >= 1.0


@pytest.mark.asyncio
async def test_invalidation_counter_incremented(
    gcache: GCache, reset_prometheus_registry: Generator, cache_config_provider: FakeCacheConfigProvider
) -> None:
    """Test that api_gcache_invalidation_counter is incremented on invalidation."""
    cache_config_provider.configs["test_invalidation"] = GCacheKeyConfig.enabled(60)

    @gcache.cached(key_type="Test", id_arg="test", use_case="test_invalidation", track_for_invalidation=True)
    async def cached_func(test: int) -> str:
        return "value"

    with gcache.enable():
        # Cache a value first
        await cached_func(123)

        # Invalidate
        await gcache.ainvalidate("Test", "123")

        # Check invalidation counter was incremented (REMOTE layer)
        invalidation_count = get_func_metric('api_gcache_invalidation_counter_total{key_type="Test",layer="REMOTE"}')
        assert invalidation_count >= 1.0
