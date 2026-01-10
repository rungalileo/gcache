import time
from enum import Enum
from random import random
from typing import Any

from prometheus_client import Counter, Histogram

from gcache._internal.cache_interface import CacheInterface, Fallback
from gcache._internal.state import _GLOBAL_GCACHE_STATE, GCacheContext
from gcache.config import CacheConfigProvider, CacheLayer, GCacheKey


class CacheWrapper(CacheInterface):
    """
    Abstract class for wrapper implementations.

    Wrappers can be used to add more functionality to a caching layer, like insturmentation, controls, etc.
    """

    def __init__(self, cache_config_provider: CacheConfigProvider, cache: CacheInterface):
        super().__init__(cache_config_provider)
        self.wrapped = cache

    def layer(self) -> CacheLayer:
        return self.wrapped.layer()

    async def put(self, key: GCacheKey, value: Any) -> None:
        return await self.wrapped.put(key, value)

    async def delete(self, key: GCacheKey) -> bool:
        return await self.wrapped.delete(key)

    async def invalidate(self, key_type: str, id: str, future_buffer_ms: int = 0) -> None:
        return await self.wrapped.invalidate(key_type, id, future_buffer_ms)

    async def flushall(self) -> None:
        return await self.wrapped.flushall()


class DisabledReasons(Enum):
    ramped_down = "ramped_down"
    context = "context"
    server_down = "server_down"
    missing_config = "missing_config"
    config_error = "config_error"


