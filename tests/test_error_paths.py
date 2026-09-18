"""Tests for error paths and edge cases to improve coverage."""

import logging

import pytest
import redislite

from gcache import CacheLayer, GCache, GCacheConfig, GCacheKey, GCacheKeyConfig, RedisConfig
from gcache._internal.constants import WATERMARK_TTL_SECONDS, validate_invalidation_args
from gcache._internal.local_cache import LocalCache
from gcache._internal.noop_cache import NoopCache
from gcache._internal.redis_cache import RedisCache, create_default_redis_client_factory
from gcache._internal.state import _GLOBAL_GCACHE_STATE
from gcache.config import _default_config_provider
from gcache.exceptions import FuncArgDoesNotExist, GCacheDisabled, MissingKeyConfig
from tests.conftest import REDIS_PORT, FakeCacheConfigProvider


def test_exception_messages() -> None:
    """Test exception classes format messages correctly."""
    assert "my_arg" in str(FuncArgDoesNotExist("my_arg"))
    assert "disabled" in str(GCacheDisabled()).lower()
    assert "my_use_case" in str(MissingKeyConfig("my_use_case"))


def test_gcache_key_eq_and_str() -> None:
    """Test GCacheKey equality and string representation."""
    key = GCacheKey(key_type="Test", id="123", use_case="test")

    # __eq__ returns False for non-GCacheKey
    assert key != "not a key"
    assert key != 123
    assert key != None  # noqa: E711

    # __str__ returns urn
    assert str(key) == key.urn
    assert "Test:123" in str(key)


async def _async_fallback() -> str:
    return "value"


async def _null_config(key: GCacheKey) -> None:
    return None


@pytest.mark.asyncio
async def test_local_cache_delete_nonexistent_key() -> None:
    """Test LocalCache.delete returns False for non-existent key."""
    cache = LocalCache(_default_config_provider)
    key = GCacheKey(key_type="Test", id="123", use_case="test", default_config=GCacheKeyConfig.enabled(60))

    # Populate cache first (creates the TTLCache for this use_case)
    await cache.get(key, fallback=_async_fallback)

    # Delete a different key that doesn't exist
    other_key = GCacheKey(key_type="Test", id="other", use_case="test", default_config=GCacheKeyConfig.enabled(60))
    assert await cache.delete(other_key) is False


@pytest.mark.asyncio
async def test_local_cache_missing_config_raises() -> None:
    """Test LocalCache raises MissingKeyConfig when config is None."""
    cache = LocalCache(_null_config)  # type: ignore[arg-type]
    key = GCacheKey(key_type="Test", id="123", use_case="test")

    with pytest.raises(MissingKeyConfig):
        await cache.get(key, fallback=_async_fallback)


@pytest.mark.asyncio
async def test_redis_cache_put_missing_config(redis_server: redislite.Redis) -> None:
    """Test RedisCache.put raises MissingKeyConfig when config is None."""
    redis_server.flushall()
    factory = create_default_redis_client_factory(RedisConfig(port=REDIS_PORT))
    cache = RedisCache(_null_config, factory)  # type: ignore[arg-type]

    with pytest.raises(MissingKeyConfig):
        await cache.put(GCacheKey(key_type="Test", id="123", use_case="test"), "value")


@pytest.mark.asyncio
async def test_redis_cache_put_missing_ttl(gcache: GCache, redis_server: redislite.Redis) -> None:
    """Test RedisCache.put raises MissingKeyConfig when ttl is None for layer."""
    redis_server.flushall()

    config = GCacheKeyConfig(
        ttl_sec={CacheLayer.LOCAL: 60},  # Missing REMOTE
        ramp={CacheLayer.LOCAL: 100, CacheLayer.REMOTE: 100},
    )

    async def partial_config(key: GCacheKey) -> GCacheKeyConfig:
        return config

    factory = create_default_redis_client_factory(RedisConfig(port=REDIS_PORT))
    cache = RedisCache(partial_config, factory)

    with pytest.raises(MissingKeyConfig):
        await cache.put(GCacheKey(key_type="Test", id="123", use_case="test"), "value")


@pytest.mark.asyncio
async def test_noop_cache_put_and_delete() -> None:
    """Test NoopCache.put does nothing and delete returns False."""
    cache = NoopCache(_default_config_provider)
    key = GCacheKey(key_type="Test", id="123", use_case="test")

    await cache.put(key, "value")  # Should not raise
    assert await cache.delete(key) is False


