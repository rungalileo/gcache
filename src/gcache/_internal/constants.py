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
