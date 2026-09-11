import asyncio
import math
import pickle
import threading
import time
from collections.abc import Callable
from concurrent.futures.thread import ThreadPoolExecutor
from dataclasses import dataclass
from functools import partial
from typing import Any

from redis.asyncio import Redis, RedisCluster

from gcache._internal.cache_interface import CacheInterface, Fallback
from gcache._internal.constants import ASYNC_DECODE_THRESHOLD_BYTES, WATERMARK_TTL_SECONDS
from gcache._internal.envelope import _INT64_MAX, _INT64_MIN, DecodedValue, EnvelopeDecodeError, decode, encode_json
from gcache._internal.metrics import GCacheMetrics
from gcache._internal.state import _GLOBAL_GCACHE_STATE
from gcache.config import CacheConfigProvider, CacheLayer, Envelope, GCacheKey, RedisConfig, render_prefix
from gcache.exceptions import MissingKeyConfig


@dataclass(frozen=True, slots=True)
class RedisValue:
    """
    Wrapper around cached payload that includes creation timestamp.

    The timestamp enables cache invalidation: when a watermark is set for a key,
    any cached value with created_at_ms <= watermark is considered stale.
    """

    created_at_ms: int  # Unix timestamp in milliseconds when this value was cached
    payload: Any  # The actual cached data (may be serialized if Serializer is used)


def create_default_redis_client_factory(
    config: RedisConfig,
) -> Callable[[], Redis | RedisCluster]:
    """
    Create a default Redis client factory function from a RedisConfig.

    This factory creates a new Redis client each time it's called. Thread-local
    caching is handled by RedisCache, so the factory doesn't need to manage it.

    :param config: RedisConfig containing URL, cluster flag, and redis-py options
    :return: Factory function that creates a Redis client
    """

    def factory() -> Redis | RedisCluster:
        options: dict[str, int | bool | str] = config.redis_py_options
        if config.cluster:
            return RedisCluster.from_url(config.url, **options)
        else:
            return Redis.from_url(config.url, **options)  # type: ignore[arg-type]

    return factory


_WATERMARK_SUPPRESS_ALL = _INT64_MAX
"""Stand-in for a watermark that exists but cannot be read: suppresses every entry.

The MAXIMUM, deliberately. Staleness is ``watermark_ms >= created_at_ms``, so the maximum
marks every entry stale and the minimum marks none -- I first wrote the minimum here and it
did the exact opposite of this docstring, serving the entry it was meant to suppress.

Not None either. None means "no invalidation has happened", which also SERVES an entry
someone tried to invalidate. Both wrong answers are the same wrong answer.

It also stops write-back: _exec_fallback only re-puts when ``watermark_ms < now``, which
the maximum never is. So an unreadable watermark yields a miss AND leaves the stored value
alone until the watermark key expires on its own TTL, rather than overwriting a value whose
suppression state we cannot read.
"""


