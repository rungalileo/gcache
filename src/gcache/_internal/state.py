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

    gcache_owner_id: int | None = None
    """``id()`` of the GCache that currently holds the singleton, or None.

    ``gcache_instantiated`` alone cannot tell a destructor whether it owns the flag. A
    GCache that finished ``__init__`` but is no longer the registered live instance -- one
    whose ``__del__`` is invoked directly, or which is finalized after another has taken
    over -- would clear a flag belonging to a DIFFERENT object, letting a third instance be
    built alongside the live one. Two GCaches then race one ``urn_prefix`` and one logger.

    ``id()`` rather than a weakref because the check only has to be true at the moment the
    owner is torn down: while the owner is alive its id cannot be reused, and once the flag
    is cleared the value is never consulted again."""

    model_config = ConfigDict(arbitrary_types_allowed=True)


_GLOBAL_GCACHE_STATE = GCacheGlobalState()


class GCacheContext:
    # Disabled by default to prevent accidental caching in write paths.
    # Users must explicitly enable caching in read paths using `with gcache.enable():`.
    # This forces conscious decisions about where caching is safe.
    enabled: contextvars.ContextVar[bool] = contextvars.ContextVar("gcache_enabled", default=False)
