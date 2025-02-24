import asyncio
import contextvars
import inspect
import pickle
import time
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable, Generator
from contextlib import contextmanager
from enum import Enum
from functools import partial
from logging import Logger, LoggerAdapter, getLogger
from random import random
from typing import Any

from cachetools import TTLCache
from prometheus_client import Counter, Histogram
from pydantic import BaseModel, ConfigDict
from redis.asyncio import Redis, RedisCluster

from cachegalileo.event_loop_thread import EventLoopThread


# Global state is needed to allow reconfiguration when GCache is instantiated.
# This is fine because GCache is gauranteed to be a singleton.
class GCacheGlobalState(BaseModel):
    urn_prefix: str = "urn"
    logger: Logger | LoggerAdapter = getLogger(__name__)
    gcache_instantiated: bool = False

    model_config = ConfigDict(arbitrary_types_allowed=True)


_GLOBAL_GCACHE_STATE = GCacheGlobalState()


class CacheLayer(Enum):
    LOCAL = "local"
    REMOTE = "remote"


class GCacheKeyConfig(BaseModel):
    use_case: str
    ttl_sec: dict[CacheLayer, int]
    ramp: dict[CacheLayer, int]

    @staticmethod
    def enabled(ttl_sec: int, use_case: str) -> "GCacheKeyConfig":
        """
        Return config that enabled cache with given ttl for all layers.
        :param ttl_sec:
        :param use_case:
        :return:
        """
        config = GCacheKeyConfig(use_case=use_case, ttl_sec={}, ramp={})
        for layer in CacheLayer:
            config.ttl_sec[layer] = ttl_sec
            config.ramp[layer] = 100
        return config


class GCacheContext:
    enabled: contextvars.ContextVar[bool] = contextvars.ContextVar("gcache_enabled", default=False)


class GCacheKey(BaseModel):
    key_type: str
    id: str
    use_case: str
    args: list[tuple[str, str]]
    invalidation_tracking: bool
    default_config: GCacheKeyConfig | None = None

    def __hash__(self) -> int:
        return str(self).__hash__()

    def __eq__(self, other: object) -> bool:
        return self.__hash__() == other.__hash__()

    def _args_to_str(self) -> str:
        if self.args:
            joined = "&".join([f"{arg[0]}={arg[1]}" for arg in self.args])
            return "?" + joined
        return ""

    @property
    def prefix(self) -> str:
        prefix = f"{self.key_type}:{self.id}"
        if _GLOBAL_GCACHE_STATE.urn_prefix:
            prefix = f"{_GLOBAL_GCACHE_STATE.urn_prefix}:{prefix}"
        if self.invalidation_tracking:
            prefix = "{" + prefix + "}"
        return prefix

    def __str__(self) -> str:
        return f"{self.prefix}{self._args_to_str()}#{self.use_case}"

    @property
    def urn(self) -> str:
        return str(self)


# Get cache config given a use case.
CacheConfigProvider = Callable[[GCacheKey], Awaitable[GCacheKeyConfig | None]]


class GCacheError(Exception):
    pass


class GCacheKeyConstructionError(GCacheError):
    pass


class GCacheAlreadyInstantiated(GCacheError):
    pass


class KeyArgDoesNotExist(GCacheKeyConstructionError):
    def __init__(self, id_arg: str):
        super().__init__(f"Key argument does not exist in cached function: {id_arg}")


class FuncArgDoesNotExist(GCacheError):
    def __init__(self, arg: str):
        super().__init__(f"Function argument does not exist in cached function: {arg}")


class GCacheDisabled(GCacheError):
    def __init__(self) -> None:
        super().__init__("GCache is disabled in this context.")


class UseCaseIsAlreadyRegistered(GCacheError):
    def __init__(self, use_case: str):
        super().__init__(f"Use case already registered: {use_case}")


class MissingKeyConfig(GCacheError):
    def __init__(self, use_case: str):
        super().__init__(f"Missing entire or partial (ttl/ramp) key config for use case: {use_case}")


