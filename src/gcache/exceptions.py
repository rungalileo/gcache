class GCacheError(Exception):
    pass


class ReentrantSyncFunctionDetected(GCacheError):
    def __init__(self) -> None:
        super().__init__(
            "Sync cached function calling another sync cached function detected.  This is not supported for sync functions.  Convert your use cases to be async."
        )


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


class RedisConfigConflict(GCacheError):
    def __init__(self) -> None:
        super().__init__("Cannot provide both redis_config and redis_client_factory. Only one is allowed.")


class UseCaseIsAlreadyRegistered(GCacheError):
    def __init__(self, use_case: str):
        super().__init__(f"Use case already registered: {use_case}")


class MissingKeyConfig(GCacheError):
    def __init__(self, use_case: str):
        super().__init__(f"Missing entire or partial (ttl/ramp) key config for use case: {use_case}")


class UseCaseNameIsReserved(GCacheError):
    def __init__(self) -> None:
        super().__init__("Use case name is reserved.")


class GCacheKeyPrefixMismatch(GCacheError):
    """A key was built under a different urn_prefix than the one now in force."""

    def __init__(self, use_case: str, key_prefix: str, live_prefix: str) -> None:
        super().__init__(
            f"use case {use_case!r}: key was built with urn_prefix {key_prefix!r} but "
            f"{live_prefix!r} is in force. Build GCacheKeys after GCache() -- a key built "
            "earlier renders a value key in one namespace while invalidation writes its "
            "watermark in another, so invalidation silently does nothing."
        )


class JsonEnvelopeRequiresSerializer(GCacheError, ValueError):
    """Envelope.JSON was declared with no Serializer to produce its string payload.

    Also a ValueError, so it stays catchable the same way as the Envelope coercion two
    lines above it in __post_init__ -- a caller validating key construction should not
    need to know which of the two adjacent failures it hit.
    """

    def __init__(self, key_type: str, id: str, use_case: str) -> None:
        super().__init__(
            f"GCacheKey {key_type}:{id}#{use_case} uses Envelope.JSON, which requires a "
            "serializer producing str or bytes (e.g. JsonSerializer())"
        )


class SerializerMismatchWithRegisteredUseCase(GCacheError):
    """A direct key's serializer contradicts the one a @cached decorator declared."""

    def __init__(self, use_case: str, declared: object, given: object) -> None:
        def name(v: object) -> str:
            return "no serializer" if v is None else type(v).__name__

        super().__init__(
            f"use case {use_case!r} is registered with {name(declared)}, but this key "
            f"declares {name(given)}. They render the same Redis key, so one side would "
            "hand the other a raw payload string where it expected its own type -- with "
            "nothing raised, logged or counted."
        )


class EnvelopeMismatchWithRegisteredUseCase(GCacheError):
    """A direct key contradicts the envelope a @cached decorator declared for the same use case."""

    def __init__(self, use_case: str, declared: object, given: object) -> None:
        super().__init__(
            f"use case {use_case!r} is registered with {declared}, but this key declares {given}. "
            "They render the same Redis key, so the two framings would overwrite each other."
        )


class EmptyUrnPrefixNotSupported(GCacheError, ValueError):
    """Raised when ``GCacheConfig(urn_prefix="")`` is given.

    An empty prefix cannot interoperate. Python's ``render_prefix`` omits the prefix
    entirely and yields ``kt:i``, while the TypeScript client joins unconditionally
    (``key.ts`` ``joinUrnComponents``) and yields ``:kt:i`` -- so value keys AND
    ``#watermark`` keys diverge, and neither client sees the other's entries or
    invalidations. There is no error at write time; the two just silently stop sharing a
    keyspace, which is the one failure this envelope work exists to prevent.

    Rejecting rather than supporting it, and rather than restoring the previous behaviour of
    silently ignoring it: anyone passing "" today has been running with the previous prefix
    ("urn" by default) and does not know it. An error says their configuration never did what
    they asked.

    Why THIS prefix and not every prefix, given that TypeScript interop is broken for all of
    them today (it percent-encodes components, so ``urn:galileo:test`` renders as
    ``urn%3Agalileo%3Atest``)? Because that one is an encoding defect with a fix: align the
    two and every non-empty prefix interoperates. An empty prefix still will not, because the
    divergence there is structural rather than an encoding choice -- Python omits the
    component, TypeScript joins it. It is the one case that survives the fix, which is what
    makes it worth a hard error instead of a README caveat.

    Subclasses ValueError as well, so a caller already guarding construction with
    ``except ValueError`` keeps catching it.
    """

    def __init__(self) -> None:
        super().__init__(
            'urn_prefix="" is not supported: an empty prefix renders as "kt:id" in Python but '
            '":kt:id" in the TypeScript client, so the two cannot share a keyspace. Pass a '
            "non-empty prefix, or omit urn_prefix to keep the default."
        )


class TrackedTTLExceedsWatermark(GCacheError, ValueError):
    """Raised when a tracked key's TTL would outlive the watermark that invalidates it.

    Invalidation works by writing a watermark that marks every older entry stale. The
    watermark lives ``WATERMARK_TTL_SECONDS`` (4 hours). If the entry outlives it, the
    watermark expires, the entry stops looking stale, and an invalidated value RESURRECTS --
    silently, and for the rest of its own TTL.

    Go rejects the equivalent at construction (``maxEntryTTL``) and additionally distrusts
    such an entry on read. Python had neither guard, which Go's own comment called out by
    name, so the two clients answered differently for one key: Go a miss, Python a hit on
    something an invalidation should have removed. Both halves now exist here too.

    Raised rather than capping the TTL: a cap silently gives the caller less than they
    configured and hides the misconfiguration from the read guard as well. gcache swallows
    write errors by design, so the caller still gets its value from the fallback.

    Only tracked keys are affected. A key without ``invalidation_tracking`` has no watermark
    to outlive and may use any TTL.
    """

    def __init__(self, use_case: str, ttl_sec: int, watermark_ttl_sec: int) -> None:
        super().__init__(
            f"use case {use_case!r} tracks invalidation but declares ttl_sec={ttl_sec}, which "
            f"outlives the {watermark_ttl_sec}s watermark. The entry would resurrect after an "
            f"invalidation. Shorten the TTL, or turn off invalidation_tracking for this key."
        )
