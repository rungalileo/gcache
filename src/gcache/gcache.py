import asyncio
import functools
import inspect
import threading
from collections.abc import Awaitable, Callable, Generator
from contextlib import contextmanager
from functools import partial
from typing import Any

from gcache._internal.constants import validate_invalidation_args
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
    EmptyUrnPrefixNotSupported,
    EnvelopeMismatchWithRegisteredUseCase,
    GCacheAlreadyInstantiated,
    GCacheError,
    GCacheKeyPrefixMismatch,
    JsonEnvelopeRequiresSerializer,
    KeyArgDoesNotExist,
    RedisConfigConflict,
    ReentrantSyncFunctionDetected,
    SerializerMismatchWithRegisteredUseCase,
    UrnPrefixContainsDelimiter,
    UseCaseIsAlreadyRegistered,
    UseCaseNameIsReserved,
)


def _serializer_identity(serializer: Serializer | None) -> Any:
    """What makes two serializers interchangeable on the wire.

    Type alone is not enough: two ProtoSerializers carrying different messages share a
    type, and reading one's payload as the other yields an empty message with no error,
    because load() passes ignore_unknown_fields=True.

    This used to special-case that by reaching for ``_message_type``, and its docstring
    claimed any other Serializer "contributes only its type, which is all it has". That is
    false for a stateful serializer, and the claim was the bug: a caller's serializer
    configured per instance -- a compression level, a schema version, an encoding -- had two
    instances compare EQUAL, pass _check_direct_key, share a urn, and each decode the
    other's payload.

    So the decision belongs to the serializer. ``Serializer.wire_identity`` defaults to the
    class, which keeps every stateless implementation behaving exactly as before, and
    ProtoSerializer overrides it rather than being reached into from here.
    """
    if serializer is None:
        return None
    return serializer.wire_identity()


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
        :raises EmptyUrnPrefixNotSupported: If urn_prefix is "" -- an empty prefix cannot
            interoperate, since Python renders ``kt:id`` where Go renders ``:kt:id``.
        """
        # Pure config validation BEFORE the singleton check: with the order reversed a live
        # GCache made this branch unreachable in-process, so the test could only assert on
        # inspect.getsource -- which stays green if the condition changes and the text stays.
        if config.urn_prefix == "":
            # An empty prefix is not merely unusual, it cannot interoperate: Python renders
            # "kt:id" and Go ":kt:id". See EmptyUrnPrefixNotSupported. An earlier
            # revision of this branch "fixed" the silent-ignore by honouring "", which
            # enabled a configuration that silently breaks the cross-language keyspace this
            # work exists to establish. Rejecting is the fix; honouring it was not.
            raise EmptyUrnPrefixNotSupported()
        if config.urn_prefix is not None and any(ch in config.urn_prefix for ch in "{}#?"):
            # Go's New refuses the same set, so accepting them here produced a prefix Python
            # writes and Go cannot construct a client for.
            raise UrnPrefixContainsDelimiter(config.urn_prefix)

        if config.redis_config is not None and config.redis_client_factory is not None:
            raise RedisConfigConflict()

        if _GLOBAL_GCACHE_STATE.gcache_instantiated:
            raise GCacheAlreadyInstantiated()

        # VALIDATE BEFORE TOUCHING GLOBAL STATE. The assignments below used to sit above the
        # Redis checks, so a RedisConfigConflict left the new urn_prefix and logger published
        # while no GCache existed -- the next construction inherited a namespace from an
        # attempt that failed. __del__ clears only gcache_instantiated, so nothing ever put
        # them back.

        if config.urn_prefix is not None:
            _GLOBAL_GCACHE_STATE.urn_prefix = config.urn_prefix

        if config.logger:
            _GLOBAL_GCACHE_STATE.logger = config.logger

        local_cache = CacheController(
            LocalCache(config.cache_config_provider),
            config.cache_config_provider,
            metrics_prefix=config.metrics_prefix,
        )

        # Determine the Redis cache layer. The conflict check moved above, before any global
        # state is published; leaving a second copy here would be dead code.
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
        # between tests (a consumer's test conftest does `gcache
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
        _GLOBAL_GCACHE_STATE.gcache_owner_id = id(self)

        self.config = config

    def __del__(self) -> None:
        """Tear down only what __init__ actually built.

        ``gcache_instantiated`` is set on the LAST line of __init__, so any earlier raise --
        GCacheAlreadyInstantiated, EmptyUrnPrefixNotSupported, RedisConfigConflict -- still
        gets this object finalized, with no ``_event_loop_thread_pool`` attribute. The
        unguarded ``.stop()`` raised AttributeError here, which appears twice in every test
        run as a PytestUnraisableExceptionWarning.

        The noise was the smaller half. The AttributeError is also the only reason the next
        line was not reached, and that line clears a flag this instance does not own: a
        failed construction would otherwise mark the LIVE GCache as uninstantiated, letting a
        third be built alongside it. So the guard is load-bearing, not cosmetic -- and the
        ownership check is what makes it safe rather than merely quiet.

        Pre-existing, but in scope here because this branch adds two new early raises and so
        widens the path that reaches it.
        """
        pool = getattr(self, "_event_loop_thread_pool", None)
        if pool is None:
            # __init__ raised before construction completed. Nothing was published under this
            # object's name, so there is nothing to undo and the flag is not ours to clear.
            return

        # Stopping the pool is always right -- it is this object's own resource.
        pool.stop()

        # Only clear the flag if this object still OWNS it: a pool proves __init__ finished,
        # not that we are still the registered instance. Otherwise a stale __del__ releases
        # another object's flag and two GCaches race one urn_prefix.
        if _GLOBAL_GCACHE_STATE.gcache_owner_id != id(self):
            return
        _GLOBAL_GCACHE_STATE.gcache_instantiated = False
        _GLOBAL_GCACHE_STATE.gcache_owner_id = None

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
                         the Go client uses, so the entry can be shared across languages; it requires a
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
                         writes a watermark, and ``LocalCache`` does not read watermarks, so a Go
                         invalidation does not clear a Python pod's in-process copy until the local TTL expires.  For a
                         use case shared across languages, keep the local TTL short or set the local ramp to 0.
        :return:
        """

        # Accept the bare string an untyped caller passes, but resolve it here so an
        # unrecognized value raises instead of silently falling back to pickle -- the whole
        # point of declaring an envelope is that both languages agree on the framing.
        envelope = Envelope(envelope)

        # Fail at decoration: JSON with no serializer can never produce a valid entry.
        # Raised inside `decorator` so the default use case has resolved to module.function
        # by then -- here it is still None and the message would name no code.

        def decorator(func: Any) -> Any:
            nonlocal use_case
            nonlocal arg_adapters
            nonlocal ignore_args

            # Cache the function signature by defining it here.
            sig = inspect.signature(func)

            if use_case is None:
                use_case = f"{func.__module__}.{func.__name__}"

            if envelope == Envelope.JSON and serializer is None:
                # JsonEnvelopeRequiresSerializer, not a bare ValueError: GCacheKey raises that
                # for the identical condition, so a caller wrapping both in `except GCacheError`
                # caught one route and not the other.
                raise JsonEnvelopeRequiresSerializer(
                    key_type, id_arg if isinstance(id_arg, str) else id_arg[0], use_case
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
        :raises ValueError: if ``key_type`` or ``id`` is empty.
        """
        # HERE, not in RedisCache.invalidate. Down there the guard fires only when a Redis
        # layer exists, so a NoopCache deployment -- documented, and what local runs and many
        # consumer test suites use -- accepted the malformed call while production rejected
        # it. A caller met the bug in the environment where it costs most.
        validate_invalidation_args(key_type, id, future_buffer_ms)
        await self._redis_cache.invalidate(key_type, id, future_buffer_ms)

    def invalidate(self, key_type: str, id: str, future_buffer_ms: int = 0) -> None:
        """
        Invalidate all cache entries matching the given key type and ID (sync version).

        :param key_type: The type of cache key to invalidate.
        :param id: The ID of the entity to invalidate.
        :param future_buffer_ms: Buffer time in milliseconds to extend invalidation into the future.
        :raises ValueError: if ``key_type`` or ``id`` is empty, or ``future_buffer_ms`` is
            negative or exceeds the watermark lifetime -- via ``ainvalidate``.
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
        self._check_key_namespace(key)

        if key.use_case not in self._use_case_registry:
            return

        declared = self._use_case_envelopes.get(key.use_case)
        if declared is not None and declared != key.envelope:
            raise EnvelopeMismatchWithRegisteredUseCase(key.use_case, declared, key.envelope)

        # By (type, message type): type alone accepted two ProtoSerializers carrying
        # DIFFERENT messages, and ignore_unknown_fields=True makes that silent -- the wrong
        # payload yields an empty message. Never by identity: two JsonSerializer()s differ.
        if _serializer_identity(self._use_case_serializers.get(key.use_case)) != _serializer_identity(key.serializer):
            raise SerializerMismatchWithRegisteredUseCase(
                key.use_case, self._use_case_serializers.get(key.use_case), key.serializer
            )

    def _check_key_namespace(self, key: GCacheKey) -> None:
        """Reject a key that renders into the wrong namespace.

        Separate from the framing checks because this is the only one that changes the
        urn, so it is the only one a DELETE needs -- and the only one it must have: a key
        built before ``GCache()`` captured the default ``urn_prefix``, so it deletes a urn
        in another namespace and reports ``False``, which a caller reads as "no entry
        existed" while the real entry survives. (On a read or write the same mismatch also
        splits the value from its watermark, into different cluster hash slots, so tracked
        invalidation silently does nothing.)

        Checked at use rather than forbidden at construction: a module-level key constant
        is the natural thing to write and the only thing that reaches this state.
        """
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
        # Fails OPEN, unlike aput: a read must never break the caller's request, and the
        # decorator path already degrades this way. gcache_error_counter is what keeps it
        # visible -- silently uncached forever is how this reaches production.
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

        A prime is also **sampled**, like a read. ``_should_cache`` calls ``random()`` on
        every invocation and each layer samples independently, so a use case at ramp 50
        drops about half its primes and this call still returns normally. On a read a
        sampled skip costs one uncached call; on a prime it discards work the caller has
        already done, and the entry another process is waiting for never appears. Ramp a
        shared use case to 100 or 0, not through the middle.

        A prime landing inside an active invalidation window is lost **on the Redis layer**,
        silently: the entry is written with ``createdAtMs`` below the watermark, so remote
        reads find it stale until the window closes and a read rewrites it. That is the
        invalidation doing its job, but this call still returns normally. Go's ``Put``
        behaves the same way; the Go client is the outlier and returns ``false``.
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

        Validates the NAMESPACE only, not the framing. A delete needs nothing but the urn,
        and a key whose ``envelope`` or ``serializer`` differs from a decorator's renders
        the same urn, so rejecting it would break the documented way to delete a decorated
        entry -- ``test_delete_key`` does exactly that with a bare ``GCacheKey``.

        The namespace check does raise, because returning ``False`` there is a lie a caller
        cannot detect: the key deletes a urn in another namespace, reports "no entry
        existed", and leaves the real entry in place.

        :param key: The cache key to delete.
        :return: True if the key was deleted, False otherwise.
        """
        self._check_key_namespace(key)
        return await self._cache.delete(key)

    def delete(self, key: GCacheKey) -> bool:
        """
        Delete a specific cache entry (sync version).

        :param key: The cache key to delete.
        :return: True if the key was deleted, False otherwise.
        """
        return self._run_coroutine_in_thread(partial(self.adelete, key))
