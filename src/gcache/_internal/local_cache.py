import asyncio
from collections.abc import Mapping
from typing import Any

from cachetools import TTLCache

from gcache._internal.cache_hit import BypassCurrentLayer, run_cache_hit_hook
from gcache._internal.cache_interface import CacheInterface, Fallback
from gcache._internal.constants import LOCAL_CACHE_MAX_SIZE
from gcache._internal.state import _GLOBAL_GCACHE_STATE
from gcache.config import CacheConfigProvider, CacheHitHook, CacheLayer, EvictAndFallback, GCacheKey, ReturnCached
from gcache.exceptions import MissingKeyConfig


class LocalCache(CacheInterface):
    """
    In-memory cache layer using TTLCache from cachetools.

    Maintains a separate TTLCache instance per use_case, each with a configurable
    TTL and a max size of LOCAL_CACHE_MAX_SIZE entries. This is the first layer
    in the cache chain, checked before Redis.

    Note: LocalCache does not support invalidation (watermarks). If you need
    invalidation support, rely on the Redis layer with track_for_invalidation=True.
    """

    def __init__(self, cache_config_provider: CacheConfigProvider):
        super().__init__(cache_config_provider)
        self.caches: dict[str, TTLCache] = {}  # use_case -> TTLCache instance
        self.lock = asyncio.Lock()  # Protects cache creation

    async def _get_ttl_cache(self, key: GCacheKey) -> TTLCache:
        cache = self.caches.get(key.use_case, None)
        if cache is None:
            config = await self._resolve_config(key)
            if config is None:
                raise MissingKeyConfig(key.use_case)

            async with self.lock:
                # See if cache was already created by another worker.
                cache = self.caches.get(key.use_case, None)
                if cache is None:
                    self.caches[key.use_case] = cache = TTLCache(
                        maxsize=LOCAL_CACHE_MAX_SIZE, ttl=config.ttl_sec[self.layer()]
                    )

        return cache

    async def get(
        self,
        key: GCacheKey,
        fallback: Fallback,
        *,
        call_args: Mapping[str, Any] | None = None,
        on_cache_hit: CacheHitHook | None = None,
    ) -> Any:
        _GLOBAL_GCACHE_STATE.logger.debug("Calling local cache")
        cache = await self._get_ttl_cache(key)

        if key not in cache:
            await self.put(key, await fallback())
            return cache[key]

        decision = await run_cache_hit_hook(
            key=key,
            layer=self.layer(),
            value=cache[key],
            call_args=call_args,
            on_cache_hit=on_cache_hit,
        )
        if isinstance(decision, ReturnCached):
            return cache[key]
        if isinstance(decision, EvictAndFallback):
            cache.pop(key, None)
            return await fallback()
        if isinstance(decision, BypassCurrentLayer):
            return await fallback()

        return cache[key]

    async def put(self, key: GCacheKey, value: Any) -> None:
        (await self._get_ttl_cache(key))[key] = value

    async def delete(self, key: GCacheKey) -> bool:
        try:
            (await self._get_ttl_cache(key)).pop(key)
        except KeyError:
            return False
        return True

    def layer(self) -> CacheLayer:
        return CacheLayer.LOCAL

    async def flushall(self) -> None:
        async with self.lock:
            self.caches.clear()
