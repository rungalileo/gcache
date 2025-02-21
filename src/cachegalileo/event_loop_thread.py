import asyncio
import threading
from collections.abc import Awaitable, Callable
from concurrent.futures import Future
from typing import Any

import uvloop


class EventLoopThread(threading.Thread):
    """
    A thread that runs its own event loop so you can submit coroutines to be executed
    on it and wait for results from synchronous code.
    """

    def __init__(self, name: str = "EventLoopThread") -> None:
        super().__init__(name=name)
        self.loop = uvloop.new_event_loop()

    def run(self) -> None:
        # Set the event loop for this thread.
        asyncio.set_event_loop(self.loop)
        print(f"Event loop '{self.name}' started.")
        self.loop.run_forever()

    def submit(self, async_fn: Callable[[], Awaitable[Any]], wait_for_result: bool = True) -> Any:
        """
        Submit an async function to the event loop running in this thread.

        If `wait_for_result` is True, this method will block until the async function
        completes and returns its result (or raises an exception). Otherwise, it returns
        a concurrent.futures.Future immediately.

        This implementation preserves context variables of the thread that calls submit.
        """

        future: Future = asyncio.run_coroutine_threadsafe(async_fn(), self.loop)

        if wait_for_result:
            # Block until the result is ready (or an exception is raised).
            result = future.result()
            return result
        else:
            return future

    def stop(self) -> None:
        """Stop the event loop."""
        self.loop.call_soon_threadsafe(self.loop.stop)
