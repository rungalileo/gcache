from collections.abc import Generator
from typing import Any

import pytest
import redislite
from prometheus_client import REGISTRY

from gcache import GCache, GCacheConfig, GCacheKeyConfig, RedisConfig
from gcache._internal.state import _GLOBAL_GCACHE_STATE

from . import find_free_port

REDIS_PORT = find_free_port()


class FakeCacheConfigProvider:
    def __init__(self) -> None:
        self.configs: dict = {}

    async def __call__(self, *args: Any, **kwargs: Any) -> None:
        key = args[0]
        # Return fully ramped cache by default
        return self.configs.get(
            key.use_case,
            GCacheKeyConfig.enabled(60),
        )


@pytest.fixture(scope="session")
def redis_server() -> Generator[redislite.Redis, None, None]:
    # Create a redislite instance listening on TCP port 6397. Default is 6379, so we avoid that to prevent conflicts.
    redis_instance = redislite.Redis(serverconfig=dict(port=REDIS_PORT))
    yield redis_instance
    # Shut down the redislite server when tests finish.
    redis_instance.shutdown()


@pytest.fixture
def cache_config_provider() -> FakeCacheConfigProvider:
    return FakeCacheConfigProvider()


@pytest.fixture
def gcache(
    redis_server: redislite.Redis, cache_config_provider: FakeCacheConfigProvider
) -> Generator[GCache, None, None]:
    redis_server.flushall()
    gcache = GCache(
        GCacheConfig(
            cache_config_provider=cache_config_provider,
            urn_prefix="urn:galileo:test",
            redis_config=RedisConfig(port=REDIS_PORT),
        )
    )
    yield gcache
    # Manually call destructor so we make sure to remove
    # singleton checks as well as stop event loop thread
    gcache.__del__()


@pytest.fixture()
def reset_prometheus_registry() -> Generator:
    """
    Clears the prometheus registry before each test.

    This is necessary because the registry is a global singleton, and we don't want to have metrics from previous tests
    affecting the results of the current test.
    """
    collectors = tuple(REGISTRY._collector_to_names.keys())
    for collector in collectors:
        try:
            collector._metrics.clear()  # type: ignore[attr-defined]
            collector._metric_init()  # type: ignore[attr-defined]
        except AttributeError:
            # For built-in collectors
            pass
    yield


@pytest.fixture()
def reset_global_state() -> Generator:
    """
    Saves and restores global gcache state around a test.

    Use this fixture when testing code that modifies _GLOBAL_GCACHE_STATE
    (e.g., custom logger, urn_prefix) to prevent state leakage between tests.
    """
    original_logger = _GLOBAL_GCACHE_STATE.logger
    original_urn_prefix = _GLOBAL_GCACHE_STATE.urn_prefix
    yield
    _GLOBAL_GCACHE_STATE.logger = original_logger
    _GLOBAL_GCACHE_STATE.urn_prefix = original_urn_prefix
