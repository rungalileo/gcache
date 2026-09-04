import logging
from typing import Any, cast

import pytest
from redis.asyncio import Redis
from redis.exceptions import ConnectionError as RedisConnectionError

from gcache import GCacheKey, GCacheKeyConfig
from gcache._internal.cache_interface import Fallback
from gcache._internal.metrics import GCacheMetrics
from gcache._internal.redis_cache import RedisCache
from gcache._internal.state import GCacheContext
from gcache._internal.wrappers import CacheController
from gcache.config import _default_config_provider


class StubRedisClient:
    def __init__(
        self,
        *,
        read_error: Exception | None = None,
        write_error: Exception | None = None,
    ) -> None:
        self.read_error = read_error
        self.write_error = write_error
        self.get_calls = 0
        self.setex_calls = 0

    async def get(self, key: str) -> bytes | None:
        self.get_calls += 1
        if self.read_error is not None:
            raise self.read_error
        return None

    async def setex(self, key: str, ttl: int, value: bytes) -> None:
        self.setex_calls += 1
        if self.write_error is not None:
            raise self.write_error


def _controller(client: StubRedisClient) -> CacheController:
    redis_cache = RedisCache(_default_config_provider, lambda: cast(Redis, client))
    return CacheController(redis_cache, _default_config_provider, metrics_prefix="api_")


def _key(use_case: str) -> GCacheKey:
    return GCacheKey(
        key_type="Test",
        id="123",
        use_case=use_case,
        default_config=GCacheKeyConfig.enabled(60),
    )


async def _enabled_get(controller: CacheController, key: GCacheKey, fallback: Fallback) -> Any:
    token = GCacheContext.enabled.set(True)
    try:
        return await controller.get(key, fallback)
    finally:
        GCacheContext.enabled.reset(token)


def _error_metric(controller: CacheController, key: GCacheKey, error: type[Exception], in_fallback: bool) -> Any:
    return GCacheMetrics.ERROR_COUNTER.labels(
        key.use_case,
        key.key_type,
        controller.layer().name,
        error.__name__,
        in_fallback,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fallback_value",
    [
        pytest.param(None, id="none"),
        pytest.param(False, id="false"),
        pytest.param(0, id="zero"),
        pytest.param("", id="empty-string"),
        pytest.param("source-value", id="truthy"),
    ],
)
async def test_redis_put_failure_returns_successful_fallback_once(
    fallback_value: Any,
    caplog: pytest.LogCaptureFixture,
) -> None:
    error = RedisConnectionError("redis write failed")
    client = StubRedisClient(write_error=error)
    controller = _controller(client)
    key = _key(f"redis_put_failure_{type(fallback_value).__name__}")
    fallback_calls = 0
    error_metric = _error_metric(controller, key, RedisConnectionError, False)
    errors_before = error_metric._value.get()

    async def fallback() -> Any:
        nonlocal fallback_calls
        fallback_calls += 1
        return fallback_value

    with caplog.at_level(logging.ERROR):
        result = await _enabled_get(controller, key, fallback)

    assert result == fallback_value
    assert type(result) is type(fallback_value)
    assert fallback_calls == 1
    assert client.get_calls == 1
    assert client.setex_calls == 1
    assert error_metric._value.get() == errors_before + 1
    assert "Error getting value from cache: redis write failed" in caplog.text


@pytest.mark.asyncio
async def test_redis_read_failure_calls_fallback_once(caplog: pytest.LogCaptureFixture) -> None:
    error = RedisConnectionError("redis read failed")
    client = StubRedisClient(read_error=error)
    controller = _controller(client)
    key = _key("redis_read_failure")
    fallback_calls = 0
    error_metric = _error_metric(controller, key, RedisConnectionError, False)
    errors_before = error_metric._value.get()

    async def fallback() -> str:
        nonlocal fallback_calls
        fallback_calls += 1
        return "source-value"

    with caplog.at_level(logging.ERROR):
        result = await _enabled_get(controller, key, fallback)

    assert result == "source-value"
    assert fallback_calls == 1
    assert client.get_calls == 1
    assert client.setex_calls == 0
    assert error_metric._value.get() == errors_before + 1
    assert "Error getting value from cache: redis read failed" in caplog.text


@pytest.mark.asyncio
async def test_fallback_failure_is_propagated(caplog: pytest.LogCaptureFixture) -> None:
    client = StubRedisClient()
    controller = _controller(client)
    key = _key("fallback_failure")
    fallback_calls = 0
    error_metric = _error_metric(controller, key, LookupError, True)
    errors_before = error_metric._value.get()

    async def fallback() -> None:
        nonlocal fallback_calls
        fallback_calls += 1
        raise LookupError("source unavailable")

    with caplog.at_level(logging.ERROR), pytest.raises(LookupError, match="source unavailable"):
        await _enabled_get(controller, key, fallback)

    assert fallback_calls == 1
    assert client.get_calls == 1
    assert client.setex_calls == 0
    assert error_metric._value.get() == errors_before + 1
    assert "Error getting value from cache: source unavailable" in caplog.text
