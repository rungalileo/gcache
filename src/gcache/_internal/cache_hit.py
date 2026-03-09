import inspect
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from gcache._internal.metrics import GCacheMetrics
from gcache._internal.state import _GLOBAL_GCACHE_STATE
from gcache.config import CacheCallContext, CacheHitHook, CacheLayer, EvictAndFallback, GCacheKey, ReturnCached


@dataclass(frozen=True, slots=True)
class BypassCurrentLayer:
    """
    Internal signal to ignore this layer for the current request only.

    This is used when the hook machinery is unreliable rather than the cached
    value itself being known-bad. Two cases currently map here:
    - the hook raised an exception
    - the hook returned an unsupported decision type

    In those situations we want fail-open behavior:
    - do not fail the caller request
    - do not evict the cached value, because the problem may be in the hook
    - continue through the normal fallback chain as if this layer had no usable hit
    """


async def run_cache_hit_hook(
    *,
    key: GCacheKey,
    layer: CacheLayer,
    value: Any,
    call_args: Mapping[str, Any] | None,
    on_cache_hit: CacheHitHook | None,
) -> ReturnCached | EvictAndFallback | BypassCurrentLayer:
    """
    Execute the optional cache-hit hook and normalize the result.

    Returning `BypassCurrentLayer` is reserved for hook execution/contract
    failures. It lets cache layers skip a hit without deleting it, which keeps
    hook bugs from turning into request failures or unnecessary evictions.
    """
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
