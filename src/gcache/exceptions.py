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


class EnvelopeRequiresSerializer(GCacheError, ValueError):
    """A framing that carries an encoded payload was declared with no Serializer.

    JSON needs one to produce its string payload and PROTO needs one to produce its bytes.
    PICKLE is the only framing that works without: it serialises the object itself.

    Named for the envelope in general rather than JSON, because the guard originally covered
    only JSON and PROTO slipped through it -- a PROTO key with no serializer constructed
    fine and then failed EVERY write, with CacheController swallowing the error and the
    local layer masking it in-process, so Redis stayed empty for that use case for the life
    of the deployment. JsonEnvelopeRequiresSerializer remains as an alias.

    Also a ValueError, so it stays catchable the same way as the Envelope coercion two
    lines above it in __post_init__ -- a caller validating key construction should not
    need to know which of the two adjacent failures it hit.
    """

    def __init__(self, key_type: str, id: str, use_case: str, envelope: str = "JSON") -> None:
        want = (
            "bytes (e.g. ProtoSerializer(YourMessage))"
            if envelope == "PROTO"
            else "str or bytes (e.g. JsonSerializer())"
        )
        super().__init__(
            f"GCacheKey {key_type}:{id}#{use_case} uses Envelope.{envelope}, which requires a "
            f"serializer producing {want}"
        )


# The old name, kept so `except JsonEnvelopeRequiresSerializer` in a consumer keeps working.
# An alias rather than a subclass: the two must be the same class, or a caller catching the
# old name would miss a PROTO failure raised as the new one.
JsonEnvelopeRequiresSerializer = EnvelopeRequiresSerializer


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

    An empty prefix still renders syntactically valid keys, but in an unnamespaced key space
    that no namespaced deployment reads -- and there is no error at write time, so the cache
    simply never hits. The Go client refuses it at construction for the same reason
    (``Options.URNPrefix is required``).

    Rejecting rather than silently ignoring it, which was the previous behaviour: anyone
    passing "" today has been running with the default prefix and does not know it. An error
    says their configuration never did what they asked.

    Subclasses ValueError as well, so a caller already guarding construction with
    ``except ValueError`` keeps catching it.
    """

    def __init__(self) -> None:
        super().__init__(
            'urn_prefix="" is not supported: an empty prefix writes into an unnamespaced key '
            "space that no namespaced deployment reads, so the cache never hits. Pass a "
            "non-empty prefix, or omit urn_prefix to keep the default."
        )


class UrnPrefixContainsDelimiter(GCacheError, ValueError):
    """Raised when ``urn_prefix`` contains one of the key grammar's own delimiters.

    ``{}`` ``#`` and ``?`` all change what the key MEANS rather than just how it looks. A
    brace is the worst: it moves the Redis Cluster hash tag, so a value and its watermark
    land in different slots and the single MGET that reads both becomes illegal. ``#`` and
    ``?`` make the prefix parse as a use case or an argument list.

    The Go client refuses the same set in ``New``, so accepting them here produced a prefix
    Python would write and Go could not even construct a client for.

    Subclasses ValueError as well, matching the other construction-time failures.
    """

    def __init__(self, urn_prefix: str) -> None:
        super().__init__(
            f"urn_prefix {urn_prefix!r} must not contain any of {{}}#? -- those are the key "
            "grammar's own delimiters, and a brace moves the Redis Cluster hash tag so a "
            "value and its watermark stop sharing a slot."
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


class UnhashableKeyComponent(GCacheError, ValueError):
    """A value handed to ``hash_component`` has no UTF-8 encoding.

    Only a lone surrogate reaches this -- ``json.loads`` accepts ``"\\ud800"`` and ``str.encode``
    refuses it. Raised rather than hashed over a substitute: Go's ``encoding/json`` turns the
    same input into U+FFFD, so the two clients would hash DIFFERENT bytes and silently occupy
    different key spaces. The caller decides what to do with such a value; the one thing this
    must not do is return a digest the other client disagrees with.
    """


class UnserializableValue(GCacheError, ValueError):
    """A value Python can encode but the other client cannot read back identically.

    So far: a lone surrogate. json.dumps emits it as the ASCII escape \\ud800, so the stored
    envelope is valid ASCII and every layer downstream accepts it -- but Python decodes it to
    a str holding U+D800 while Go's encoding/json substitutes U+FFFD. Both clients report a
    hit and return different values, with nothing raised, logged or counted.

    Failing the write is the rule this envelope already follows for the same class of value:
    allow_nan=False refuses NaN and Infinity because Go's encoding/json rejects them, and
    hash_component refuses a lone surrogate in a key via UnhashableKeyComponent.
    """

    def __init__(self, reason: str) -> None:
        # DIAGNOSTIC ONLY -- never the value. This used to append the first 120 characters of
        # the serialized payload, which is cached application data: tokens, PII, whatever the
        # caller put in the cache. CacheController catches a failed Redis write and logs
        # str(e) at error level, so every rejected value was copied into the logs.
        super().__init__(
            f"gcache: value contains {reason}, which this client and the Go client decode to "
            "different values (Python keeps the surrogate, Go substitutes U+FFFD). Refusing "
            "the write rather than storing a cross-client divergence. The value is not "
            "included here: it is cached application data and this message reaches the logs."
        )