@pytest.mark.asyncio
async def test_should_cache_config_error(gcache: GCache) -> None:
    """Test that config errors in _should_cache are handled gracefully."""
    gcache._local_cache.config_provider = lambda key: (_ for _ in ()).throw(RuntimeError("fail"))  # type: ignore[assignment, func-returns-value]

    @gcache.cached(key_type="Test", id_arg="test", use_case="test_config_error")
    async def cached_func(test: int) -> str:
        return "fallback_value"

    with gcache.enable():
        assert await cached_func(123) == "fallback_value"


def test_partial_ramp(gcache: GCache, cache_config_provider: FakeCacheConfigProvider) -> None:
    """Test ramp between 0 and 100 exercises random sampling path."""
    cache_config_provider.configs["test_partial_ramp"] = GCacheKeyConfig(
        ttl_sec={CacheLayer.LOCAL: 60, CacheLayer.REMOTE: 60},
        ramp={CacheLayer.LOCAL: 50, CacheLayer.REMOTE: 50},
    )

    @gcache.cached(key_type="Test", id_arg="test", use_case="test_partial_ramp")
    def cached_func(test: int) -> int:
        return 1

    with gcache.enable():
        # With 50% ramp, just verify it doesn't error
        for _ in range(10):
            cached_func(test=1)


def test_gcache_custom_logger(
    cache_config_provider: FakeCacheConfigProvider,
    redis_server: redislite.Redis,
    reset_global_state: None,
) -> None:
    """Test that custom logger is set when provided in config."""
    redis_server.flushall()
    custom_logger = logging.getLogger("custom_gcache_logger")

    gcache = GCache(
        GCacheConfig(
            cache_config_provider=cache_config_provider,
            redis_config=RedisConfig(port=REDIS_PORT),
            logger=custom_logger,
        )
    )

    try:
        assert _GLOBAL_GCACHE_STATE.logger == custom_logger
    finally:
        gcache.__del__()


def test_sync_flushall(gcache: GCache, redis_server: redislite.Redis) -> None:
    """Test sync flushall() method."""

    @gcache.cached(key_type="Test", id_arg="test", use_case="test_sync_flushall")
    def cached_func(test: int) -> str:
        return f"value_{test}"

    with gcache.enable():
        cached_func(test=1)
        assert len(redis_server.keys()) >= 1

        gcache.flushall()
        assert len(redis_server.keys()) == 0


class TestInvalidationBufferBounds:
    """The Go client refused both of these and Python refused neither.

    A negative buffer puts the watermark in the PAST, so it suppresses only entries written
    before that instant and reports success. A buffer past the watermark's own lifetime lets
    an entry written inside the window outlive the thing suppressing it and resurrect. Go
    named both; the divergence is the kind the shared corpus exists to prevent, and it sat on
    the side with no test.
    """

    @pytest.mark.parametrize("buffer_ms", [-1, -1000])
    def test_a_negative_buffer_is_refused(self, buffer_ms: int) -> None:
        with pytest.raises(ValueError, match="negative"):
            validate_invalidation_args("kt", "id", buffer_ms)

    def test_a_buffer_past_the_watermark_lifetime_is_refused(self) -> None:
        with pytest.raises(ValueError, match="watermark lifetime"):
            validate_invalidation_args("kt", "id", WATERMARK_TTL_SECONDS * 1000 + 1)

    def test_the_boundary_itself_is_allowed(self) -> None:
        # Exactly the watermark lifetime is legal: the entry expires as the watermark does,
        # so nothing outlives it. An off-by-one here would reject a valid call.
        validate_invalidation_args("kt", "id", WATERMARK_TTL_SECONDS * 1000)

    def test_zero_is_allowed(self) -> None:
        validate_invalidation_args("kt", "id", 0)

    @pytest.mark.parametrize(("kt", "id_"), [("", "id"), ("kt", "")])
    def test_an_empty_identifier_is_still_refused(self, kt: str, id_: str) -> None:
        with pytest.raises(ValueError, match="requires both"):
            validate_invalidation_args(kt, id_, 0)

    @pytest.mark.parametrize("bad", [0.5, float("nan"), float("inf"), "5", None])
    def test_a_non_integer_buffer_is_refused(self, bad: object) -> None:
        # NaN is the one the range checks cannot catch: every comparison against it is
        # False, so it passes `< 0` AND `> ceiling` and reaches SETEX, where Redis raises --
        # but only on a Redis-backed deployment, so a Noop-backed test suite reports success.
        with pytest.raises(ValueError, match="must be an int of milliseconds"):
            validate_invalidation_args("kt", "id", bad)  # type: ignore[arg-type]

    def test_a_bool_is_refused_despite_being_an_int(self) -> None:
        # bool subclasses int in Python, so True would otherwise arrive as a deliberate
        # one-millisecond buffer that nobody wrote.
        with pytest.raises(ValueError, match="must be an int of milliseconds"):
            validate_invalidation_args("kt", "id", True)  # type: ignore[arg-type]