class UseCaseNameIsReserved(GCacheError):
    def __init__(self) -> None:
        super().__init__("Use case name is reserved.")


Fallback = Callable[..., Awaitable[Any]]


class CacheInterface(ABC):
    def __init__(self, cache_config_provider: CacheConfigProvider):
        self.config_provider = cache_config_provider

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
        :param future_buffer_ms: Invalidate cache into the future.   Useful to avoid stale read -> write scenarious.0
        :return:
        """
        pass

    @abstractmethod
    def layer(self) -> CacheLayer:
        pass


class LocalCache(CacheInterface):
    _MAXSIZE = 10_000

    def __init__(self, cache_config_provider: CacheConfigProvider):
        super().__init__(cache_config_provider)
        # Dict of usecase -> ttl cache instance.
        self.caches: dict[str, TTLCache] = {}
        self.lock = asyncio.Lock()

    async def _get_ttl_cache(self, key: GCacheKey) -> TTLCache:
        cache = self.caches.get(key.use_case, None)
        if cache is None:
            config = await self.config_provider(key)

            if config is None:
                config = key.default_config

            if config is None:
                raise MissingKeyConfig(key.use_case)

            async with self.lock:
                # See if cache was already created by another worker.
                cache = self.caches.get(key.use_case, None)
                if cache is None:
                    self.caches[key.use_case] = cache = TTLCache(
                        maxsize=self._MAXSIZE, ttl=config.ttl_sec[self.layer()]
                    )

        return cache

    async def get(self, key: GCacheKey, fallback: Fallback) -> Any:
        _GLOBAL_GCACHE_STATE.logger.debug("Calling local cache")
        cache = await self._get_ttl_cache(key)

        if key not in cache:
            await self.put(key, await fallback())

        return cache[key]

    async def put(self, key: GCacheKey, value: Any) -> None:
        (await self._get_ttl_cache(key))[key] = value

    async def delete(self, key: GCacheKey) -> bool:
        try:
            (await self._get_ttl_cache(key)).pop(key)
        except KeyError:
            return False
        return True

    def layer(self) -> CacheLayer:
        return CacheLayer.LOCAL


class RedisConfig(BaseModel):
    username: str = ""
    password: str = ""
    host: str = "localhost"
    port: int = 6379
    # protocol is either redis or rediss
    protocol: str = "redis"
    cluster: bool = False

    socket_connect_timeout: int = 1
    socket_timeout: int = 1
    retry_on_timeout: bool = True

    @property
    def url(self) -> str:
        return f"{self.protocol}://{self.username}:{self.password}@{self.host}:{self.port}"


class RedisSerializedValue(BaseModel):
    created_at_ms: int
    payload: Any


class RedisCache(CacheInterface):
    WATERMARKS_TTL_SEC = 3600 * 4  # 4 hours

    def __init__(self, cache_config_provider: CacheConfigProvider, config: RedisConfig):
        super().__init__(cache_config_provider)
        self.client: RedisCluster | Redis

        # These options are super important for Redis failovers
        self.client = (
            RedisCluster.from_url(
                config.url,
                socket_connect_timeout=config.socket_connect_timeout,
                socket_timeout=config.socket_timeout,
                max_connections=100,
            )
            if config.cluster
            else Redis.from_url(
                config.url,
                socket_connect_timeout=config.socket_connect_timeout,
                socket_timeout=config.socket_timeout,
                max_connections=100,
            )
        )

    async def _exec_fallback(self, key: GCacheKey, fallback: Fallback) -> Any:
        """
        Execute fallback and store it in cache then return it's return value.
        :param fallback:
        :return:
        """
        val = await fallback()
        await self.put(key, val)
        return val

    async def invalidate(self, key_type: str, id: str, future_buffer_ms: int) -> None:
        key = "{" + _GLOBAL_GCACHE_STATE.urn_prefix + ":" + key_type + ":" + id + "}#watermark"
        exp_ms = int(time.time() * 1000 + future_buffer_ms)
        await self.client.setex(key, self.WATERMARKS_TTL_SEC, exp_ms)

    async def get(self, key: GCacheKey, fallback: Fallback) -> Any:
        _GLOBAL_GCACHE_STATE.logger.debug("Calling Redis Cache")
        watermark = None
        if key.invalidation_tracking:
            vals = await self.client.mget(key.urn, key.prefix + "#watermark")
            val_pickle = vals[0]
            watermark = vals[1]
        else:
            val_pickle = await self.client.get(key.urn)
        if val_pickle is not None:
            start_ns = time.time_ns()
            serialized_value: RedisSerializedValue = pickle.loads(val_pickle)

            # Check if cache val is expired.
            if watermark is not None:
                watermark = int(watermark)
                if watermark >= serialized_value.created_at_ms:
                    return await self._exec_fallback(key, fallback)

            _GLOBAL_GCACHE_STATE.logger.debug(f"Got value from Redis in {(time.time_ns() - start_ns) / 1e9} sec")
            return serialized_value.payload
        else:
            return await self._exec_fallback(key, fallback)

    async def put(self, key: GCacheKey, value: Any) -> None:
        config = await self.config_provider(key)

        if config is None:
            config = key.default_config

        if config is None:
            raise MissingKeyConfig(key.use_case)

        current_time_ms = int(time.time() * 1000)
        val_pickle = pickle.dumps(RedisSerializedValue(created_at_ms=current_time_ms, payload=value))

        CacheController.CACHE_SIZE_HISTOGRAM.labels(key.use_case, key.key_type, self.layer().name).observe(
            len(val_pickle)
        )

        ttl = config.ttl_sec.get(self.layer(), None)
        if ttl is None:
            raise MissingKeyConfig(key.use_case)

        await self.client.setex(key.urn, ttl, val_pickle)

    async def delete(self, key: GCacheKey) -> bool:
        return (await self.client.delete(key.urn)) > 0

    def layer(self) -> CacheLayer:
        return CacheLayer.REMOTE


class CacheWrapper(CacheInterface):
    """
    Abstract class for wrapper implementations.

    Wrappers can be used to add more functionality to a caching layer, like insturmentation, controls, etc.
    """

    def __init__(self, cache_config_provider: CacheConfigProvider, cache: CacheInterface):
        super().__init__(cache_config_provider)
        self.wrapped = cache

    def layer(self) -> CacheLayer:
        return self.wrapped.layer()

    async def put(self, key: GCacheKey, value: Any) -> None:
        return await self.wrapped.put(key, value)

    async def delete(self, key: GCacheKey) -> bool:
        return await self.wrapped.delete(key)

    async def invalidate(self, key_type: str, id: str, future_buffer_ms: int = 0) -> None:
        return await self.wrapped.invalidate(key_type, id, future_buffer_ms)


class CacheController(CacheWrapper):
    """
    Control cache execution and instrument cache hit ratio.
    """

    CACHE_DISABLED_COUNTER: Counter = None  # type: ignore[assignment]
    CACHE_MISS_COUNTER: Counter = None  # type: ignore[assignment]
    CACHE_REQUEST_COUNTER: Counter = None  # type: ignore[assignment]
    CACHE_ERROR_COUNTER: Counter = None  # type: ignore[assignment]

    CACHE_GET_TIMER: Histogram = None  # type: ignore[assignment]
    CACHE_FALLBACK_TIMER: Histogram = None  # type: ignore[assignment]

    CACHE_SIZE_HISTOGRAM: Histogram = None  # type: ignore[assignment]

    def __init__(
        self,
        cache: CacheInterface,
        cache_config_provider: CacheConfigProvider,
        metrics_prefix: str = "",
    ):
        super().__init__(cache_config_provider, cache)

        if CacheController.CACHE_REQUEST_COUNTER is None:
            CacheController.CACHE_DISABLED_COUNTER = Counter(
                name=metrics_prefix + "gcache_disabled_counter",
                labelnames=["use_case", "key_type", "layer"],
                documentation="Cache disabled counter",
            )

            CacheController.CACHE_MISS_COUNTER = Counter(
                name=metrics_prefix + "gcache_miss_counter",
                labelnames=["use_case", "key_type", "layer"],
                documentation="Cache miss counter",
            )

            CacheController.CACHE_REQUEST_COUNTER = Counter(
                name=metrics_prefix + "gcache_request_counter",
                labelnames=["use_case", "key_type", "layer"],
                documentation="Cache request counter",
            )
            CacheController.CACHE_ERROR_COUNTER = Counter(
                name=metrics_prefix + "gcache_error_counter",
                labelnames=["use_case", "key_type", "layer", "error", "in_fallback"],
                documentation="Cache error counter",
            )
            CacheController.CACHE_GET_TIMER = Histogram(
                name=metrics_prefix + "gcache_get_timer",
                labelnames=["use_case", "key_type", "layer"],
                documentation="Cache get timer",
                buckets=[0.001] + list(Histogram.DEFAULT_BUCKETS),
            )
            CacheController.CACHE_FALLBACK_TIMER = Histogram(
                name=metrics_prefix + "gcache_fallback_timer",
                labelnames=["use_case", "key_type", "layer"],
                documentation="Fallback timer",
                buckets=[0.001] + list(Histogram.DEFAULT_BUCKETS),
            )

            CacheController.CACHE_SIZE_HISTOGRAM = Histogram(
                name=metrics_prefix + "gcache_size_histogram",
                labelnames=["use_case", "key_type", "layer"],
                documentation="Cache size histogram",
                buckets=[100, 1000, 10_000, 100_000, 1_000_000, 10_000_000],
            )

    async def get(self, key: GCacheKey, fallback: Fallback) -> Any:
        if await self._should_cache(key):
            start_time = time.monotonic()
            try:
                self.CACHE_REQUEST_COUNTER.labels(key.use_case, key.key_type, self.layer().name).inc()

                fallback_failed = False

                async def instrumented_fallback() -> Any:
                    nonlocal fallback_failed
                    start_fallback = time.monotonic()
                    try:
                        self.CACHE_MISS_COUNTER.labels(key.use_case, key.key_type, self.layer().name).inc()
                        try:
                            return await fallback()
                        except:
                            fallback_failed = True
                            raise
                    finally:
                        self.CACHE_FALLBACK_TIMER.labels(key.use_case, key.key_type, self.layer().name).observe(
                            time.monotonic() - start_fallback
                        )

                try:
                    return await self.wrapped.get(key, instrumented_fallback)
                except Exception as e:
                    _GLOBAL_GCACHE_STATE.logger.error(f"Error getting value from cache: {e}", exc_info=True)
                    self.CACHE_ERROR_COUNTER.labels(
                        key.use_case,
                        key.key_type,
                        self.layer().name,
                        type(e).__name__,
                        fallback_failed,
                    ).inc()
                    if not fallback_failed:
                        return await fallback()
                    else:
                        raise
            finally:
                self.CACHE_GET_TIMER.labels(key.use_case, key.key_type, self.layer().name).observe(
                    time.monotonic() - start_time
                )
        else:
            return await fallback()

    async def _should_cache(self, key: GCacheKey) -> bool:
        if not GCacheContext.enabled.get():
            return False
        config = await self.config_provider(key)
        if config is None:
            config = key.default_config

        if config is None:
            raise MissingKeyConfig(key.use_case)

        ramp = config.ramp.get(self.layer(), 0)
        r = int(random() * 100)
        if r <= ramp:
            return True
        CacheController.CACHE_DISABLED_COUNTER.labels(key.use_case, key.key_type, self.layer())
        return False


class CacheChain(CacheWrapper):
    def __init__(
        self,
        cache_config_provider: CacheConfigProvider,
        cache: CacheInterface,
        fallback_cache: CacheInterface,
    ):
        super().__init__(cache_config_provider, cache)
        self.fallback_cache = fallback_cache

    async def get(self, key: GCacheKey, fallback: Fallback) -> Any:
        async def cache_fallback() -> Any:
            return await self.fallback_cache.get(key, fallback)

        return await self.wrapped.get(key, cache_fallback)


class GCacheConfig(BaseModel):
    cache_config_provider: CacheConfigProvider
    urn_prefix: str | None = None
    metrics_prefix: str = "api_"
    redis_config: RedisConfig = RedisConfig()
    logger: Logger | LoggerAdapter | None = None

    model_config = ConfigDict(arbitrary_types_allowed=True)


class GCache:
    def __init__(self, config: GCacheConfig):
        if _GLOBAL_GCACHE_STATE.gcache_instantiated:
            raise GCacheAlreadyInstantiated()

        if config.urn_prefix:
            _GLOBAL_GCACHE_STATE.urn_prefix = config.urn_prefix

        if config.logger:
            _GLOBAL_GCACHE_STATE.logger = config.logger

        local_cache = CacheController(
            LocalCache(config.cache_config_provider),
            config.cache_config_provider,
            metrics_prefix=config.metrics_prefix,
        )

        redis_cache = CacheController(
            RedisCache(config.cache_config_provider, config.redis_config),
            config.cache_config_provider,
            metrics_prefix=config.metrics_prefix,
        )

        self._redis_cache = redis_cache

        self._cache = CacheChain(config.cache_config_provider, local_cache, redis_cache)

        self._use_case_registry: set = set()

        # Don't create and start here, but lazy load later.
        # This is necessary in forked environments, since we don't want to start a thread before forkinge
        self._event_loop_thread_instance: EventLoopThread = None  # type: ignore[assignment]

        _GLOBAL_GCACHE_STATE.gcache_instantiated = True

    def __del__(self) -> None:
        self._event_loop_thread.stop()
        _GLOBAL_GCACHE_STATE.gcache_instantiated = False

    def _run_coroutine_in_thread(self, coro: Callable[[], Awaitable[Any]]) -> Any:
        return self._event_loop_thread.submit(coro)

    @property
    def _event_loop_thread(self) -> EventLoopThread:
        if self._event_loop_thread_instance is None:
            _GLOBAL_GCACHE_STATE.logger.info("Initializing event thread loop")
            self._event_loop_thread_instance = EventLoopThread()
            self._event_loop_thread_instance.start()
        return self._event_loop_thread_instance

    @contextmanager
    def enable(self) -> Generator[None]:
        """
        Enable GCache for the duration of the context
        """
        GCacheContext.enabled.set(True)
        yield
        GCacheContext.enabled.set(False)

    def cached(
        self,
        *,
        key_type: str,
        id_arg: str | tuple[str, Callable[[Any], str]],
        use_case: str | None = None,
        arg_adapters: dict[str, Callable[[Any], str]] | None = None,
        ignore_args: list[str] = [],
        track_for_invalidation: bool = False,
        default_config: GCacheKeyConfig | None = None,
    ) -> Any:
        """
        Decorator which caches a function which can be either sync or async.

        Whether or not caching will be perofrmed depends on the GCache context and use case configuration.

        Arguments to the eventual key are stringified function arguments by default.
        If you want to transform the args you can provide lambdas, which maybe becessary where function argument
        is a big object but you only need one field from it to make cache key.

        :param key_type: Type of entity referred to by the id_arg.  Example: user_email, user_id, etc.
        :param id_arg: name of the argument containing id of the entity or a tuple of name and lambda to extract the value.
        :param use_case: Unique name of the use case.  Defaults to model path + function name.
        :param arg_adapters: Dictionary of argname to an adapter, which is a Callable to extract the value for the arg,
             that can then be serialized for the entire cache key.
        :param ignore_args: List of args to ignore in cache key.
        :param track_for_invalidation: Boolean flag to indicate if the cache should track for invalidation.
        :param default_config: Default cache config that is used when cache config provider returns None.
        :return:
        """

        def decorator(func: Any) -> Any:
            nonlocal use_case

            # Cache the function signature by defining it here.
            sig = inspect.signature(func)

            if use_case is None:
                use_case = f"{func.__module__}.{func.__name__}"

            if use_case in self._use_case_registry:
                raise UseCaseIsAlreadyRegistered(use_case)

            if use_case == "watermark":
                raise UseCaseNameIsReserved()

            self._use_case_registry.add(use_case)

            def arg_transformer(name: str, value: Any) -> str:
                # Transform function arg name and its value by either invoking a given arg adapter
                # or just stringifying it.
                if arg_adapters and name in arg_adapters:
                    return str(arg_adapters[name](value))
                return str(value)

            async def async_wrapped(*args: Any, **kwargs: Any) -> Any:
                if not GCacheContext.enabled:
                    CacheController.CACHE_DISABLED_COUNTER.labels(use_case, key_type, "GLOBAL")
                    return await func(*args, **kwargs)
                try:
                    # Try to create GCacheKey by inspecting function arguments and transforming or ignoring
                    # as necessary.

                    bound_args = sig.bind(*args, **kwargs)
                    bound_args.apply_defaults()  # Apply default values if any

                    adapter_for_key = not isinstance(id_arg, str)

                    id_arg_name = id_arg[0] if adapter_for_key else id_arg

                    if id_arg_name in kwargs:
                        key_id = kwargs[id_arg_name]  # type: ignore[index]
                    else:
                        try:
                            key_id = bound_args.arguments[id_arg_name]  # type: ignore[index]
                        except KeyError:
                            raise KeyArgDoesNotExist(id_arg_name)  # type: ignore[arg-type]

                    if adapter_for_key:
                        key_id = id_arg[1](key_id)  # type: ignore[operator]

                    key_id = str(key_id)

                    sorted_args = [
                        (name, arg_transformer(name, value))
                        for name, value in bound_args.arguments.items()
                        if name != id_arg_name and name != "self" and name not in ignore_args
                    ]

                    sorted_args.sort(key=lambda x: x[0])

                    key = GCacheKey(
                        key_type=key_type,
                        id=key_id,
                        use_case=use_case,
                        args=sorted_args,
                        invalidation_tracking=track_for_invalidation,
                        default_config=default_config,
                    )
                except Exception as e:
                    if isinstance(e, GCacheError):
                        raise e
                    raise GCacheKeyConstructionError("Could not construct gcache key") from e

                if inspect.iscoroutinefunction(func):
                    f = partial(func, *args, **kwargs)
                else:

                    async def f():  # type: ignore[no-untyped-def, misc]
                        return func(*args, **kwargs)

                return await self._cache.get(key, f)

            if inspect.iscoroutinefunction(func):
                return async_wrapped
            else:

                def sync_wrapped(*args: Any, **kwargs: Any) -> Any:
                    if not GCacheContext.enabled:
                        CacheController.CACHE_DISABLED_COUNTER.labels(use_case, key_type, "GLOBAL")
                        return func(*args, **kwargs)

                    return self._run_coroutine_in_thread(partial(async_wrapped, *args, **kwargs))

                return sync_wrapped

        return decorator

    async def ainvalidate(self, key_type: str, id: str, fallback_buffer_ms: int = 0) -> None:
        await self._redis_cache.invalidate(key_type, id, fallback_buffer_ms)

    def invalidate(self, key_type: str, id: str, fallback_buffer_ms: int = 0) -> None:
        return self._run_coroutine_in_thread(partial(self.ainvalidate, key_type, id, fallback_buffer_ms))
