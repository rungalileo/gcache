# Cache sizes
# Default max entries per use case to prevent unbounded memory growth.
LOCAL_CACHE_MAX_SIZE = 10_000

# Thresholds
# Size above which DECODING runs in a thread rather than on the event loop. Named for
# decoding, not pickling: RedisCache.get routes on size alone, so this gates json.loads as
# much as pickle.loads -- a multi-megabyte JSON envelope blocks the loop just as a large
# pickle does.
ASYNC_DECODE_THRESHOLD_BYTES = 50_000

# The second offload axis: the divergence check costs one iteration per BACKSLASH once a
# `\ud` escape is present, so a payload can be small and still expensive. ~0.07-0.21us each,
# making 1,000 roughly the inline budget the byte threshold implies.
ASYNC_CHECK_THRESHOLD_BACKSLASHES = 1_000

# TTLs (seconds)
# The watermark must outlive every entry it can suppress. It is 5 hours, which is the
# tracked-TTL cap (4h) plus the invalidation buffer ceiling (1h) -- see the block below for
# why the sum is split into two locally-enforced caps rather than checked in one place.
WATERMARK_TTL_SECONDS = 3600 * 5  # 5 hours

# The resurrection invariant is `future_buffer + entry_ttl <= WATERMARK_TTL_SECONDS`: a
# watermark must outlive every entry it suppresses. The two numbers are chosen by different
# parties -- the buffer by whoever invalidates, the TTL by each writer -- so instead of one
# check that cannot see both, the sum is split into two caps that hold by construction
# (4h + 1h <= 5h), each enforced against a value its own caller owns. Mirrored in Go
# (cache.go) and pinned by the shared conformance corpus.
MAX_TRACKED_TTL_SECONDS = 3600 * 4  # 4 hours
MAX_FUTURE_BUFFER_SECONDS = WATERMARK_TTL_SECONDS - MAX_TRACKED_TTL_SECONDS  # 1 hour

# Thread pool
# Default thread pool size for running async operations from sync code.
# Balances concurrency for I/O-bound Redis operations without excessive resource usage.
EVENT_LOOP_THREAD_POOL_SIZE = 16


def validate_invalidation_args(key_type: str, id: str, future_buffer_ms: int) -> None:
    """Reject an invalidation that cannot do what the caller asked.

    Shared by GCache's public methods and RedisCache.invalidate: a guard only in the latter
    would miss a NoopCache deployment, which is where the malformed call is cheapest to
    notice.
    """
    if not key_type or not id:
        raise ValueError("gcache: invalidate requires both key_type and id")
    # Checked before the range comparisons, which cannot enforce it: every comparison
    # against NaN is False, so NaN passes both and reaches SETEX. bool is an int subclass,
    # so True would arrive as a deliberate one-millisecond buffer.
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
    if future_buffer_ms > MAX_FUTURE_BUFFER_SECONDS * 1000:
        # Against MAX_FUTURE_BUFFER_SECONDS, not the watermark lifetime: the invariant is
        # buffer + ttl <= WATERMARK, so a 4h buffer plus a legal 1h TTL outlives the
        # tombstone by an hour.
        raise ValueError(
            f"gcache: future_buffer_ms {future_buffer_ms} exceeds the "
            f"{MAX_FUTURE_BUFFER_SECONDS * 1000}ms ceiling; with the "
            f"{MAX_TRACKED_TTL_SECONDS}s tracked-TTL cap that keeps buffer+TTL inside the "
            f"{WATERMARK_TTL_SECONDS}s watermark lifetime, so an entry written inside the "
            f"buffer cannot outlive the watermark and resurrect"
        )
