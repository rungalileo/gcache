import asyncio
import json
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from enum import Enum
from logging import Logger, LoggerAdapter
from typing import Any, Union

from pydantic import BaseModel, ConfigDict, field_validator
from redis.asyncio import Redis, RedisCluster

from gcache._internal.constants import ASYNC_DECODE_THRESHOLD_BYTES
from gcache._internal.state import _GLOBAL_GCACHE_STATE
from gcache.exceptions import UseCaseNameIsReserved

#: Async callable that fetches the actual value on a cache miss.
#: Public because GCache.aget/get take one: annotating a fallback should not mean
#: importing from gcache._internal.
#:
#: Zero-argument: every caller invokes it as ``fallback()``. ``Callable[..., ...]`` accepted
#: a function with required parameters and deferred the TypeError to the first cache miss,
#: which is the worst moment to find out. Bind arguments with functools.partial or a closure.
Fallback = Callable[[], Awaitable[Any]]


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


class Envelope(str, Enum):
    """How a cached value is framed in Redis.

    ``PICKLE`` is the default and serializes arbitrary Python objects, but is readable only
    from Python. ``JSON`` writes the cross-language envelope the TypeScript and Go clients
    also use, so an entry can be shared between them and inspected server-side from Redis's
    Lua interpreter.

    Public API: this lives here rather than in ``gcache._internal`` so callers do not have
    to import from a private path to name it.
    """

    PICKLE = "pickle"
    JSON = "json"


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


# The TypeScript JsonSerializer cannot represent `undefined` in JSON, so it writes this
# sentinel instead (packages/gcache-ts/src/serializer.ts). Python has no `undefined`; the
# closest value is None, and mapping it keeps a TS-written entry readable here. Without the
# mapping json.loads raises on the sentinel, that error escapes the EnvelopeDecodeError
# guard in RedisCache.get, and the entry never self-heals -- every read fails for the full
# TTL.
_TS_UNDEFINED_SENTINEL = "__gcache_json_undefined_v1__"


class JsonSerializer(Serializer):
    """JSON serializer, for values shared with non-Python readers.

    Pairs with ``Envelope.JSON``: that envelope carries a string payload, so a key using it
    needs a serializer that produces one. Only JSON-representable values work -- that is the
    trade for being readable outside Python.

    Reads are wire-compatible with the TypeScript serializer, including its `undefined`
    sentinel, which loads as ``None``. Writes never emit the sentinel: Python cannot
    distinguish "absent" from ``None``, so ``None`` round-trips as JSON ``null``.
    """

    async def dump(self, obj: Any) -> str:
        # allow_nan=False because json.dumps otherwise emits the bare tokens NaN, Infinity
        # and -Infinity, which are not JSON: JSON.parse throws on them and Go's
        # encoding/json rejects them. The write would succeed and the entry would be
        # unreadable from every non-Python client until its TTL ran out. Failing the write
        # is the rule the rest of this envelope follows.
        return json.dumps(obj, separators=(",", ":"), allow_nan=False)

    async def load(self, data: bytes | str) -> Any:
        if isinstance(data, bytes):
            data = data.decode("utf-8")
        if data == _TS_UNDEFINED_SENTINEL:
            return None
        # Offloaded above the same threshold RedisCache uses for the envelope. That offload
        # covers decode() only, which parses the envelope and hands back the payload as ONE
        # string; this parse turns that string into the real structure and allocates more.
        # So a multi-megabyte JSON entry blocked the loop here, immediately after the
        # envelope offload had avoided exactly that. A pickle key has no serializer and does
        # all of its work inside decode, which is why only Envelope.JSON has this shape.
        if len(data) < ASYNC_DECODE_THRESHOLD_BYTES:
            return json.loads(data)
        return await asyncio.get_running_loop().run_in_executor(None, json.loads, data)