class CacheController(CacheWrapper):
    """
    Control cache execution and instrument cache hit ratio.
    """

    # TODO: These caches should be defined elsewhere.
    CACHE_DISABLED_COUNTER: Counter = None  # type: ignore[assignment]
    CACHE_MISS_COUNTER: Counter = None  # type: ignore[assignment]
    CACHE_REQUEST_COUNTER: Counter = None  # type: ignore[assignment]
    CACHE_ERROR_COUNTER: Counter = None  # type: ignore[assignment]

    CACHE_GET_TIMER: Histogram = None  # type: ignore[assignment]
    CACHE_FALLBACK_TIMER: Histogram = None  # type: ignore[assignment]

    CACHE_SERIALIZATION_TIMER: Histogram = None  # type: ignore[assignment]

    CACHE_SIZE_HISTOGRAM: Histogram = None  # type: ignore[assignment]

    CACHE_INVALIDATION_COUNT: Counter = None  # type: ignore[assignment]

    def __init__(
        self,
        cache: CacheInterface,
        cache_config_provider: CacheConfigProvider,
        metrics_prefix: str = "",
    ):
        super().__init__(cache_config_provider, cache)

        if CacheController.CACHE_REQUEST_COUNTER is None:
            CacheController.CACHE_DISABLED_COUNTER = Counter(
                name=metrics_prefix + "gcache_disabled_counter",
                labelnames=["use_case", "key_type", "layer", "reason"],
                documentation="Cache disabled counter",
            )

            CacheController.CACHE_MISS_COUNTER = Counter(
                name=metrics_prefix + "gcache_miss_counter",
                labelnames=["use_case", "key_type", "layer"],
                documentation="Cache miss counter",
            )

            CacheController.CACHE_REQUEST_COUNTER = Counter(
                name=metrics_prefix + "gcache_request_counter",
                labelnames=["use_case", "key_type", "layer"],
                documentation="Cache request counter",
            )
            CacheController.CACHE_ERROR_COUNTER = Counter(
                name=metrics_prefix + "gcache_error_counter",
                labelnames=["use_case", "key_type", "layer", "error", "in_fallback"],
                documentation="Cache error counter",
            )
            CacheController.CACHE_INVALIDATION_COUNT = Counter(
                name=metrics_prefix + "gcache_invalidation_counter",
                labelnames=["key_type", "layer"],
                documentation="Cache invalidation counter",
            )
            CacheController.CACHE_GET_TIMER = Histogram(
                name=metrics_prefix + "gcache_get_timer",
                labelnames=["use_case", "key_type", "layer"],
                documentation="Cache get timer",
                buckets=[0.001] + list(Histogram.DEFAULT_BUCKETS),
            )
            CacheController.CACHE_FALLBACK_TIMER = Histogram(
                name=metrics_prefix + "gcache_fallback_timer",
                labelnames=["use_case", "key_type", "layer"],
                documentation="Fallback timer",
                buckets=[0.001] + list(Histogram.DEFAULT_BUCKETS),
            )

            CacheController.CACHE_SERIALIZATION_TIMER = Histogram(
                name=metrics_prefix + "gcache_serialization_timer",
                labelnames=["use_case", "key_type", "layer", "operation"],
                documentation="Cache serialization timer",
                buckets=[0.001] + list(Histogram.DEFAULT_BUCKETS),
            )

            CacheController.CACHE_SIZE_HISTOGRAM = Histogram(
                name=metrics_prefix + "gcache_size_histogram",
                labelnames=["use_case", "key_type", "layer"],
                documentation="Cache size histogram",
                buckets=[100, 1000, 10_000, 100_000, 1_000_000, 10_000_000],
            )

    async def get(self, key: GCacheKey, fallback: Fallback) -> Any:
        if await self._should_cache(key):
            start_time = time.monotonic()
            fallback_time = 0.0
            try:
                self.CACHE_REQUEST_COUNTER.labels(key.use_case, key.key_type, self.layer().name).inc()

                fallback_failed = False

                async def instrumented_fallback() -> Any:
                    nonlocal fallback_failed
                    nonlocal fallback_time
                    start_fallback = time.monotonic()
                    self.CACHE_MISS_COUNTER.labels(key.use_case, key.key_type, self.layer().name).inc()
                    try:
                        return await fallback()
                    except:
                        fallback_failed = True
                        raise
                    finally:
                        fallback_time = time.monotonic() - start_fallback
                        self.CACHE_FALLBACK_TIMER.labels(key.use_case, key.key_type, self.layer().name).observe(
                            fallback_time
                        )

                try:
                    return await self.wrapped.get(key, instrumented_fallback)
                except Exception as e:
                    _GLOBAL_GCACHE_STATE.logger.error(f"Error getting value from cache: {e}", exc_info=True)
                    self.CACHE_ERROR_COUNTER.labels(
                        key.use_case,
                        key.key_type,
                        self.layer().name,
                        type(e).__name__,
                        fallback_failed,
                    ).inc()
                    if not fallback_failed:
                        return await fallback()
                    else:
                        raise
            finally:
                self.CACHE_GET_TIMER.labels(key.use_case, key.key_type, self.layer().name).observe(
                    time.monotonic() - start_time - fallback_time
                )
        else:
            return await fallback()

    async def _should_cache(self, key: GCacheKey) -> bool:
        try:
            if not GCacheContext.enabled.get():
                return False
            config = await self.config_provider(key)
            if config is None:
                config = key.default_config

            if config is None:
                CacheController.CACHE_DISABLED_COUNTER.labels(
                    key.use_case, key.key_type, self.layer().name, DisabledReasons.missing_config.name
                ).inc()
                return False

            if config.ttl_sec.get(self.layer(), None) is None:
                CacheController.CACHE_DISABLED_COUNTER.labels(
                    key.use_case, key.key_type, self.layer().name, DisabledReasons.missing_config.name
                ).inc()
                return False

            if config.ramp.get(self.layer(), None) is None:
                CacheController.CACHE_DISABLED_COUNTER.labels(
                    key.use_case, key.key_type, self.layer().name, DisabledReasons.missing_config.name
                ).inc()
                return False

            ramp = config.ramp.get(self.layer(), 0)
            if ramp == 100:
                return True
            if ramp > 0:
                r = random()
                if r < ramp / 100.0:
                    return True
            CacheController.CACHE_DISABLED_COUNTER.labels(
                key.use_case, key.key_type, self.layer().name, DisabledReasons.ramped_down.name
            ).inc()
            return False
        except Exception as e:
            CacheController.CACHE_DISABLED_COUNTER.labels(
                key.use_case, key.key_type, self.layer().name, DisabledReasons.config_error.name
            ).inc()
            _GLOBAL_GCACHE_STATE.logger.error(f"Error getting cache config: {e}", exc_info=True)
            return False


class CacheChain(CacheWrapper):
    """
    Create cache chain by passing one layer of cache as fallback to another one.
    """

    def __init__(
        self,
        cache_config_provider: CacheConfigProvider,
        cache: CacheInterface,
        fallback_cache: CacheInterface,
    ):
        super().__init__(cache_config_provider, cache)
        self.fallback_cache = fallback_cache

    async def get(self, key: GCacheKey, fallback: Fallback) -> Any:
        async def cache_fallback() -> Any:
            return await self.fallback_cache.get(key, fallback)

        return await self.wrapped.get(key, cache_fallback)

    async def delete(self, key: GCacheKey) -> bool:
        ret = await self.wrapped.delete(key)
        ret = await self.fallback_cache.delete(key) or ret
        return ret
