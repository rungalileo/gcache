import json
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from enum import Enum
from logging import Logger, LoggerAdapter
from typing import Any, Union

from pydantic import BaseModel, ConfigDict, field_validator
from redis.asyncio import Redis, RedisCluster

from gcache._internal.state import _GLOBAL_GCACHE_STATE
from gcache.exceptions import JsonEnvelopeRequiresSerializer, UseCaseNameIsReserved

#: Async callable that fetches the value on a miss. Zero-argument: ``Callable[..., ...]``
#: deferred the TypeError to the first cache miss. Bind args with functools.partial.
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
    from Python. ``JSON`` writes the cross-language envelope the Go and Go clients
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

    def wire_identity(self) -> Any:
        """What makes this instance interchangeable with another on the wire.

        Two serializers with equal identities are treated as reading each other's payloads,
        which is what lets a direct key and a ``@cached`` declaration share one ``use_case``.

        The default is the class, which is correct only for a STATELESS serializer --
        ``JsonSerializer`` and the like, where every instance produces the same bytes. A
        serializer configured per instance must override this, or two instances with
        different wire formats compare equal, share a urn, and each decodes the other's
        payload: a miss or a load failure with no error at registration to explain it.
        ``ProtoJsonSerializer`` overrides it with its message's full name for exactly this
        reason.

        Return anything hashable and stable across processes. Do NOT return something whose
        repr embeds an object address -- that would make two identical configurations
        compare unequal and reject a legitimate registration.
        """
        return type(self)


# Go writes this sentinel for `undefined`; mapping it to None keeps a TS-written
# entry readable. Unmapped, json.loads raises past the EnvelopeDecodeError guard and the
# entry never self-heals -- every read fails for the full TTL.
_TS_UNDEFINED_SENTINEL = "__gcache_json_undefined_v1__"


class JsonSerializer(Serializer):
    """JSON serializer, for values shared with non-Python readers.

    Pairs with ``Envelope.JSON``: that envelope carries a string payload, so a key using it
    needs a serializer that produces one. Only JSON-representable values work -- that is the
    trade for being readable outside Python.

    Reads are wire-compatible with the Go serializer, including its `undefined`
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
        # Inline on purpose: json.loads holds the GIL, so offloading a 5.3 MB payload moved
        # the max tick delay 0.007s -> 0.007-0.014s and starved getaddrinfo in the default
        # pool. ProtoJsonSerializer.load DOES offload -- it yields per field (0.104s -> 0.014s).
        return json.loads(data)


def render_prefix(key_type: str, id: str, *, tracked: bool) -> str:
    """Render ``[{]<urn_prefix>:<key_type>:<id>[}]``, the key's namespaced identity.

    Shared with RedisCache.invalidate, which needs the same string to build the watermark
    key. It used to build it by hand, and the two disagreed when urn_prefix was empty:
    this yields ``{kt:id}`` while the hand-rolled form yielded ``{:kt:id}``. That is a
    different cluster hash slot, so the value and its watermark stop sharing one and an
    invalidation silently never matches -- and Go's WatermarkKey guards the empty case, so
    Python was also the odd one out across languages.
    """
    rendered = f"{key_type}:{id}"
    if _GLOBAL_GCACHE_STATE.urn_prefix:
        rendered = f"{_GLOBAL_GCACHE_STATE.urn_prefix}:{rendered}"
    return "{" + rendered + "}" if tracked else rendered


@dataclass(frozen=True, slots=True)
class GCacheKey:
    key_type: str
    id: str
    use_case: str
    # SORTED and tupled in __post_init__, so what you read back is not what you passed.
    # Sorted because cached() and Go's ValueKey both do, so it is what is already on the
    # wire; tupled because key.args.append(...) left the rendered urn stale.
    args: Sequence[tuple[str, str]] = field(default_factory=tuple)
    invalidation_tracking: bool = False
    default_config: GCacheKeyConfig | None = None
    serializer: Serializer | None = None
    # Framing for WRITES; reads sniff what they find (a JSON key still refuses pickle).
    # Do NOT flip on a live use case -- both pod generations overwrite each other's framing
    # during a rolling deploy, pinning the hit rate near zero. Migrate under a new use_case.
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

        # JSON needs a serializer to produce its string payload. cached() rejects the pair
        # at decoration; a directly-built key was the route left open, failing per request
        # with Redis silently empty. GCacheError, so `except GCacheError` catches it.
        if self.envelope is Envelope.JSON and self.serializer is None:
            raise JsonEnvelopeRequiresSerializer(self.key_type, self.id, self.use_case)

        # "watermark" is reserved. cached() rejects it at decoration time; a key built
        # directly for aget/aput skipped that. With invalidation_tracking the urn is then
        # byte-identical to the key invalidate() writes, so a put would overwrite the
        # watermark with a cache value -- silently disabling invalidation for every use
        # case on that entity, and making the next tracked read raise on float().
        if self.use_case == "watermark":
            raise UseCaseNameIsReserved()

        # Sorted, matching what is already on the wire: cached() and Go's ValueKey both
        # sort, so this is idempotent for every existing key. Unsorting Go instead would
        # break parity with everything cached() ever wrote. Stable, so duplicates hold order.
        object.__setattr__(self, "args", tuple(sorted(self.args, key=lambda pair: pair[0])))

        prefix = render_prefix(self.key_type, self.id, tracked=self.invalidation_tracking)
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

    # Identity IS the rendered urn, i.e. the Redis key. The previous tuple omitted
    # invalidation_tracking, which braces the prefix -- so two keys addressing different
    # Redis keys compared equal and LocalCache served one for the other.
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
