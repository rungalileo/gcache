from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from typing import Any

from gcache.config import CacheConfigProvider, CacheLayer, GCacheKey, GCacheKeyConfig

Fallback = Callable[..., Awaitable[Any]]


class CacheInterface(ABC):
    def __init__(self, cache_config_provider: CacheConfigProvider):
        self.config_provider = cache_config_provider

    async def _resolve_config(self, key: GCacheKey) -> GCacheKeyConfig | None:
        """
        Resolve the cache config for a key.

        First tries the config provider, then falls back to the key's default_config.
        Returns None if neither provides a config.
        """
        config = await self.config_provider(key)
        if config is None:
            config = key.default_config
        return config

    @abstractmethod
    async def get(self, key: GCacheKey, fallback: Fallback) -> Any:
        pass

    @abstractmethod
    async def put(self, key: GCacheKey, value: Any) -> None:
        pass

    @abstractmethod
    async def delete(self, key: GCacheKey) -> bool:
        pass

    async def invalidate(self, key_type: str, id: str, future_buffer_ms: int) -> None:
        """
        Invalidate all caches matching key_type and id at this point in time.

        Any cache entry that was created before now + future_buffer_ms will be considered invalid.

        :param key_type:
        :param id:
        :param future_buffer_ms: Invalidate cache into the future. Useful to avoid stale read -> write scenarios.
        :return:
        """
        pass

    @abstractmethod
    def layer(self) -> CacheLayer:
        pass

    async def flushall(self) -> None:
        """Remove all entries"""
        pass
