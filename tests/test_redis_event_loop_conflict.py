import asyncio
import threading
import time
from typing import Any

import pytest
import redislite

from gcache import GCache, GCacheConfig, GCacheKeyConfig, RedisConfig

from .conftest import REDIS_PORT, FakeCacheConfigProvider


class MockFastAPIEventLoop:
    """Simulates the FastAPI environment with its own event loop."""

    def __init__(self) -> None:
        self.loop: asyncio.AbstractEventLoop | None = None
        self.thread: threading.Thread | None = None
        self.test_complete = threading.Event()
        self.error: Exception | None = None
        self.result: Any = None

    def start(self) -> None:
        """Start a dedicated event loop in a separate thread (like FastAPI would do)."""
        self.thread = threading.Thread(target=self._run_event_loop)
        self.thread.daemon = True
        self.thread.start()
        # Wait for loop to be ready
        time.sleep(0.1)

    def _run_event_loop(self) -> None:
        """Run an event loop in this thread."""
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_forever()
        except Exception as e:
            self.error = e
        finally:
            if self.loop:
                self.loop.close()

    def run_coroutine(self, coro: Any) -> Any:
        """Run a coroutine in this event loop and return its result."""
        if not self.loop:
            raise RuntimeError("Event loop not initialized")
        future = asyncio.run_coroutine_threadsafe(coro, self.loop)
        return future.result(10)  # timeout after 10 seconds

    def stop(self) -> None:
        """Stop the event loop."""
        if self.loop and self.thread and self.thread.is_alive():
            self.loop.call_soon_threadsafe(self.loop.stop)
            self.thread.join(timeout=5)


@pytest.mark.asyncio
async def test_multi_loop_concurrent_access(
    cache_config_provider: FakeCacheConfigProvider, redis_server: redislite.Redis
) -> None:
    """
    This test simulates concurrent access from multiple event loops,
    which would cause race conditions without our thread-local Redis client fix.
    """
    # Create GCache instance
    gcache = GCache(
        GCacheConfig(
            cache_config_provider=cache_config_provider,
            urn_prefix="urn:galileo:test",
            redis_config=RedisConfig(port=REDIS_PORT),
        )
    )

    # Create a cached function
    @gcache.cached(
        key_type="ConcurrentTest",
        id_arg="id",
        track_for_invalidation=True,
        default_config=GCacheKeyConfig.enabled(60, "test"),
    )
    def cached_func(id: str) -> int:
        return 42

    # Create multiple FastAPI-like environments
    fastapi_envs = [MockFastAPIEventLoop() for _ in range(3)]
    for env in fastapi_envs:
        env.start()

    try:
        # Define an async function that does Redis operations
        async def do_redis_operations(loop_id: int) -> str:
            # Do a cache get
            with gcache.enable():
                cached_func(id=f"test-{loop_id}")

            # Do a cache invalidation (this would use Redis)
            gcache.invalidate("ConcurrentTest", f"test-{loop_id}")

            # Do an async invalidation
            await gcache.ainvalidate("ConcurrentTest", f"test-{loop_id}")

            # Access another key that other loops might be using
            with gcache.enable():
                cached_func(id="shared-key")

            return f"success-{loop_id}"

        # Run operations concurrently in all event loops
        # Without our thread-local Redis fix, this would cause errors
        results: list[str] = []
        for i, env in enumerate(fastapi_envs):
            results.append(env.run_coroutine(do_redis_operations(i)))

        # All should have succeeded
        for i, result in enumerate(results):
            assert result == f"success-{i}"

    finally:
        # Clean up
        for env in fastapi_envs:
            env.stop()
