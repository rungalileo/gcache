import asyncio
import functools
import inspect
import threading
from collections.abc import Awaitable, Callable, Generator
from contextlib import contextmanager
from functools import partial
from typing import Any

from gcache._internal.event_loop_thread import EventLoopThread, EventLoopThreadPool
from gcache._internal.local_cache import LocalCache
from gcache._internal.metrics import GCacheMetrics
from gcache._internal.noop_cache import NoopCache
from gcache._internal.redis_cache import RedisCache, create_default_redis_client_factory
from gcache._internal.state import _GLOBAL_GCACHE_STATE, GCacheContext
from gcache._internal.wrappers import CacheChain, CacheController, DisabledReasons
from gcache.config import (
    GCacheConfig,
    GCacheKey,
    GCacheKeyConfig,
    Serializer,
)
from gcache.exceptions import (
    GCacheAlreadyInstantiated,
    KeyArgDoesNotExist,
    RedisConfigConflict,
    ReentrantSyncFunctionDetected,
    UseCaseIsAlreadyRegistered,
    UseCaseNameIsReserved,
)


class GCache:
    """
    Main entry point for the GCache caching library.

    GCache provides a two-layer caching system (local in-memory + Redis) with
    support for both sync and async functions, cache invalidation, and
    configurable TTLs per use case.

    Only one GCache instance can exist at a time (singleton pattern).
    """

    def __init__(self, config: GCacheConfig) -> None:
        """
        Initialize GCache with the given configuration.

        :param config: Configuration object containing cache settings, Redis config,
                      and cache config provider.
        :raises GCacheAlreadyInstantiated: If a GCache instance already exists.
        :raises RedisConfigConflict: If both redis_config and redis_client_factory are provided.
        """
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

        # Validate and determine Redis cache layer
        if config.redis_config is not None and config.redis_client_factory is not None:
            raise RedisConfigConflict()

        if config.redis_config is not None:
            # redis_config provided: create RedisCache with factory from config
            redis_cache = CacheController(
                RedisCache(
                    config.cache_config_provider,
                    create_default_redis_client_factory(config.redis_config),
                ),
                config.cache_config_provider,
                metrics_prefix=config.metrics_prefix,
            )
        elif config.redis_client_factory is not None:
            # redis_client_factory provided: create RedisCache with custom factory
            redis_cache = CacheController(
                RedisCache(
                    config.cache_config_provider,
                    config.redis_client_factory,
                ),
                config.cache_config_provider,
                metrics_prefix=config.metrics_prefix,
            )
        else:
            # Both None: use NoopCache (no Redis layer)
            redis_cache = CacheController(
                NoopCache(config.cache_config_provider),
                config.cache_config_provider,
                metrics_prefix=config.metrics_prefix,
            )

        self._local_cache = local_cache
        self._redis_cache = redis_cache

        self._cache = CacheChain(config.cache_config_provider, local_cache, redis_cache)

        self._use_case_registry: set = set()

        # Use a thread pool to run non async cached functions in.
        # This is because all of the GCache implementation is async, but we still want to support caching
        # Sync functions.
        self._event_loop_thread_pool: EventLoopThreadPool = EventLoopThreadPool("gcache thread pool")

        _GLOBAL_GCACHE_STATE.gcache_instantiated = True

        self.config = config

    def __del__(self) -> None:
        self._event_loop_thread_pool.stop()
        _GLOBAL_GCACHE_STATE.gcache_instantiated = False

    def _run_coroutine_in_thread(self, coro: Callable[[], Awaitable[Any]], func_name: str = "") -> Any:
        if isinstance(threading.current_thread(), EventLoopThread):
            raise ReentrantSyncFunctionDetected()

        # Warn if sync cached function is called from async context (blocks event loop)
        try:
            asyncio.get_running_loop()
            _GLOBAL_GCACHE_STATE.logger.warning(
                f"Sync cached function '{func_name}' called from async context. "
                "This blocks the event loop. Consider using an async cached function instead."
            )
        except RuntimeError:
            pass  # No running loop - this is the normal/expected case

        return self._event_loop_thread_pool.submit(coro)

    @contextmanager
    def enable(self, enabled: bool = True) -> Generator[None]:
        """
        Enable or disable GCache for the duration of the context
        """
        prev_val = GCacheContext.enabled.get()
        GCacheContext.enabled.set(enabled)
        yield
        GCacheContext.enabled.set(prev_val)

    def cached(
        self,
        *,
        key_type: str,
        id_arg: str | tuple[str, Callable[[Any], str]],
        use_case: str | None = None,
        arg_adapters: dict[str, Callable[[Any], str]] | None = None,
        ignore_args: list[str] | None = None,
        track_for_invalidation: bool = False,
        default_config: GCacheKeyConfig | None = None,
        serializer: Serializer | None = None,
    ) -> Any:
        """
        Decorator which caches a function which can be either sync or async.

        Whether or not caching will be performed depends on the GCache context and use case configuration.

        Arguments to the eventual key are stringified function arguments by default.
        If you want to transform the args you can provide lambdas via id_arg and arg_adapters, which may be necessary where function argument
        is a big object but you only need one field from it to make cache key.

        :param key_type: Type of entity referred to by the id_arg.  Example: user_email, user_id, etc.
        :param id_arg: Name of the argument containing id of the entity or a tuple of name and lambda to extract the value.
        :param use_case: Unique name of the use case.  Defaults to model path + function name.
        :param arg_adapters: Dictionary of argname to an adapter, which is a Callable to extract the value for the arg,
             that can then be serialized for the entire cache key.
        :param ignore_args: List of args to ignore in cache key.
        :param track_for_invalidation: Boolean flag to indicate if the cache should track for invalidation.
        :param default_config: Default cache config that is used when cache config provider returns None.
        :param serializer: Optional serializer to use to serialize and deserialize cache values.  Care must be taken that
                           the returned value matches the signature of cached function, as otherwise you may get runtime
                           type/attribute errors.
        :return:
        """

        def decorator(func: Any) -> Any:
            nonlocal use_case
            nonlocal arg_adapters
            nonlocal ignore_args

            # Cache the function signature by defining it here.
            sig = inspect.signature(func)

            if use_case is None:
                use_case = f"{func.__module__}.{func.__name__}"

            if use_case in self._use_case_registry:
                raise UseCaseIsAlreadyRegistered(use_case)

            if use_case == "watermark":
                raise UseCaseNameIsReserved()

            self._use_case_registry.add(use_case)

            if arg_adapters is None:
                arg_adapters = {}

            if ignore_args is None:
                ignore_args = []

            adapter_for_key = not isinstance(id_arg, str)
            id_arg_name = id_arg[0] if adapter_for_key else id_arg

            # If name of id arg is in arg_adapters then we should include it in the cache key args.
            # Otherwise we should ignore it.
            should_skip_id_arg_in_args = id_arg_name not in arg_adapters

            def arg_transformer(name: str, value: Any) -> str:
                # Transform function arg name and its value by either invoking a given arg adapter
                # or just stringifying it.
                if arg_adapters and name in arg_adapters:
                    return str(arg_adapters[name](value))
                return str(value)

            async def async_wrapped(*args: Any, **kwargs: Any) -> Any:
                should_cache = True
                if not GCacheContext.enabled.get():
                    GCacheMetrics.DISABLED_COUNTER.labels(
                        use_case, key_type, "GLOBAL", DisabledReasons.context.name
                    ).inc()
                    should_cache = False
                try:
                    # Try to create GCacheKey by inspecting function arguments and transforming or ignoring
                    # as necessary.

                    bound_args = sig.bind(*args, **kwargs)
                    bound_args.apply_defaults()  # Apply default values if any

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
                        if (
                            not (should_skip_id_arg_in_args and name == id_arg_name)
                            and name != "self"
                            and name not in ignore_args
                        )
                    ]

                    sorted_args.sort(key=lambda x: x[0])

                    key = GCacheKey(
                        key_type=key_type,
                        id=key_id,
                        use_case=use_case,
                        args=sorted_args,
                        invalidation_tracking=track_for_invalidation,
                        default_config=default_config,
                        serializer=serializer,
                    )
                except Exception as e:
                    # Default to fallback but instrument the error as well as log.
                    _GLOBAL_GCACHE_STATE.logger.error("Could not construct key", exc_info=True)
                    GCacheMetrics.ERROR_COUNTER.labels(
                        use_case,
                        key_type,
                        "key creation",
                        type(e).__name__,
                        False,
                    ).inc()
                    should_cache = False

                if inspect.iscoroutinefunction(func):
                    if not should_cache:
                        return await func(*args, **kwargs)
                    f = partial(func, *args, **kwargs)
                else:
                    if not should_cache:
                        return func(*args, **kwargs)

                    async def f():  # type: ignore[no-untyped-def, misc]
                        return func(*args, **kwargs)

                return await self._cache.get(key, f)

            if inspect.iscoroutinefunction(func):
                return functools.wraps(func)(async_wrapped)
            else:

                def sync_wrapped(*args: Any, **kwargs: Any) -> Any:
                    if not GCacheContext.enabled.get():
                        GCacheMetrics.DISABLED_COUNTER.labels(
                            use_case, key_type, "GLOBAL", DisabledReasons.context.name
                        ).inc()
                        return func(*args, **kwargs)

                    return self._run_coroutine_in_thread(
                        partial(async_wrapped, *args, **kwargs),
                        func_name=f"{func.__module__}.{func.__name__}",
                    )

                return functools.wraps(func)(sync_wrapped)

        return decorator

    async def ainvalidate(self, key_type: str, id: str, future_buffer_ms: int = 0) -> None:
        """
        Invalidate all cache entries matching the given key type and ID (async version).

        :param key_type: The type of cache key to invalidate.
        :param id: The ID of the entity to invalidate.
        :param future_buffer_ms: Buffer time in milliseconds to extend invalidation into the future.
        """
        await self._redis_cache.invalidate(key_type, id, future_buffer_ms)

    def invalidate(self, key_type: str, id: str, future_buffer_ms: int = 0) -> None:
        """
        Invalidate all cache entries matching the given key type and ID (sync version).

        :param key_type: The type of cache key to invalidate.
        :param id: The ID of the entity to invalidate.
        :param future_buffer_ms: Buffer time in milliseconds to extend invalidation into the future.
        """
        return self._run_coroutine_in_thread(partial(self.ainvalidate, key_type, id, future_buffer_ms))

    async def aflushall(self) -> None:
        """
        Remove all local and remote cache entries.

        Useful for testing.
        :return:
        """
        await self._local_cache.flushall()
        await self._redis_cache.flushall()

    def flushall(self) -> None:
        """Remove all local and remote cache entries (sync version)."""
        self._run_coroutine_in_thread(self.aflushall)

    async def adelete(self, key: GCacheKey) -> bool:
        """
        Delete a specific cache entry (async version).

        :param key: The cache key to delete.
        :return: True if the key was deleted, False otherwise.
        """
        return await self._cache.delete(key)

    def delete(self, key: GCacheKey) -> bool:
        """
        Delete a specific cache entry (sync version).

        :param key: The cache key to delete.
        :return: True if the key was deleted, False otherwise.
        """
        return self._run_coroutine_in_thread(partial(self.adelete, key))
