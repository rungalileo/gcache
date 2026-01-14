import json
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import Enum
from logging import Logger, LoggerAdapter
from typing import Any, Union

from pydantic import BaseModel, ConfigDict, field_validator
from redis.asyncio import Redis, RedisCluster

from gcache._internal.state import _GLOBAL_GCACHE_STATE


class CacheLayer(Enum):
    """
    Cache layers available in gcache.

    The cache chain checks LOCAL first, then REMOTE on miss. Each layer can have
    independent TTL and ramp settings via GCacheKeyConfig.
    """

    NOOP = "noop"
    """No-op layer that always calls the fallback. Used when Redis is not configured."""

    LOCAL = "local"
    """In-memory TTLCache layer. Fast but not shared across processes."""

    REMOTE = "remote"
    """Redis-backed layer. Shared across processes, supports invalidation."""


GCacheKeyConfigs = dict[str, Union["GCacheKeyConfig", dict[str, "GCacheKeyConfig"]]]


class GCacheKeyConfig(BaseModel):
    ttl_sec: dict[CacheLayer, int]
    ramp: dict[CacheLayer, int]

    @field_validator("ttl_sec", "ramp", mode="before")
    @classmethod
    def convert_keys(cls, value: Any) -> Any:
        # When deserializing, if keys are strings (the enum names), convert them back to CacheLayer.
        if isinstance(value, dict):
            return {CacheLayer[key.upper()] if isinstance(key, str) else key: val for key, val in value.items()}
        return value

    def model_dump(self, *args: Any, **kwargs: Any) -> dict:  # type: ignore[override]
        # Get the default dict representation.
        original = super().model_dump(*args, **kwargs)
        # Convert dictionary keys for ttl_sec and ramp from CacheLayer to their .name.
        original["ttl_sec"] = {k.value if isinstance(k, CacheLayer) else k: v for k, v in self.ttl_sec.items()}
        original["ramp"] = {k.value if isinstance(k, CacheLayer) else k: v for k, v in self.ramp.items()}
        return original

    def dumps(self) -> str:
        return json.dumps(self.model_dump())

    @staticmethod
    def loads(data: Any) -> "GCacheKeyConfig":
        if isinstance(data, str):
            return GCacheKeyConfig.model_validate(json.loads(data))
        return GCacheKeyConfig.model_validate(data)

    @staticmethod
    def load_configs(data: str | dict) -> GCacheKeyConfigs:
        """
        Load a collection of configs, which is a dict of use case to GCacheKeyConfig.
        We also support keys mapping to another dict of str -> GCacheKeyConfig as a way
        to override configs for a specific environment.
        :return:
        """
        data_dict = json.loads(data) if isinstance(data, str) else data

        configs: GCacheKeyConfigs = {}
        for k, v in data_dict.items():
            config: GCacheKeyConfig | dict[str, GCacheKeyConfig]
            try:
                config = GCacheKeyConfig.loads(v)
            except Exception:
                config = {inner_k: GCacheKeyConfig.loads(inner_v) for inner_k, inner_v in v.items()}

            configs[k] = config
        return configs

    @staticmethod
    def dump_configs(data: GCacheKeyConfigs) -> str:
        """
        Dump a collection of configs, which is a dict of use case to GCacheKeyConfig.
        We also support keys mapping to another dict of str -> GCacheKeyConfig as a way
        to override configs for a specific environment.
        :return:
        """
        data_dict: dict[str, Any] = {}
        for k, v in data.items():
            if isinstance(v, GCacheKeyConfig):
                data_dict[k] = v.model_dump()
            else:
                data_dict[k] = {inner_k: inner_v.model_dump() for inner_k, inner_v in v.items()}

        return json.dumps(data_dict, indent=2)

    @staticmethod
    def enabled(ttl_sec: int) -> "GCacheKeyConfig":
        """
        Return config that enables cache with given ttl for all layers.
        :param ttl_sec: TTL in seconds for all cache layers.
        :return: GCacheKeyConfig with all layers enabled at 100% ramp.
        """
        config = GCacheKeyConfig(ttl_sec={}, ramp={})
        for layer in CacheLayer:
            config.ttl_sec[layer] = ttl_sec
            config.ramp[layer] = 100
        return config


class Serializer(ABC):
    """
    Serializer that can be overloaded to allow for custom loading/dumping of values into cache.
    """

    @abstractmethod
    async def dump(self, obj: Any) -> bytes | str:
        pass

    @abstractmethod
    async def load(self, data: bytes | str) -> Any:
        pass


@dataclass(frozen=True, slots=True)
class GCacheKey:
    key_type: str
    id: str
    use_case: str
    args: list[tuple[str, str]] = field(default_factory=list)
    invalidation_tracking: bool = False
    default_config: GCacheKeyConfig | None = None
    serializer: Serializer | None = None
    # Cached computed fields (set in __post_init__)
    prefix: str = field(init=False)
    urn: str = field(init=False)

    def __post_init__(self) -> None:
        # Compute prefix
        prefix = f"{self.key_type}:{self.id}"
        if _GLOBAL_GCACHE_STATE.urn_prefix:
            prefix = f"{_GLOBAL_GCACHE_STATE.urn_prefix}:{prefix}"
        if self.invalidation_tracking:
            prefix = "{" + prefix + "}"
        object.__setattr__(self, "prefix", prefix)

        # Compute urn
        args_str = ""
        if self.args:
            args_str = "?" + "&".join([f"{arg[0]}={arg[1]}" for arg in self.args])
        object.__setattr__(self, "urn", f"{prefix}{args_str}#{self.use_case}")

    def __hash__(self) -> int:
        # Tuple hashing is fast (C implementation) and avoids string allocation
        return hash((self.key_type, self.id, self.use_case, tuple(self.args)))

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, GCacheKey):
            return False
        # Direct field comparison - short-circuits on first mismatch
        return (
            self.key_type == other.key_type
            and self.id == other.id
            and self.use_case == other.use_case
            and self.args == other.args
        )

    def __str__(self) -> str:
        return self.urn


# Get cache config given a use case.
CacheConfigProvider = Callable[[GCacheKey], Awaitable[GCacheKeyConfig | None]]


async def _default_config_provider(key: GCacheKey) -> GCacheKeyConfig | None:
    """Default config provider that returns None, falling back to decorator's default_config."""
    return None


class RedisConfig(BaseModel):
    username: str = ""
    password: str = ""
    host: str = "localhost"
    port: int = 6379
    # protocol is either redis or rediss
    protocol: str = "redis"
    cluster: bool = False

    redis_py_options: dict[str, int | bool | str] = {
        "socket_connect_timeout": 1,
        "socket_timeout": 1,
        "max_connections": 100,
    }

    @property
    def url(self) -> str:
        return f"{self.protocol}://{self.username}:{self.password}@{self.host}:{self.port}"


class GCacheConfig(BaseModel):
    cache_config_provider: CacheConfigProvider = _default_config_provider
    urn_prefix: str | None = None
    metrics_prefix: str = "api_"
    redis_config: RedisConfig | None = None
    redis_client_factory: Callable[[], Redis | RedisCluster] | None = None
    logger: Logger | LoggerAdapter | None = None

    model_config = ConfigDict(arbitrary_types_allowed=True)
