import asyncio
import random
import threading
from abc import abstractmethod
from collections.abc import Awaitable, Callable
from concurrent.futures import Future
from logging import getLogger
from typing import Any

import uvloop

logger = getLogger(__name__)


class EventLoopThreadInterface:
    @abstractmethod
    def submit(self, async_fn: Callable[[], Awaitable[Any]], wait_for_result: bool = True) -> Any:
        pass

    @abstractmethod
    def stop(self, timeout_sec: int = 2) -> None:
        pass


class EventLoopThread(EventLoopThreadInterface, threading.Thread):
    """
    A thread that runs its own event loop so you can submit coroutines to be executed
    on it and wait for results from synchronous code.
    """

    def __init__(self, name: str = "EventLoopThread", daemon: bool = True) -> None:
        super().__init__(name=name)
        self.daemon = daemon
        self.loop = uvloop.new_event_loop()

    def run(self) -> None:
        # Set the event loop for this thread.
        asyncio.set_event_loop(self.loop)
        logger.info(f"Event loop '{self.name}' started.")
        self.loop.run_forever()

    def submit(self, async_fn: Callable[[], Awaitable[Any]], wait_for_result: bool = True) -> Any:
        """
        Submit an async function to the event loop running in this thread.

        If `wait_for_result` is True, this method will block until the async function
        completes and returns its result (or raises an exception). Otherwise, it returns
        a concurrent.futures.Future immediately.

        This implementation preserves context variables of the thread that calls submit.
        """

        future: Future = asyncio.run_coroutine_threadsafe(async_fn(), self.loop)  # type: ignore[arg-type]

        if wait_for_result:
            # Block until the result is ready (or an exception is raised).
            result = future.result()
            return result
        else:
            return future

    def stop(self, timeout_sec: int = 2) -> None:
        """Stop the event loop."""
        logger.info(f"Stopping event loop '{self.name}'.")
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.join(timeout=timeout_sec)


class EventLoopThreadPool(EventLoopThreadInterface):
    """
    Manage collection of EventLoopThread instances and also initailize them lazily.

    Lazy initialization is important when running in forked processes.
    """

    def __init__(self, name: str = "EventLoopThreadPool", num_threads: int = 16) -> None:
        self.name = name
        self.num_threads = num_threads
        self.threads: list[EventLoopThread] | None = None

        self.init_lock = threading.Lock()

    def submit(self, async_fn: Callable[[], Awaitable[Any]], wait_for_result: bool = True) -> Any:
        if self.threads is None:
            with self.init_lock:
                if self.threads is None:
                    self.threads = [EventLoopThread(f"{self.name}-{i}") for i in range(self.num_threads)]
                    for thread in self.threads:
                        thread.start()
                    logger.info(f"Initialized EventLoopThreadPool {self.name}")

        return random.choice(self.threads).submit(async_fn, wait_for_result)

    def stop(self, timeout_sec: int = 2) -> None:
        if self.threads:
            for thread in self.threads:
                thread.stop(timeout_sec)
