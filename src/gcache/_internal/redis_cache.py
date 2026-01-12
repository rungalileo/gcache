import asyncio
import pickle
import threading
import time
from collections.abc import Callable
from concurrent.futures.thread import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

from redis.asyncio import Redis, RedisCluster

from gcache._internal.cache_interface import CacheInterface, Fallback
from gcache._internal.constants import ASYNC_PICKLE_THRESHOLD_BYTES, WATERMARK_TTL_SECONDS
from gcache._internal.metrics import GCacheMetrics
from gcache._internal.state import _GLOBAL_GCACHE_STATE
from gcache.config import CacheConfigProvider, CacheLayer, GCacheKey, RedisConfig
from gcache.exceptions import MissingKeyConfig


@dataclass(frozen=True, slots=True)
class RedisValue:
    """
    Wrapper around cached payload that includes creation timestamp.

    The timestamp enables cache invalidation: when a watermark is set for a key,
    any cached value with created_at_ms <= watermark is considered stale.
    """

    created_at_ms: int  # Unix timestamp in milliseconds when this value was cached
    payload: Any  # The actual cached data (may be serialized if Serializer is used)


def create_default_redis_client_factory(
    config: RedisConfig,
) -> Callable[[], Redis | RedisCluster]:
    """
    Create a default Redis client factory function from a RedisConfig.

    This factory creates a new Redis client each time it's called. Thread-local
    caching is handled by RedisCache, so the factory doesn't need to manage it.

    :param config: RedisConfig containing URL, cluster flag, and redis-py options
    :return: Factory function that creates a Redis client
    """

    def factory() -> Redis | RedisCluster:
        options: dict[str, int | bool | str] = config.redis_py_options
        if config.cluster:
            return RedisCluster.from_url(config.url, **options)
        else:
            return Redis.from_url(config.url, **options)  # type: ignore[arg-type]

    return factory


class RedisCache(CacheInterface):
    _executor = ThreadPoolExecutor()

    def __init__(
        self,
        cache_config_provider: CacheConfigProvider,
        client_factory: Callable[[], Redis | RedisCluster],
    ):
        """
        Initialize RedisCache.

        :param cache_config_provider: Provider for cache configuration
        :param client_factory: Factory function to create Redis clients.
            The factory should return a new Redis client when called. Thread-local
            caching is handled internally by RedisCache - the factory will only be
            called once per thread, and the resulting client will be reused for
            subsequent operations on that thread.
        """
        super().__init__(cache_config_provider)
        self._client_factory = client_factory
        # Thread-local storage is required because async redis-py clients maintain
        # internal state (connection pool, pending requests) bound to a specific event loop.
        # Since gcache runs sync cached functions in EventLoopThread workers (each with its
        # own event loop), sharing a client across threads causes "attached to a different
        # event loop" RuntimeError. One client per thread ensures correct event loop binding.
        self._thread_local = threading.local()

    @property
    def client(self) -> Redis | RedisCluster:
        """
        Get a Redis client for the current thread.

        The client is created once per thread using the factory and cached
        in thread-local storage for reuse.
        """
        if not hasattr(self._thread_local, "client"):
            self._thread_local.client = self._client_factory()
        return self._thread_local.client

    async def _exec_fallback(
        self,
        key: GCacheKey,
        watermark_ms: int | None,
        fallback: Fallback,
    ) -> Any:
        """
        Execute the fallback function, optionally cache the result, and return it.

        The result is stored in cache unless there's an active invalidation window
        (watermark_ms is in the future). This prevents caching potentially stale data
        that was fetched during an invalidation period.

        :param key: Cache key for storing the result.
        :param watermark_ms: Invalidation watermark timestamp in milliseconds, or None.
            If set and greater than current time, the result is not cached.
        :param fallback: Async function that fetches the actual value.
        :return: The value returned by the fallback function.
        """
        val = await fallback()
        if watermark_ms is None or watermark_ms < time.time() * 1e3:
            await self.put(key, val)
        return val

    async def invalidate(self, key_type: str, id: str, future_buffer_ms: int) -> None:
        GCacheMetrics.INVALIDATION_COUNTER.labels(key_type, self.layer().name).inc()

        key = "{" + _GLOBAL_GCACHE_STATE.urn_prefix + ":" + key_type + ":" + id + "}#watermark"
        exp_ms = int(time.time() * 1000 + future_buffer_ms)
        await self.client.setex(key, WATERMARK_TTL_SECONDS, exp_ms)

    @staticmethod
    async def _async_pickle_loads(data: bytes) -> Any:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(RedisCache._executor, pickle.loads, data)

    async def get(self, key: GCacheKey, fallback: Fallback) -> Any:
        _GLOBAL_GCACHE_STATE.logger.debug("Calling Redis Cache")

        watermark_ms = None
        if key.invalidation_tracking:
            vals = await self.client.mget(key.urn, key.prefix + "#watermark")
            val_pickle = vals[0]
            watermark_ms = vals[1]
            if watermark_ms is not None:
                watermark_ms = float(watermark_ms)
        else:
            val_pickle = await self.client.get(key.urn)
        if val_pickle is not None:
            start_sec = time.monotonic()

            deserialized_value: RedisValue = (
                pickle.loads(val_pickle)
                if len(val_pickle) < ASYNC_PICKLE_THRESHOLD_BYTES
                else await RedisCache._async_pickle_loads(val_pickle)
            )

            # Load payload using custom serializer if present.
            payload = deserialized_value.payload
            if key.serializer is not None:
                payload = await key.serializer.load(payload)

            (
                GCacheMetrics.SERIALIZATION_TIMER.labels(key.use_case, key.key_type, self.layer().name, "load").observe(
                    time.monotonic() - start_sec
                )
            )

            # Check if cache val is expired.
            if watermark_ms is not None:
                watermark_ms = int(watermark_ms)
                if watermark_ms >= deserialized_value.created_at_ms:
                    return await self._exec_fallback(key, watermark_ms, fallback)
            return payload
        else:
            return await self._exec_fallback(key, watermark_ms, fallback)

    async def put(self, key: GCacheKey, value: Any) -> None:
        config = await self._resolve_config(key)
        if config is None:
            raise MissingKeyConfig(key.use_case)

        current_time_ms = int(time.time() * 1000)

        start_time = time.monotonic()
        serialized_value = value if key.serializer is None else await key.serializer.dump(value)

        val_pickle = pickle.dumps(
            RedisValue(created_at_ms=current_time_ms, payload=serialized_value), protocol=pickle.HIGHEST_PROTOCOL
        )

        GCacheMetrics.SERIALIZATION_TIMER.labels(key.use_case, key.key_type, self.layer().name, "dump").observe(
            time.monotonic() - start_time
        )

        GCacheMetrics.SIZE_HISTOGRAM.labels(key.use_case, key.key_type, self.layer().name).observe(len(val_pickle))

        ttl = config.ttl_sec.get(self.layer(), None)
        if ttl is None:
            raise MissingKeyConfig(key.use_case)

        await self.client.setex(key.urn, ttl, val_pickle)

    async def delete(self, key: GCacheKey) -> bool:
        return (await self.client.delete(key.urn)) > 0

    def layer(self) -> CacheLayer:
        return CacheLayer.REMOTE

    async def flushall(self) -> None:
        return await self.client.flushall()
