import time
from enum import Enum
from random import random
from typing import Any

from gcache._internal.cache_interface import CacheInterface, Fallback
from gcache._internal.metrics import GCacheMetrics
from gcache._internal.state import _GLOBAL_GCACHE_STATE, GCacheContext
from gcache.config import CacheConfigProvider, CacheLayer, GCacheKey


class CacheWrapper(CacheInterface):
    """
    Abstract class for wrapper implementations.

    Wrappers can be used to add more functionality to a caching layer, like instrumentation, controls, etc.
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

    def __init__(
        self,
        cache: CacheInterface,
        cache_config_provider: CacheConfigProvider,
        metrics_prefix: str = "",
    ):
        super().__init__(cache_config_provider, cache)
        GCacheMetrics.initialize(metrics_prefix)

    async def put(self, key: GCacheKey, value: Any) -> None:
        """Write only if policy allows it, mirroring get.

        Without this, CacheController inherits CacheWrapper.put and writes
        unconditionally: a use case ramped to 0 -- the kill switch -- still gets written,
        and so does one written outside an ``enable()`` block, while ``get`` on the same
        key honours both. _should_cache also covers a config that omits this layer, whose
        ttl_sec lookup would otherwise raise KeyError out of LocalCache.
        """
        if not await self._should_cache(key):
            return
        await self.wrapped.put(key, value)

    async def get(self, key: GCacheKey, fallback: Fallback) -> Any:
        if await self._should_cache(key):
            start_time = time.monotonic()
            fallback_time = 0.0
            try:
                GCacheMetrics.REQUEST_COUNTER.labels(key.use_case, key.key_type, self.layer().name).inc()

                fallback_failed = False
                fallback_succeeded = False
                fallback_result: Any = None

                async def instrumented_fallback() -> Any:
                    nonlocal fallback_failed
                    nonlocal fallback_result
                    nonlocal fallback_succeeded
                    nonlocal fallback_time
                    start_fallback = time.monotonic()
                    GCacheMetrics.MISS_COUNTER.labels(key.use_case, key.key_type, self.layer().name).inc()
                    try:
                        fallback_result = await fallback()
                        fallback_succeeded = True
                        return fallback_result
                    except Exception:
                        fallback_failed = True
                        raise
                    finally:
                        fallback_time = time.monotonic() - start_fallback
                        GCacheMetrics.FALLBACK_TIMER.labels(key.use_case, key.key_type, self.layer().name).observe(
                            fallback_time
                        )

                try:
                    return await self.wrapped.get(key, instrumented_fallback)
                except Exception as e:
                    _GLOBAL_GCACHE_STATE.logger.error(f"Error getting value from cache: {e}", exc_info=True)
                    GCacheMetrics.ERROR_COUNTER.labels(
                        key.use_case,
                        key.key_type,
                        self.layer().name,
                        type(e).__name__,
                        fallback_failed,
                    ).inc()
                    if fallback_failed:
                        raise
                    if fallback_succeeded:
                        return fallback_result
                    try:
                        return await instrumented_fallback()
                    except Exception as fallback_error:
                        _GLOBAL_GCACHE_STATE.logger.error(
                            f"Error in fallback after cache read failure: {fallback_error}", exc_info=True
                        )
                        GCacheMetrics.ERROR_COUNTER.labels(
                            key.use_case,
                            key.key_type,
                            self.layer().name,
                            type(fallback_error).__name__,
                            True,
                        ).inc()
                        raise
            finally:
                GCacheMetrics.GET_TIMER.labels(key.use_case, key.key_type, self.layer().name).observe(
                    time.monotonic() - start_time - fallback_time
                )
        else:
            return await fallback()

    async def _should_cache(self, key: GCacheKey) -> bool:
        try:
            if not GCacheContext.enabled.get():
                # Counted here, not only in the decorator. The decorator returns before it
                # ever reaches the cache, so it cannot double-count -- and aget/aput come
                # straight here, which made a disabled context the one skip reason with no
                # exception, no log and no metric. A caller that primes outside enable()
                # otherwise believes another process can read the entry.
                GCacheMetrics.DISABLED_COUNTER.labels(
                    key.use_case, key.key_type, self.layer().name, DisabledReasons.context.name
                ).inc()
                return False
            config = await self._resolve_config(key)
            if config is None:
                GCacheMetrics.DISABLED_COUNTER.labels(
                    key.use_case, key.key_type, self.layer().name, DisabledReasons.missing_config.name
                ).inc()
                return False

            if config.ttl_sec.get(self.layer(), None) is None:
                GCacheMetrics.DISABLED_COUNTER.labels(
                    key.use_case, key.key_type, self.layer().name, DisabledReasons.missing_config.name
                ).inc()
                return False

            if config.ramp.get(self.layer(), None) is None:
                GCacheMetrics.DISABLED_COUNTER.labels(
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
            GCacheMetrics.DISABLED_COUNTER.labels(
                key.use_case, key.key_type, self.layer().name, DisabledReasons.ramped_down.name
            ).inc()
            return False
        except Exception as e:
            GCacheMetrics.DISABLED_COUNTER.labels(
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

    async def put(self, key: GCacheKey, value: Any) -> None:
        """Write BOTH layers, unlike the inherited single-layer put.

        Inheriting CacheWrapper.put wrote only the local, in-process layer and never
        Redis. That was invisible while nothing called it -- each layer populates itself
        from its own miss path inside ``get`` -- but GCache.aput exists to prime an entry
        for another PROCESS, which a local-only write cannot do.

        The SHARED layer is written first and its failure skips the local write, so a
        failed prime leaves nothing cached anywhere rather than a local-only copy. A local
        failure still surfaces, after the shared write has already succeeded.

        asyncio.CancelledError is a BaseException and propagates on the spot from whichever
        write is in flight -- prompt cancellation is correct when the caller is gone, and
        suppressing it to finish a best-effort write would delay it.
        """
        # SHARED layer first, and the local write is skipped when it fails.
        #
        # aput exists to prime an entry another PROCESS will read. With the local write
        # first, a failed Redis write left this process holding a local copy: aput raised,
        # so the caller believed the prime failed, but a later aget in the same process took
        # a local hit and returned the value -- a cache that looks healthy to the one
        # participant that does not matter and is empty for every other. That is the default
        # shape, not an edge case, since GCacheKeyConfig.enabled() ramps the local layer to
        # 100.
        #
        # This refines "both layers are always attempted" to "both unless the shared layer
        # failed", deliberately. Attempting both still matters in the other direction: a
        # local failure must not stop the remote write, which is the whole point of aput.
        await self.fallback_cache.put(key, value)
        await self.wrapped.put(key, value)

    async def delete(self, key: GCacheKey) -> bool:
        ret = await self.wrapped.delete(key)
        ret = await self.fallback_cache.delete(key) or ret
        return ret
