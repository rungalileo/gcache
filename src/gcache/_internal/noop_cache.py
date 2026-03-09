from collections.abc import Mapping
from typing import Any

from gcache._internal.cache_interface import CacheInterface, Fallback
from gcache.config import CacheHitHook, CacheLayer, GCacheKey


class NoopCache(CacheInterface):
    """
    NOOP Cache that does nothing but invoke fallback on get.
    """

    async def get(
        self,
        key: GCacheKey,
        fallback: Fallback,
        *,
        call_args: Mapping[str, Any] | None = None,
        on_cache_hit: CacheHitHook | None = None,
    ) -> Any:
        return await fallback()

    async def put(self, key: GCacheKey, value: Any) -> None:
        pass

    async def delete(self, key: GCacheKey) -> bool:
        return False

    def layer(self) -> CacheLayer:
        return CacheLayer.NOOP
