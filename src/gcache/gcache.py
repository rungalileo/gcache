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
    Envelope,
    Fallback,
    GCacheConfig,
    GCacheKey,
    GCacheKeyConfig,
    Serializer,
)
from gcache.exceptions import (
    EnvelopeMismatchWithRegisteredUseCase,
    GCacheAlreadyInstantiated,
    GCacheError,
    GCacheKeyPrefixMismatch,
    KeyArgDoesNotExist,
    RedisConfigConflict,
    ReentrantSyncFunctionDetected,
    SerializerMismatchWithRegisteredUseCase,
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

        # Deliberately still a set. Consumers reach into this private attribute to reset it
        # between tests (orbit's services/api/tests/conftest.py does `gcache
        # ._use_case_registry = set()`), so changing its type breaks them at a distance --
        # which is exactly what happened when this was a dict for one commit. The declared
        # envelope lives alongside it instead.
        self._use_case_registry: set[str] = set()
        # use_case -> what the decorator declared for it, for _check_direct_key.
        # Consulted only for names still in _use_case_registry, so a consumer that resets
        # the registry makes this inert too rather than leaving a stale rule behind.
        self._use_case_envelopes: dict[str, Envelope] = {}
        self._use_case_serializers: dict[str, Serializer | None] = {}

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
        envelope: Envelope | str = Envelope.PICKLE,
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

                           Do NOT add this to a live use case either.  A serialized payload is indistinguishable from a
                           normally-cached value once it is inside a pickle envelope, so a pod running the older code --
                           same use case, no serializer -- hands the raw payload back to its caller instead of the value,
                           silently.  A JSON envelope is caught (the reader knows it needs a serializer and treats the
                           entry as a miss); the pickle case cannot be detected at all.  Migrate under a new ``use_case``.
        :param envelope: How the value is framed in Redis.  ``Envelope.PICKLE`` (the default) serializes arbitrary
                         Python objects but is readable only from Python.  ``Envelope.JSON`` writes the same envelope
                         the TypeScript and Go clients use, so the entry can be shared across languages; it requires a
                         ``Serializer`` producing str/bytes (pass ``serializer=JsonSerializer()``).  Reads sniff the
                         framing they actually find, so a JSON key still reads a JSON entry written by any language --
                         but a JSON key refuses to unpickle, rather than leaving unpickling reachable for whoever can
                         write the keyspace.

                         Do NOT flip this on a live use case.  A rolling deploy runs both pod generations at once: an
                         old pod (pickle, no serializer) treats a JSON entry as a miss and writes pickle over it, and a
                         new pod refuses that pickle and writes JSON again.  Each destroys the framing the other needs,
                         so the key's hit rate sits near zero for the whole rollout -- a load spike on the backing
                         store, not a slow warm-up.  Migrate under a NEW ``use_case``; the two generations then use
                         different keys and never fight.

                         Note also that cross-language invalidation reaches the REDIS layer only.  ``ainvalidate``
                         writes a watermark, and ``LocalCache`` does not read watermarks, so a Go or TypeScript
                         invalidation does not clear a Python pod's in-process copy until the local TTL expires.  For a
                         use case shared across languages, keep the local TTL short or set the local ramp to 0.
        :return:
        """

        # Accept the bare string an untyped caller passes, but resolve it here so an
        # unrecognized value raises instead of silently falling back to pickle -- the whole
        # point of declaring an envelope is that both languages agree on the framing.
        envelope = Envelope(envelope)

        # Fail at decoration rather than per-request: Envelope.JSON with no serializer can
        # never produce a valid entry, and it is knowable at decoration. Deferring it to
        # call time yields a TypeError plus an error log on every single call instead.
        #
        # Raised inside `decorator`, not here, so the default use case has resolved to
        # module.function by then -- at this point it is still None, and the message would
        # name no code at all.

        def decorator(func: Any) -> Any:
            nonlocal use_case
            nonlocal arg_adapters
            nonlocal ignore_args

            # Cache the function signature by defining it here.
            sig = inspect.signature(func)

            if use_case is None:
                use_case = f"{func.__module__}.{func.__name__}"

            if envelope == Envelope.JSON and serializer is None:
                raise ValueError(
                    f"use case {use_case!r}: envelope=Envelope.JSON requires a Serializer producing "
                    "str or bytes (pass serializer=JsonSerializer())"
                )

            if use_case in self._use_case_registry:
                raise UseCaseIsAlreadyRegistered(use_case)

            if use_case == "watermark":
                raise UseCaseNameIsReserved()

            self._use_case_registry.add(use_case)
            self._use_case_envelopes[use_case] = envelope
            self._use_case_serializers[use_case] = serializer

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
                        envelope=envelope,
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

    def _check_direct_key(self, key: GCacheKey) -> None:
        """Raise when a direct key can never share entries with what declared its use case.

        Both render the same urn, so they are ONE entry, and the two halves of the framing
        contract have to agree:

        * ``envelope`` -- the decorator writes pickle, the direct key refuses that pickle
          and writes JSON, the decorator calls the JSON a miss and writes pickle again.
          They overwrite each other forever inside one process.
        * ``serializer`` -- subtler and worse, because nothing even degrades. A decorator
          with no serializer plus a direct key carrying JsonSerializer share one entry, and
          the decorated function gets handed the raw payload ``'{"a": 1}'`` where it
          expected a ``dict``. No exception, no log line, no metric.

        Only checked against a REGISTERED use case. A direct-only use case has nothing to
        compare against, which is why both still have to agree by convention across
        languages -- there the library cannot see the other side at all.
        """
        if key.use_case in self._use_case_registry:
            declared = self._use_case_envelopes.get(key.use_case)
            if declared is not None and declared != key.envelope:
                raise EnvelopeMismatchWithRegisteredUseCase(key.use_case, declared, key.envelope)

            # Compared by TYPE: serializers are instances and two JsonSerializer()s are
            # never ==, so identity or equality would reject every legitimate caller.
            declared_ser = self._use_case_serializers.get(key.use_case)
            if type(declared_ser) is not type(key.serializer):
                raise SerializerMismatchWithRegisteredUseCase(key.use_case, declared_ser, key.serializer)

        # A key built BEFORE GCache() ran captured the default urn_prefix, while
        # ainvalidate uses the configured one -- so the value and its watermark land in
        # different namespaces (and different cluster hash slots) and tracked invalidation
        # silently does nothing. Checked here rather than forbidden at construction: a
        # module-level key constant is the natural thing to write and the only thing that
        # reaches this state.
        live = _GLOBAL_GCACHE_STATE.urn_prefix
        if key.urn_prefix != live:
            raise GCacheKeyPrefixMismatch(key.use_case, key.urn_prefix, live)

    async def aget(self, key: GCacheKey, fallback: Fallback) -> Any:
        """
        Read one key, computing and caching the value on a miss (async version).

        Use ``@cached`` when the value is a pure function of a call's arguments. This is
        for what it cannot express: an entry in a cache SHARED with another service,
        where the key comes from data that is not this function's parameters. Go's client
        has always had a plain ``Get``; without this, a Python participant had to reach
        into ``_internal`` or read its source of truth twice on a miss.

        ``fallback`` runs only on a miss, so a caller can capture what it fetched there
        and reuse it instead of reading again::

            fetched = None

            async def _load():
                nonlocal fetched
                fetched = await expensive_read()
                return identity_of(fetched)

            identity = await gcache.aget(key, _load)   # fetched is set only on a miss

        :param key: ``key_type``, ``id``, ``args`` and ``use_case`` are the key space --
            get any of them wrong and the two languages never see each other's entries.
            ``envelope`` and ``serializer`` are NOT in the key, which is worse: both
            clients then share one key with incompatible framing, so each overwrites the
            other and neither can read what it finds.
        :param fallback: Async callable invoked on a miss to produce the value.
        :return: The cached value, or whatever ``fallback`` returned.
        """
        # Fails OPEN, unlike aput. A misconfigured key is a programming error, but the
        # README's Error Handling contract is that a read never breaks the caller's
        # request, and the decorator path already honours it: it catches key-construction
        # failures, logs, counts gcache_error_counter and runs the function uncached. A
        # direct read that raised where a decorated one degraded would be the same
        # misconfiguration failing two different ways.
        #
        # The counter is what makes it visible -- silently uncached forever is how this
        # reaches production otherwise.
        try:
            self._check_direct_key(key)
        except GCacheError as e:
            _GLOBAL_GCACHE_STATE.logger.error("Direct key is unusable; reading uncached", exc_info=True)
            GCacheMetrics.ERROR_COUNTER.labels(
                key.use_case, key.key_type, "direct key check", type(e).__name__, False
            ).inc()
            return await fallback()
        return await self._cache.get(key, fallback)

    def get(self, key: GCacheKey, fallback: Fallback) -> Any:
        """Read one key, computing and caching the value on a miss (sync version)."""
        return self._run_coroutine_in_thread(partial(self.aget, key, fallback))

    async def aput(self, key: GCacheKey, value: Any) -> None:
        """
        Write one key without reading it first (async version).

        For priming: the caller already knows the value and wants other services to find
        it without paying the read that would otherwise populate the entry. Go's ``Put``
        is the counterpart. See :meth:`aget` on matching a shared entry's key.

        Unlike a read, this RAISES on a cache-layer failure -- a Redis timeout reaches the
        caller. That matches :meth:`adelete` and :meth:`ainvalidate`, and it is deliberate:
        a silent failure here means the entry another process is waiting for never appears.
        A caller priming off a request path should not let that propagate.

        A prime landing inside an active invalidation window is lost **on the Redis layer**,
        silently: the entry is written with ``createdAtMs`` below the watermark, so remote
        reads find it stale until the window closes and a read rewrites it. That is the
        invalidation doing its job, but this call still returns normally. Go's ``Put``
        behaves the same way; the TypeScript client is the outlier and returns ``false``.
        Checking here would cost an extra round trip on every prime.

        The LOCAL layer does NOT honour that -- it never reads watermarks -- so a later
        ``aget`` in the same process takes a local hit and returns the primed value as if
        nothing had been invalidated. Keep the local ramp at 0 for any use case shared
        across processes or languages, which is what the README already advises.
        """
        self._check_direct_key(key)
        await self._cache.put(key, value)

    def put(self, key: GCacheKey, value: Any) -> None:
        """Write one key without reading it first (sync version). Raises like :meth:`aput`."""
        self._run_coroutine_in_thread(partial(self.aput, key, value))

    async def adelete(self, key: GCacheKey) -> bool:
        """
        Delete a specific cache entry (async version).

        Raises on an unusable key, like :meth:`aput` and unlike :meth:`aget`. Returning
        ``False`` would be a lie a caller cannot detect: a key carrying a stale
        ``urn_prefix`` deletes a urn in the wrong namespace, reports "no entry existed",
        and leaves the real entry in place.

        :param key: The cache key to delete.
        :return: True if the key was deleted, False otherwise.
        """
        self._check_direct_key(key)
        return await self._cache.delete(key)

    def delete(self, key: GCacheKey) -> bool:
        """
        Delete a specific cache entry (sync version).

        :param key: The cache key to delete.
        :return: True if the key was deleted, False otherwise.
        """
        return self._run_coroutine_in_thread(partial(self.adelete, key))
