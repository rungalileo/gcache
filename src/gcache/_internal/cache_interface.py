from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from typing import Any

from gcache.config import CacheConfigProvider, CacheLayer, GCacheKey, GCacheKeyConfig

#: Async callable that fetches the actual value on cache miss.
#: Invoked by cache implementations when the requested key is not found or is stale.
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
        Invalidate all cache entries matching key_type and id.

        Sets a watermark timestamp so that any cached value created before
        (now + future_buffer_ms) is considered stale on subsequent reads.

        :param key_type: The entity type (e.g., 'user', 'project') matching the
            key_type used in @cached decorators.
        :param id: The entity identifier to invalidate.
        :param future_buffer_ms: Extends invalidation window into the future.
            Useful to handle race conditions where a read starts before a write
            completes but finishes after, preventing caching of stale data.
        """
        pass

    @abstractmethod
    def layer(self) -> CacheLayer:
        pass

    async def flushall(self) -> None:
        """
        Remove all entries from this cache layer.

        Used primarily for testing to reset cache state between tests.
        Default implementation is a no-op; subclasses should override if
        they support flushing (e.g., LocalCache clears its TTLCache dict,
        RedisCache calls FLUSHALL on Redis).
        """
        pass