@dataclass(frozen=True, slots=True)
class GCacheKey:
    key_type: str
    id: str
    use_case: str
    # Normalized to a tuple in __post_init__. The dataclass is frozen, but a list field
    # makes that a lie for the one field the urn is built from: key.args.append(...) left
    # the rendered urn -- and therefore the Redis key and this object's identity -- stale.
    args: Sequence[tuple[str, str]] = field(default_factory=tuple)
    invalidation_tracking: bool = False
    default_config: GCacheKeyConfig | None = None
    serializer: Serializer | None = None
    # How the value is framed in Redis. PICKLE (the default) is Python-only; JSON makes the
    # entry readable by the TypeScript and Go clients. This governs writes; reads sniff the
    # framing they find, except that a JSON key refuses to unpickle (see envelope.decode).
    #
    # Do NOT flip this on a live use case. Both pod generations run during a rolling deploy
    # and overwrite each other's framing, so the key's hit rate sits near zero for the whole
    # rollout. Migrate under a new use_case instead.
    envelope: Envelope = Envelope.PICKLE
    # Cached computed fields (set in __post_init__)
    prefix: str = field(init=False)
    urn: str = field(init=False)
    # The GCache urn_prefix in force when this key was built; see __post_init__.
    urn_prefix: str = field(init=False)

    def __post_init__(self) -> None:
        # GCacheKey is public API, and only GCache.cached coerced this. A caller building a
        # key directly with envelope="jsn" would get pickle framing and no error at all,
        # because put compares with == and get derives allow_pickle with != -- both silently
        # select pickle. That is the same silent fallback the == change removed from the
        # decorator path, so coerce here too and let an unrecognized value raise.
        object.__setattr__(self, "envelope", Envelope(self.envelope))

        # JSON framing carries a string payload, so it needs a serializer to produce one.
        # cached() rejects this pair at decoration time; a key built directly -- for
        # GCache.aget/aput -- was the one route left open, and it fails per request
        # instead: the write raises inside RedisCache, gcache swallows it, Redis stays
        # empty, and only a log line says cross-process sharing never happened.
        if self.envelope is Envelope.JSON and self.serializer is None:
            raise ValueError(
                f"GCacheKey {self.key_type}:{self.id}#{self.use_case} uses Envelope.JSON, "
                "which requires a serializer producing str or bytes (e.g. JsonSerializer())"
            )

        # "watermark" is reserved. cached() rejects it at decoration time; a key built
        # directly for aget/aput skipped that. With invalidation_tracking the urn is then
        # byte-identical to the key invalidate() writes, so a put would overwrite the
        # watermark with a cache value -- silently disabling invalidation for every use
        # case on that entity, and making the next tracked read raise on float().
        if self.use_case == "watermark":
            raise UseCaseNameIsReserved()

        object.__setattr__(self, "args", tuple(self.args))

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

        # The prefix is global mutable state that GCache() sets from its config, so a key
        # built before then captures the DEFAULT namespace while invalidate() uses the
        # configured one -- the watermark and the value land in different namespaces (and
        # different cluster hash slots), so tracked invalidation silently does nothing.
        # Recorded here and checked at use; see GCache._check_direct_key.
        object.__setattr__(self, "urn_prefix", _GLOBAL_GCACHE_STATE.urn_prefix)

    # Identity IS the rendered urn, which is the Redis key. urn is precomputed in
    # __post_init__, so this allocates nothing.
    #
    # The previous tuple of (key_type, id, use_case, args) omitted invalidation_tracking,
    # which DOES change the urn -- a tracked key braces its prefix for the cluster hash tag.
    # So two keys addressing different Redis keys compared equal, and LocalCache (a dict
    # keyed on GCacheKey) served one for the other, bypassing the watermark entirely. A
    # decorator declares track_for_invalidation once per use case, so it stayed unreachable
    # until direct keys let two call sites build the same use case both ways.
    def __hash__(self) -> int:
        return hash(self.urn)

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, GCacheKey):
            return False
        return self.urn == other.urn

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
