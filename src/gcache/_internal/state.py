import contextvars
from logging import Logger, LoggerAdapter, getLogger

from pydantic import BaseModel, ConfigDict


class GCacheGlobalState(BaseModel):
    """
    Global configuration state shared across all gcache components.

    This state is modified when GCache is instantiated and read by cache implementations,
    key builders, and logging throughout the library. Global state is acceptable here
    because GCache enforces a singleton pattern.
    """

    urn_prefix: str = "urn"
    """Namespace prefix prepended to all cache key URNs (e.g., 'urn:user:123#use_case')."""

    logger: Logger | LoggerAdapter = getLogger(__name__)
    """Logger used for debug messages and error reporting throughout gcache."""

    gcache_instantiated: bool = False
    """Singleton guard: set to True when GCache is created, prevents duplicate instances."""

    model_config = ConfigDict(arbitrary_types_allowed=True)


_GLOBAL_GCACHE_STATE = GCacheGlobalState()


class GCacheContext:
    # Disabled by default to prevent accidental caching in write paths.
    # Users must explicitly enable caching in read paths using `with gcache.enable():`.
    # This forces conscious decisions about where caching is safe.
    enabled: contextvars.ContextVar[bool] = contextvars.ContextVar("gcache_enabled", default=False)
