import asyncio
import contextvars
import time
from random import random

from cachegalileo.event_loop_thread import EventLoopThread, EventLoopThreadPool


def test_concurrent() -> None:
    """
    Test that we can process a lot of couroutines concurrently by scheduling 10k of them.
    Each coroutine is expected to take less than ~1.1 seconds so we should not exceed a boundary like 2 seconds.
    :return:
    """
    event_loop = EventLoopThread()
    try:
        event_loop.start()

        async def heavy_work() -> None:
            total = 0.0
            while total < 1:
                to_sleep = random() * 0.1
                total += to_sleep
                await asyncio.sleep(to_sleep)

        start = time.time()
        results = []

        for i in range(10_000):
            results.append(event_loop.submit(heavy_work, wait_for_result=False))

        print("Awaiting results")

        for result in results:
            result.result()

        elapsed_time = time.time() - start
        print(f"Elapsed time: {elapsed_time}")

        # Total elapsed time should be a few seconds.  On fast machines its close to 1.1s
        assert elapsed_time < 5
    finally:
        event_loop.stop()


def test_propogate_context() -> None:
    event_loop = EventLoopThreadPool()
    context_var = contextvars.ContextVar("test_var", default=0)
    try:

        async def readout_context() -> int:
            return context_var.get()

        context_var.set(1337)
        assert 1337 == event_loop.submit(readout_context)
    finally:
        event_loop.stop()


def test_blocking_sync() -> None:
    """
    Test that we can process a bunch of blocking calls in submitted coroutines because we are using a thread pool
    underneath.
    Each coroutine is expected to take less than ~1.1 seconds so we should not exceed a boundary like 2 seconds.
    :return:
    """
    event_loop = EventLoopThreadPool(num_threads=100)
    try:

        async def heavy_work() -> None:
            total = 0.0
            while total < 1:
                to_sleep = random() * 0.1
                total += to_sleep
                time.sleep(to_sleep)  # noqa: ASYNC251

        start = time.time()
        results = []

        for i in range(100):
            results.append(event_loop.submit(heavy_work, wait_for_result=False))

        print("Awaiting results")

        for result in results:
            result.result()

        elapsed_time = time.time() - start
        print(f"Elapsed time: {elapsed_time}")

        # Total elapsed time should be a few seconds.  On fast machines its close to 1.1s
        assert elapsed_time < 6
    finally:
        event_loop.stop()
