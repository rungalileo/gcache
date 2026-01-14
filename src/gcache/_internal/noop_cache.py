from typing import Any

from gcache._internal.cache_interface import CacheInterface, Fallback
from gcache.config import CacheLayer, GCacheKey


class NoopCache(CacheInterface):
    """
    NOOP Cache that does nothing but invoke fallback on get.
    """

    async def get(self, key: GCacheKey, fallback: Fallback) -> Any:
        return await fallback()

    async def put(self, key: GCacheKey, value: Any) -> None:
        pass

    async def delete(self, key: GCacheKey) -> bool:
        return False

    def layer(self) -> CacheLayer:
        return CacheLayer.NOOP
