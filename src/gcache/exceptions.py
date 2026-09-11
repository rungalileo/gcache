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


class EnvelopeMismatchWithRegisteredUseCase(GCacheError):
    """A direct key contradicts the envelope a @cached decorator declared for the same use case."""

    def __init__(self, use_case: str, declared: object, given: object) -> None:
        super().__init__(
            f"use case {use_case!r} is registered with {declared}, but this key declares {given}. "
            "They render the same Redis key, so the two framings would overwrite each other."
        )
