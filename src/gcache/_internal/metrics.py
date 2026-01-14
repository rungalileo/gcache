from prometheus_client import Counter, Histogram


class GCacheMetrics:
    """Centralized Prometheus metrics for GCache."""

    _initialized: bool = False

    # Counters
    DISABLED_COUNTER: Counter
    MISS_COUNTER: Counter
    REQUEST_COUNTER: Counter
    ERROR_COUNTER: Counter
    INVALIDATION_COUNTER: Counter

    # Histograms
    GET_TIMER: Histogram
    FALLBACK_TIMER: Histogram
    SERIALIZATION_TIMER: Histogram
    SIZE_HISTOGRAM: Histogram

    @classmethod
    def initialize(cls, prefix: str = "") -> None:
        """Initialize all metrics with the given prefix. Only initializes once."""
        if cls._initialized:
            return

        cls.DISABLED_COUNTER = Counter(
            name=prefix + "gcache_disabled_counter",
            labelnames=["use_case", "key_type", "layer", "reason"],
            documentation="Cache disabled counter",
        )

        cls.MISS_COUNTER = Counter(
            name=prefix + "gcache_miss_counter",
            labelnames=["use_case", "key_type", "layer"],
            documentation="Cache miss counter",
        )

        cls.REQUEST_COUNTER = Counter(
            name=prefix + "gcache_request_counter",
            labelnames=["use_case", "key_type", "layer"],
            documentation="Cache request counter",
        )

        cls.ERROR_COUNTER = Counter(
            name=prefix + "gcache_error_counter",
            labelnames=["use_case", "key_type", "layer", "error", "in_fallback"],
            documentation="Cache error counter",
        )

        cls.INVALIDATION_COUNTER = Counter(
            name=prefix + "gcache_invalidation_counter",
            labelnames=["key_type", "layer"],
            documentation="Cache invalidation counter",
        )

        cls.GET_TIMER = Histogram(
            name=prefix + "gcache_get_timer",
            labelnames=["use_case", "key_type", "layer"],
            documentation="Cache get timer",
            buckets=[0.001] + list(Histogram.DEFAULT_BUCKETS),
        )

        cls.FALLBACK_TIMER = Histogram(
            name=prefix + "gcache_fallback_timer",
            labelnames=["use_case", "key_type", "layer"],
            documentation="Fallback timer",
            buckets=[0.001] + list(Histogram.DEFAULT_BUCKETS),
        )

        cls.SERIALIZATION_TIMER = Histogram(
            name=prefix + "gcache_serialization_timer",
            labelnames=["use_case", "key_type", "layer", "operation"],
            documentation="Cache serialization timer",
            buckets=[0.001] + list(Histogram.DEFAULT_BUCKETS),
        )

        cls.SIZE_HISTOGRAM = Histogram(
            name=prefix + "gcache_size_histogram",
            labelnames=["use_case", "key_type", "layer"],
            documentation="Cache size histogram",
            buckets=[100, 1000, 10_000, 100_000, 1_000_000, 10_000_000],
        )

        cls._initialized = True
