import pytest
import redislite
from redis import Redis

from cachegalileo.gcache import GCache, GCacheConfig, GCacheKeyConfig, RedisConfig


class FakeCacheConfigProvider:
    def __init__(self):
        self.configs = {}

    async def __call__(self, *args, **kwargs):
        key = args[0]
        # Return fully ramped cache by default
        return self.configs.get(
            key.use_case,
            GCacheKeyConfig.enabled(60, key.use_case),
        )


@pytest.fixture(scope="session")
def redis_server():
    # Create a redislite instance listening on TCP port 6397.
    # Default is 6379, so we avoid that to prevent conflicts.
    redis_instance = redislite.Redis(serverconfig={"port": "6397"})
    yield redis_instance
    # Shut down the redislite server when tests finish.
    redis_instance.shutdown()


@pytest.fixture
def cache_config_provider():
    return FakeCacheConfigProvider()


@pytest.fixture
def gcache(redis_server, cache_config_provider):
    Redis().flushall()
    gcache = GCache(
        GCacheConfig(
            cache_config_provider=cache_config_provider,
            urn_prefix="urn:galileo:test",
            redis_config=RedisConfig(),
        )
    )
    yield gcache
    # Manually call destructor so we make sure to remove
    # singleton checks as well as stop event loop thread
    gcache.__del__()