def _parse_watermark(raw: bytes | str | None, key: GCacheKey) -> int | None:
    """Convert a stored watermark to an int, failing CLOSED.

    Three things used to go wrong here, all of them raising out of RedisCache.get, which is
    the one thing this class promises cannot happen -- a cache must not be able to fail a
    request:

    * a non-numeric value (a foreign writer, a corrupt key) raised ValueError from float();
    * ``nan`` reached ``int(nan)`` and raised ValueError. Worse if it had not: every
      comparison against NaN is False, so the entry was neither stale nor written back --
      served forever and never repopulated;
    * ``inf`` (directly, or from a literal past ~1.8e308) reached ``int(inf)`` and raised
      OverflowError.

    The shared key space is what makes those reachable: before this envelope work only
    Python wrote these keys. Go's parseWatermark has handled all three deliberately.

    Unreadable fails closed -- see _WATERMARK_SUPPRESS_ALL. Out-of-range clamps, matching
    Go's clampToInt64: a watermark is a suppression instruction rather than data about the
    entry, so saturating gives the same answer the exact value would.
    """
    if raw is None:
        return None
    try:
        as_float = float(raw)
    except (TypeError, ValueError):
        _GLOBAL_GCACHE_STATE.logger.warning("Unreadable watermark for %s; suppressing the entry", key.urn)
        return _WATERMARK_SUPPRESS_ALL
    # EVERY non-finite value, not just NaN. Guarding on isnan alone treated the three
    # non-finite inputs three ways: nan and inf suppressed, but -inf clamped to the int64
    # minimum and SERVED the entry. None of them is a timestamp, so all three are
    # unreadable and all three must suppress.
    #
    # That also closes the one input where the two clients disagreed: Go rejects -inf
    # (a miss), and Python was serving it. Finite out-of-range values still clamp in both
    # -- -1e300 means "an extremely old watermark", which is a real instruction, not garbage.
    if not math.isfinite(as_float):
        _GLOBAL_GCACHE_STATE.logger.warning("Non-finite watermark %r for %s; suppressing the entry", as_float, key.urn)
        return _WATERMARK_SUPPRESS_ALL
    if as_float >= _INT64_MAX:
        return _INT64_MAX
    if as_float <= _INT64_MIN:
        return _INT64_MIN
    return int(as_float)


