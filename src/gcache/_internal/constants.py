# Cache sizes
# Default max entries per use case to prevent unbounded memory growth.
LOCAL_CACHE_MAX_SIZE = 10_000

# Thresholds
# Size above which DECODING runs in a thread rather than on the event loop. Named for
# decoding, not pickling: RedisCache.get routes on size alone, so this gates json.loads and
# base64 decoding as much as pickle.loads -- a multi-megabyte JSON envelope blocks the loop
# just as a large pickle does.
ASYNC_DECODE_THRESHOLD_BYTES = 50_000

# TTLs (seconds)
# Watermark TTL must be longer than any invalidatable cache's TTL to ensure
# invalidation works correctly. 4 hours is a heuristic that covers most use cases.
# If your cache TTLs exceed 4 hours, consider making this configurable.
WATERMARK_TTL_SECONDS = 3600 * 4  # 4 hours

# Thread pool
# Default thread pool size for running async operations from sync code.
# Balances concurrency for I/O-bound Redis operations without excessive resource usage.
EVENT_LOOP_THREAD_POOL_SIZE = 16


def validate_invalidation_args(key_type: str, id: str, future_buffer_ms: int) -> None:
    """Reject an invalidation that cannot do what the caller asked.

    Shared by GCache's public methods and RedisCache.invalidate deliberately. The public
    layer is where a NoopCache deployment -- local runs, many consumer test suites -- is
    reached at all, so a guard only in RedisCache lets the malformed call through in exactly
    the environment where it is cheapest to notice and fails only in production. Keeping one
    function rather than two copies is the point: the bounds below existed on the Go side
    alone for a while, and the divergence is what this fixes.
    """
    if not key_type or not id:
        raise ValueError("gcache: invalidate requires both key_type and id")
    # An INTEGER, checked before the comparisons below rather than left to them. The public
    # contract is integer milliseconds, and the two range checks cannot enforce it: every
    # comparison against NaN is False, so a NaN passes both and reaches SETEX, where Redis
    # raises on a Noop-backed deployment's silent success. A float like 0.5 slips through and
    # is coerced later; a bool is an int subclass in Python, so True arrives as 1 and reads as
    # a deliberate one-millisecond buffer nobody wrote.
    if isinstance(future_buffer_ms, bool) or not isinstance(future_buffer_ms, int):
        raise ValueError(
            f"gcache: future_buffer_ms must be an int of milliseconds, got "
            f"{type(future_buffer_ms).__name__} {future_buffer_ms!r}"
        )
    if future_buffer_ms < 0:
        # A watermark in the PAST suppresses only part of the key type -- anything written
        # after that instant stays fresh -- while the call still reports success.
        raise ValueError(
            f"gcache: future_buffer_ms {future_buffer_ms} is negative; it moves the watermark into the past"
        )
    if future_buffer_ms > WATERMARK_TTL_SECONDS * 1000:
        # The watermark would expire before the buffer it is meant to span, so entries
        # written inside the window outlive the thing suppressing them and resurrect.
        #
        # Go bounds this more tightly, at watermarkTTL MINUS the cache's TTL, because a Go
        # Cache has one TTL for every key. Python's TTL is per key and is not in scope here,
        # so this enforces the unconditional ceiling instead. The gap is covered from the
        # other side: a tracked write whose TTL exceeds the watermark already raises
        # TrackedTTLExceedsWatermark, so ttl <= WATERMARK_TTL_SECONDS always holds.
        raise ValueError(
            f"gcache: future_buffer_ms {future_buffer_ms} exceeds the "
            f"{WATERMARK_TTL_SECONDS}s watermark lifetime; an entry written inside the "
            f"buffer would outlive the watermark and resurrect"
        )
