import inspect
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from gcache._internal.metrics import GCacheMetrics
from gcache._internal.state import _GLOBAL_GCACHE_STATE
from gcache.config import CacheCallContext, CacheHitHook, CacheLayer, EvictAndFallback, GCacheKey, ReturnCached


@dataclass(frozen=True, slots=True)
class BypassCurrentLayer:
    """Internal signal to skip a cache layer without mutating its stored value."""


async def run_cache_hit_hook(
    *,
    key: GCacheKey,
    layer: CacheLayer,
    value: Any,
    call_args: Mapping[str, Any] | None,
    on_cache_hit: CacheHitHook | None,
) -> ReturnCached | EvictAndFallback | BypassCurrentLayer:
    if on_cache_hit is None:
        return ReturnCached()

    context = CacheCallContext(key=key, layer=layer, call_args=call_args or {})

    try:
        decision = on_cache_hit(context, value)
        if inspect.isawaitable(decision):
            decision = await decision
    except Exception:
        _GLOBAL_GCACHE_STATE.logger.error(
            "Error executing cache hit hook",
            extra={"use_case": key.use_case, "key_type": key.key_type, "layer": layer.name},
            exc_info=True,
        )
        GCacheMetrics.HIT_HOOK_ERROR_COUNTER.labels(key.use_case, key.key_type, layer.name).inc()
        return BypassCurrentLayer()

    if isinstance(decision, ReturnCached):
        GCacheMetrics.HIT_HOOK_ACTION_COUNTER.labels(
            key.use_case,
            key.key_type,
            layer.name,
            "return",
            "none",
        ).inc()
        return decision

    if isinstance(decision, EvictAndFallback):
        GCacheMetrics.HIT_HOOK_ACTION_COUNTER.labels(
            key.use_case,
            key.key_type,
            layer.name,
            "evict",
            decision.reason or "none",
        ).inc()
        return decision

    _GLOBAL_GCACHE_STATE.logger.error(
        "Cache hit hook returned invalid decision type",
        extra={
            "use_case": key.use_case,
            "key_type": key.key_type,
            "layer": layer.name,
            "decision_type": type(decision).__name__,
        },
    )
    GCacheMetrics.HIT_HOOK_ERROR_COUNTER.labels(key.use_case, key.key_type, layer.name).inc()
    return BypassCurrentLayer()