class RedisCache(CacheInterface):
    _executor = ThreadPoolExecutor()

    def __init__(
        self,
        cache_config_provider: CacheConfigProvider,
        client_factory: Callable[[], Redis | RedisCluster],
    ):
        """
        Initialize RedisCache.

        :param cache_config_provider: Provider for cache configuration
        :param client_factory: Factory function to create Redis clients.
            The factory should return a new Redis client when called. Thread-local
            caching is handled internally by RedisCache - the factory will only be
            called once per thread, and the resulting client will be reused for
            subsequent operations on that thread.
        """
        super().__init__(cache_config_provider)
        self._client_factory = client_factory
        # Thread-local storage is required because async redis-py clients maintain
        # internal state (connection pool, pending requests) bound to a specific event loop.
        # Since gcache runs sync cached functions in EventLoopThread workers (each with its
        # own event loop), sharing a client across threads causes "attached to a different
        # event loop" RuntimeError. One client per thread ensures correct event loop binding.
        self._thread_local = threading.local()

    @property
    def client(self) -> Redis | RedisCluster:
        """
        Get a Redis client for the current thread.

        The client is created once per thread using the factory and cached
        in thread-local storage for reuse.
        """
        if not hasattr(self._thread_local, "client"):
            self._thread_local.client = self._client_factory()
        return self._thread_local.client

    async def _exec_fallback(
        self,
        key: GCacheKey,
        watermark_ms: int | None,
        fallback: Fallback,
    ) -> Any:
        """
        Execute the fallback function, optionally cache the result, and return it.

        The result is stored in cache unless there's an active invalidation window
        (watermark_ms is in the future). This prevents caching potentially stale data
        that was fetched during an invalidation period.

        :param key: Cache key for storing the result.
        :param watermark_ms: Invalidation watermark timestamp in milliseconds, or None.
            If set and greater than current time, the result is not cached.
        :param fallback: Async function that fetches the actual value.
        :return: The value returned by the fallback function.
        """
        val = await fallback()
        if watermark_ms is None or watermark_ms < time.time() * 1e3:
            await self.put(key, val)
        return val

    async def invalidate(self, key_type: str, id: str, future_buffer_ms: int) -> None:
        GCacheMetrics.INVALIDATION_COUNTER.labels(key_type, self.layer().name).inc()

        # render_prefix, not a hand-rolled concatenation. The two disagreed when
        # urn_prefix was empty -- this produced "{:kt:id}" where a GCacheKey produces
        # "{kt:id}" -- which is a different cluster hash slot, so the watermark stopped
        # sharing a slot with the value it was meant to suppress and the invalidation
        # silently never matched. Go's WatermarkKey guards that case, so Python was also
        # the odd one out across languages.
        key = render_prefix(key_type, id, tracked=True) + "#watermark"
        exp_ms = int(time.time() * 1000 + future_buffer_ms)
        await self.client.setex(key, WATERMARK_TTL_SECONDS, exp_ms)

    @staticmethod
    async def _async_decode(data: bytes, *, allow_pickle: bool) -> DecodedValue:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(RedisCache._executor, partial(decode, data, allow_pickle=allow_pickle))

    async def get(self, key: GCacheKey, fallback: Fallback) -> Any:
        _GLOBAL_GCACHE_STATE.logger.debug("Calling Redis Cache")

        watermark_ms = None
        if key.invalidation_tracking:
            vals = await self.client.mget(key.urn, key.prefix + "#watermark")
            raw = vals[0]
            watermark_ms = _parse_watermark(vals[1], key)
        else:
            raw = await self.client.get(key.urn)
        if raw is not None:
            start_sec = time.monotonic()

            # Sniff the envelope rather than trusting key.envelope: a key may have been
            # written under a different envelope (mid-migration, or by another language's
            # client), and a reader must still understand it. A JSON key still refuses a
            # pickle blob -- see decode's allow_pickle.
            #
            # Route to the executor on size alone: a multi-megabyte JSON envelope blocks the
            # loop in json.loads/b64decode just as a large pickle does.
            allow_pickle = key.envelope != Envelope.JSON
            try:
                deserialized_value: DecodedValue = (
                    decode(raw, allow_pickle=allow_pickle)
                    if len(raw) < ASYNC_DECODE_THRESHOLD_BYTES
                    else await RedisCache._async_decode(raw, allow_pickle=allow_pickle)
                )
            except EnvelopeDecodeError:
                # Treat an undecodable value as a miss rather than raising: a cache must not
                # be able to fail a request. The fallback repopulates it in our own envelope.
                _GLOBAL_GCACHE_STATE.logger.warning("Undecodable cache value for %s; treating as miss", key.urn)
                self._record_degraded_read(key, "undecodable")
                return await self._exec_fallback(key, watermark_ms, fallback)

            # A JSON entry carries a SERIALIZED payload, so only a Serializer turns it back
            # into a value. Without one, the raw string would be handed to a caller
            # expecting its own type -- worse than a miss, because nothing raises and
            # nothing logs. A rolling deploy reaches this directly: old pods still declare
            # Envelope.PICKLE with no serializer while new pods have started writing JSON.
            if deserialized_value.is_json and key.serializer is None:
                _GLOBAL_GCACHE_STATE.logger.warning(
                    "JSON cache value for %s but the key has no Serializer; treating as miss", key.urn
                )
                self._record_degraded_read(key, "json_without_serializer")
                return await self._exec_fallback(key, watermark_ms, fallback)

            # Honour the envelope's own expiry, not just Redis's TTL. The two can disagree --
            # a writer that calls PERSIST or sets a longer TTL leaves an entry Redis still
            # serves -- and the TypeScript reader treats a past expiresAtMs as a miss, so
            # ignoring it here makes the two languages answer differently for one key.
            #
            # Deliberately no skew tolerance. This does make a read depend on the WRITER's
            # wall clock, which is new -- a writer running behind loses the tail of every
            # entry's lifetime, and each affected read pays a fallback plus a rewrite. A
            # tolerance would serve values the TypeScript reader calls expired, which is the
            # divergence this check exists to remove.
            #
            # It is NOT self-correcting: a writer lagging by more than the use case's TTL
            # stamps an already-past expiry on every entry, so the key's hit rate sits at
            # zero indefinitely. That is an operational requirement, not a tolerance --
            # clocks must agree within the shortest TTL of any JSON use case. The
            # envelope_expired degraded-read reason is the alarm for it.
            if deserialized_value.expires_at_ms is not None and deserialized_value.expires_at_ms <= time.time() * 1000:
                _GLOBAL_GCACHE_STATE.logger.warning(
                    "Cache value for %s is past its envelope expiry; treating as miss", key.urn
                )
                self._record_degraded_read(key, "envelope_expired")
                return await self._exec_fallback(key, watermark_ms, fallback)

            # Load payload using custom serializer if present.
            payload = deserialized_value.payload
            if key.serializer is not None:
                try:
                    payload = await key.serializer.load(payload)
                except Exception as e:
                    # Same reasoning as the decode guard above, which this sat outside of: a
                    # payload the serializer cannot parse used to raise past it, so the
                    # caller logged an error, re-ran the fallback and never wrote back --
                    # leaving the entry poisoned for its whole TTL. Any non-Python writer can
                    # produce one.
                    _GLOBAL_GCACHE_STATE.logger.warning(
                        "Unloadable cache payload for %s (%s); treating as miss", key.urn, e
                    )
                    self._record_degraded_read(key, "unloadable_payload")
                    return await self._exec_fallback(key, watermark_ms, fallback)

            (
                GCacheMetrics.SERIALIZATION_TIMER.labels(key.use_case, key.key_type, self.layer().name, "load").observe(
                    time.monotonic() - start_sec
                )
            )

            # Check if cache val is expired. watermark_ms is already an int or None --
            # _parse_watermark did the conversion, so there is no int() here to raise.
            if watermark_ms is not None:
                if watermark_ms >= deserialized_value.created_at_ms:
                    return await self._exec_fallback(key, watermark_ms, fallback)
            return payload
        else:
            return await self._exec_fallback(key, watermark_ms, fallback)

    async def put(self, key: GCacheKey, value: Any) -> None:
        config = await self._resolve_config(key)
        if config is None:
            raise MissingKeyConfig(key.use_case)

        current_time_ms = int(time.time() * 1000)

        ttl = config.ttl_sec.get(self.layer(), None)
        if ttl is None:
            raise MissingKeyConfig(key.use_case)

        start_time = time.monotonic()
        serialized_value = value if key.serializer is None else await key.serializer.dump(value)

        # `==`, not `is`: Envelope subclasses str, so an untyped caller passing the plain
        # string "json" must opt in rather than silently fall back to pickle.
        if key.envelope == Envelope.JSON:
            # Require the serializer, not merely a str/bytes result. A cached function that
            # already returns str passes a type check with no serializer and stores
            # non-JSON text in a JSON envelope, which every other language's reader then
            # fails to parse -- the exact breakage this envelope exists to prevent.
            if key.serializer is None or not isinstance(serialized_value, str | bytes):
                raise TypeError(
                    f"Envelope.JSON requires a Serializer producing str or bytes for use case "
                    f"{key.use_case!r}, got {type(serialized_value).__name__}. Pass serializer=JsonSerializer()."
                )
            encoded = encode_json(current_time_ms, ttl, serialized_value)
        else:
            encoded = pickle.dumps(
                RedisValue(created_at_ms=current_time_ms, payload=serialized_value), protocol=pickle.HIGHEST_PROTOCOL
            )

        GCacheMetrics.SERIALIZATION_TIMER.labels(key.use_case, key.key_type, self.layer().name, "dump").observe(
            time.monotonic() - start_time
        )

        GCacheMetrics.SIZE_HISTOGRAM.labels(key.use_case, key.key_type, self.layer().name).observe(len(encoded))

        await self.client.setex(key.urn, ttl, encoded)

    async def delete(self, key: GCacheKey) -> bool:
        return (await self.client.delete(key.urn)) > 0

    def _record_degraded_read(self, key: GCacheKey, reason: str) -> None:
        """Count a read that found an entry it could not use.

        All of these fall through to the fallback, which raises MISS_COUNTER, so without a
        separate signal keyspace corruption and envelope thrash are indistinguishable from
        ordinary misses on a dashboard -- and both are conditions an operator needs to see.
        """
        GCacheMetrics.DEGRADED_READ_COUNTER.labels(key.use_case, key.key_type, self.layer().name, reason).inc()

    def layer(self) -> CacheLayer:
        return CacheLayer.REMOTE

    async def flushall(self) -> None:
        return await self.client.flushall()
