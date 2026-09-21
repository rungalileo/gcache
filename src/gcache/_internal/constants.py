# Cache sizes
# Default max entries per use case to prevent unbounded memory growth.
LOCAL_CACHE_MAX_SIZE = 10_000

# Thresholds
# Size above which DECODING runs in a thread rather than on the event loop. Named for
# decoding, not pickling: RedisCache.get routes on size alone, so this gates json.loads as
# much as pickle.loads -- a multi-megabyte JSON envelope blocks the loop just as a large
# pickle does.
ASYNC_DECODE_THRESHOLD_BYTES = 50_000

# The SECOND axis, because the cross-client divergence check does not scale with size.
#
# Its expensive half runs only when the payload holds a `\ud` escape at all -- without one,
# lone_surrogate_reason exits at a C-level substring scan. Past that gate it walks
# body.find("\\"), so the cost is one Python-level iteration per BACKSLASH, not per escape
# and not per byte. Measured 0.07us for a plain escape and 0.21us for a `\uXXXX` one, which
# parses four hex digits and may look ahead for a pair.
#
# Counted in backslashes for that reason. An earlier version counted `\u` and was wrong in
# both directions: 20 KiB of Japanese carries 3,400 `\u` escapes and no surrogates, so the
# check exits in 0.049ms and the gate offloaded it anyway -- an executor round trip costs
# ~0.064ms, more than the work it avoids, on every read of any CJK, Cyrillic, Greek, Hebrew,
# Arabic or accented-Latin payload under the byte threshold. Meanwhile one surrogate pair
# beside 6,000 `\n` escapes measured 0.436ms and stayed inline, because it holds two `\u`.
#
# 1,000 backslashes is 0.07-0.21ms, matching the implied inline budget of the byte threshold
# rather than picked for its own sake.
ASYNC_CHECK_THRESHOLD_BACKSLASHES = 1_000

# TTLs (seconds)
# The watermark must outlive every entry it can suppress. It is 5 hours, which is the
# tracked-TTL cap (4h) plus the invalidation buffer ceiling (1h) -- see the block below for
# why the sum is split into two locally-enforced caps rather than checked in one place.
WATERMARK_TTL_SECONDS = 3600 * 5  # 5 hours

# The resurrection invariant is `future_buffer + entry_ttl <= WATERMARK_TTL_SECONDS`: a
# watermark must outlive every entry it suppresses, or the entry becomes readable again once
# the tombstone expires. Those two numbers are chosen by DIFFERENT parties -- the buffer by
# whoever invalidates, the TTL by each writer -- across every use case and both languages, so
# no single check can see both. An invalidate-time check must guess about writers it cannot
# see; a write-time check must guess about invalidations that have not happened yet.
#
# Rather than guess, the sum is split into two caps that hold BY CONSTRUCTION:
#
#     MAX_TRACKED_TTL_SECONDS + MAX_FUTURE_BUFFER_SECONDS <= WATERMARK_TTL_SECONDS
#                        4h   +                        1h  <=                    5h
#
# The watermark lifetime was RAISED from 4h to 5h rather than lowering the entry cap to 3h.
# The entry TTL is what consumers configure per use case, so capping it lower would break
# existing callers; the buffer is a settling window for replication lag, measured in seconds
# in practice and defaulting to zero, so a 1h ceiling costs nobody anything. The price is one
# extra hour of tombstone lifetime per invalidated key.
#
# Each is enforced locally against a value its own caller owns -- the write path against the
# TTL, invalidate against the buffer -- and neither needs the other party's number.
#
# This replaces two checks that were each wrong in a different direction: Python bounded the
# buffer only by the full watermark lifetime (so buffer=4h with a legal 1h TTL let an entry
# outlive its tombstone by an hour), and Go bounded it by watermarkTTL minus the CALLING
# cache's TTL, which protected only that cache's own entries. Mirrored exactly in Go
# (cache.go) and pinned by the shared conformance corpus.
MAX_TRACKED_TTL_SECONDS = 3600 * 4  # 4 hours
MAX_FUTURE_BUFFER_SECONDS = WATERMARK_TTL_SECONDS - MAX_TRACKED_TTL_SECONDS  # 1 hour

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
    if future_buffer_ms > MAX_FUTURE_BUFFER_SECONDS * 1000:
        # Against MAX_FUTURE_BUFFER_SECONDS, not the full watermark lifetime. The earlier
        # ceiling accepted a 4h buffer and justified it with "a tracked TTL can never exceed
        # the watermark, so the gap is closed" -- which is the wrong inequality. The gap needs
        # buffer + ttl <= WATERMARK, not ttl <= WATERMARK: invalidate with a 4h buffer, then
        # write a tracked entry with a perfectly legal 1h TTL just before the buffer elapses,
        # and the watermark dies at T0+4h while the entry lives to T0+5h and reads fresh.
        raise ValueError(
            f"gcache: future_buffer_ms {future_buffer_ms} exceeds the "
            f"{MAX_FUTURE_BUFFER_SECONDS * 1000}ms ceiling; with the "
            f"{MAX_TRACKED_TTL_SECONDS}s tracked-TTL cap that keeps buffer+TTL inside the "
            f"{WATERMARK_TTL_SECONDS}s watermark lifetime, so an entry written inside the "
            f"buffer cannot outlive the watermark and resurrect"
        )
