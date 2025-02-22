from collections.abc import Generator
from typing import Any

import pytest
import redislite

from cachegalileo.gcache import GCache, GCacheConfig, GCacheKeyConfig, RedisConfig

REDIS_PORT = 6397


class FakeCacheConfigProvider:
    def __init__(self) -> None:
        self.configs: dict = {}

    async def __call__(self, *args: Any, **kwargs: Any) -> None:
        key = args[0]
        # Return fully ramped cache by default
        return self.configs.get(
            key.use_case,
            GCacheKeyConfig.enabled(60, key.use_case),
        )


@pytest.fixture(scope="session")
def redis_server() -> Generator[redislite.Redis, None, None]:
    # Create a redislite instance listening on TCP port 6397. Default is 6379, so we avoid that to prevent conflicts.
    redis_instance = redislite.Redis(serverconfig=dict(port=REDIS_PORT))
    yield redis_instance
    # Shut down the redislite server when tests finish.
    redis_instance.shutdown()


@pytest.fixture
def mock_cache_config_provider() -> FakeCacheConfigProvider:
    return FakeCacheConfigProvider()


@pytest.fixture
def a_gcache(
    redis_server: redislite.Redis, mock_cache_config_provider: FakeCacheConfigProvider
) -> Generator[GCache, None, None]:
    redis_server.flushall()
    gcache = GCache(
        GCacheConfig(
            cache_config_provider=mock_cache_config_provider,
            urn_prefix="urn:galileo:test",
            redis_config=RedisConfig(port=REDIS_PORT),
        )
    )
    yield gcache
    # Manually call destructor so we make sure to remove
    # singleton checks as well as stop event loop thread
    gcache.__del__()
