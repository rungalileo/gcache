import contextvars
from logging import Logger, LoggerAdapter, getLogger

from pydantic import BaseModel, ConfigDict


# Global state is needed to allow reconfiguration when GCache is instantiated.
# This is fine because GCache is guaranteed to be a singleton.
class GCacheGlobalState(BaseModel):
    urn_prefix: str = "urn"
    logger: Logger | LoggerAdapter = getLogger(__name__)
    gcache_instantiated: bool = False

    model_config = ConfigDict(arbitrary_types_allowed=True)


_GLOBAL_GCACHE_STATE = GCacheGlobalState()


class GCacheContext:
    # Disabled by default to prevent accidental caching in write paths.
    # Users must explicitly enable caching in read paths using `with gcache.enable():`.
    # This forces conscious decisions about where caching is safe.
    enabled: contextvars.ContextVar[bool] = contextvars.ContextVar("gcache_enabled", default=False)
