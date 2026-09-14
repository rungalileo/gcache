"""Cross-language conformance tests for the gcache wire protocol.

The Go client (``go/``) and the Python package (``src/gcache/``) write into the same Redis
key space so that either language can read the other's entries and either can invalidate
the other's. Nothing in the type system enforces that -- a one-character drift in key
construction, or a change to the value envelope, silently splits the key space and every
cross-language read quietly becomes a miss. These tests are the only thing that catches it.

Python drives both sides: it uses ``gcache`` directly and shells out to the ``gcachectl``
binary for the Go half.

This suite used to live in orbit, one repo away from the Python implementation it checks.
That arrangement is why it existed and also why it was not enough: five cross-language
claims went silently false in a single afternoon -- three Go comments about Python and
TypeScript behaviour, a Go test whose NAME asserted a divergence it existed to prevent, and
a conformance vector that went stale within the hour. A test can only catch drift between
things it can both reach. Now it can reach both.

Needs a Redis, and takes the session ``redis_server`` fixture (redislite) from conftest --
no external container. Needs the Go toolchain, since it builds ``gcachectl`` itself.
"""

import json
import os
import pathlib
import shutil
import subprocess
import uuid
from collections.abc import AsyncGenerator, Callable, Generator

import pytest
import pytest_asyncio
import redislite
from redis.asyncio import Redis

from gcache import CacheLayer, Envelope, GCache, GCacheConfig, GCacheKeyConfig, JsonSerializer

from .conftest import REDIS_PORT

# `gcachectl -op get` exits with this on a miss, so a miss is distinguishable from an error.
EXIT_MISS = 10

KEY_TYPE = "session_id"
USE_CASE = "gcache_tests::cross_language"


@pytest.fixture(scope="session")
def gcachectl(tmp_path_factory: pytest.TempPathFactory) -> str:
    """Build the Go CLI from source in this repo and return its path.

    Built rather than located: in orbit this resolved a Bazel runfile at the hardcoded path
    ``orbit/libs/go/gcache/cmd/gcachectl/gcachectl_/gcachectl`` -- a string carrying that
    repo's workspace name, which is wrong the moment the code moves. Building from the tree
    means the binary under test is always the source in this working copy, which is the
    property that matters for a conformance suite: a stale prebuilt binary would report
    agreement with code nobody is running.

    Skips rather than fails when the Go toolchain is absent, so a Python-only contributor is
    not blocked. CI has Go and must never skip -- see the conformance workflow.
    """
    if shutil.which("go") is None:
        pytest.skip("Go toolchain not available; this suite needs it to build gcachectl")
    out = tmp_path_factory.mktemp("gcachectl") / "gcachectl"
    go_dir = pathlib.Path(__file__).resolve().parent.parent / "go"
    result = subprocess.run(
        ["go", "build", "-o", str(out), "./cmd/gcachectl"],
        cwd=go_dir,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"go build failed:\n{result.stderr}"
    return str(out)


class GoClient:
    """Drives the Go client via the gcachectl binary."""

    def __init__(self, binary: str, urn_prefix: str) -> None:
        self._binary = binary
        self._urn = urn_prefix

    def _run(self, *args: str) -> subprocess.CompletedProcess:
        cmd = [self._binary, "-urn-prefix", self._urn, *args]
        # gcachectl reads GALILEO_REDIS_HOST/PORT. In orbit these came from .bazelrc's
        # test_env; here they must point at the redislite instance the fixtures started, or
        # the two halves of the comparison would run against different servers and the suite
        # would pass by never disagreeing.
        env = {**os.environ, "GALILEO_REDIS_HOST": "localhost", "GALILEO_REDIS_PORT": str(REDIS_PORT)}
        return subprocess.run(cmd, capture_output=True, text=True, timeout=30, env=env)

    def put(self, sid: str, value: dict) -> subprocess.CompletedProcess:
        return self._run(*self._key_flags(sid), "-op", "put", "-value", json.dumps(value))

    def get(self, sid: str) -> subprocess.CompletedProcess:
        return self._run(*self._key_flags(sid), "-op", "get")

    def invalidate(self, sid: str) -> subprocess.CompletedProcess:
        return self._run("-op", "invalidate", "-key-type", KEY_TYPE, "-id", sid)

    def render_keys(self, sid: str, args: str = "") -> dict:
        result = self._run(*self._key_flags(sid), "-op", "key", "-args", args)
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)

    @staticmethod
    def _key_flags(sid: str) -> list[str]:
        return ["-key-type", KEY_TYPE, "-id", sid, "-use-case", USE_CASE, "-tracked"]


@pytest.fixture
def urn_prefix(redis_server: redislite.Redis) -> Generator[str, None, None]:
    """A gcache ``urn_prefix`` unique to one test, cleaned up afterwards.

    Every key the test writes lands under the prefix, so tests cannot collide with each
    other or with anything a previous run left behind. In orbit this came from a shared
    fixture that resolved a client through ``setgalileo``'s RedisConfig; here the session
    ``redis_server`` is already a client, so the indirection is gone.

    Both key forms are swept. An invalidation-tracked key is wrapped in braces -- the Redis
    Cluster hash tag that keeps a value and its watermark in one slot -- so ``{prefix...``
    does not match ``prefix*`` and a prefix-only sweep would leave every tracked key behind.
    """
    prefix = f"urn:galileo:xlang-{uuid.uuid4()}"
    yield prefix

    for pattern in (f"{prefix}*", "{" + prefix + "*"):
        for key in redis_server.scan_iter(match=pattern, count=500):
            redis_server.delete(key)


@pytest.fixture
def go(gcachectl: str, urn_prefix: str) -> GoClient:
    return GoClient(gcachectl, urn_prefix)


def redis_url() -> str:
    """The redislite endpoint both halves of the suite must share.

    One source for the port, imported from conftest, for the reason orbit's version resolved
    through RedisConfig: if the Python and Go halves ever pointed at different servers the
    suite would pass by never being able to disagree. That is the failure mode a conformance
    test must not have, so the port is taken from the fixture that started the server rather
    than read independently.
    """
    return f"redis://localhost:{REDIS_PORT}"


@pytest_asyncio.fixture
async def py_cache(urn_prefix: str) -> AsyncGenerator[GCache, None]:
    # The factory is called per layer, so track every client it hands out and close them
    # all. A bare `yield gc` leaked one asyncio connection pool per call, which surfaces as
    # unclosed-connection warnings and, on a long suite, real socket exhaustion.
    clients: list[Redis] = []

    def build_client() -> Redis:
        client = Redis.from_url(redis_url())
        clients.append(client)
        return client

    gc = GCache(
        GCacheConfig(
            redis_client_factory=build_client, urn_prefix=urn_prefix, metrics_prefix=f"xlang_{uuid.uuid4().hex[:8]}_"
        )
    )
    try:
        yield gc
    finally:
        # Async so teardown runs on the test's own loop. The sync form needed
        # asyncio.get_event_loop(), which raises on 3.14 when no loop is current, and
        # suppressing that turned the leak this fixture exists to fix back on silently.
        for client in clients:
            await client.aclose()


def python_reader(gc: GCache, sentinel: dict) -> tuple[Callable, dict]:
    """A Python cached function over the shared key, plus a counter of fallback calls.

    The counter is what proves a *cache read* happened rather than a fallback: asserting on
    the returned value alone would pass even if Python had missed and recomputed.
    """
    config = GCacheKeyConfig.enabled(3600)
    config.ramp[CacheLayer.LOCAL] = 0  # force every read through the shared Redis layer

    calls = {"n": 0}

    @gc.cached(
        key_type=KEY_TYPE,
        id_arg="sid",
        use_case=USE_CASE,
        track_for_invalidation=True,
        envelope=Envelope.JSON,
        serializer=JsonSerializer(),
        default_config=config,
    )
    async def read(sid: str) -> dict:
        calls["n"] += 1
        return sentinel

    return read, calls


@pytest.mark.asyncio
async def test_python_reads_a_value_written_by_go(go: GoClient, py_cache: GCache) -> None:
    sid = "sid-go-to-py"
    written = {"session_id": sid, "created_at": "2026-09-08T02:42:19.068724Z"}

    result = go.put(sid, written)
    assert result.returncode == 0, result.stderr

    read, calls = python_reader(py_cache, sentinel={"from": "python-fallback"})
    with py_cache.enable():
        assert await read(sid) == written
    assert calls["n"] == 0, "Python ran its fallback instead of reading Go's entry"


@pytest.mark.asyncio
async def test_go_reads_a_value_written_by_python(go: GoClient, py_cache: GCache) -> None:
    sid = "sid-py-to-go"
    written = {"session_id": sid, "created_at": "2026-09-08T02:42:19.068724Z"}

    read, _ = python_reader(py_cache, sentinel=written)
    with py_cache.enable():
        await read(sid)  # populates Redis via the fallback

    result = go.get(sid)
    assert result.returncode == 0, f"Go missed Python's entry: {result.stderr}"
    assert json.loads(result.stdout) == written


@pytest.mark.asyncio
async def test_go_invalidation_is_seen_by_python(go: GoClient, py_cache: GCache) -> None:
    sid = "sid-go-invalidates"
    sentinel = {"from": "python-fallback"}
    read, calls = python_reader(py_cache, sentinel=sentinel)

    result = go.put(sid, {"session_id": sid})
    assert result.returncode == 0, result.stderr

    with py_cache.enable():
        assert await read(sid) == {"session_id": sid}
        assert calls["n"] == 0

        assert go.invalidate(sid).returncode == 0
        assert await read(sid) == sentinel, "Python served a value Go had invalidated"
        assert calls["n"] == 1


@pytest.mark.asyncio
async def test_python_invalidation_is_seen_by_go(go: GoClient, py_cache: GCache) -> None:
    sid = "sid-py-invalidates"
    read, _ = python_reader(py_cache, sentinel={"session_id": sid})
    with py_cache.enable():
        await read(sid)

    assert go.get(sid).returncode == 0

    await py_cache.ainvalidate(key_type=KEY_TYPE, id=sid)

    result = go.get(sid)
    assert result.returncode == EXIT_MISS, (
        f"Go served a value Python had invalidated (rc={result.returncode}, out={result.stdout!r})"
    )


@pytest.mark.asyncio
async def test_go_treats_a_python_pickle_entry_as_a_miss(go: GoClient, py_cache: GCache) -> None:
    # A use case that has NOT opted into the JSON envelope still writes pickle. Go cannot
    # read that, and must degrade to a miss rather than crashing or returning garbage.
    sid = "sid-pickle"
    config = GCacheKeyConfig.enabled(3600)
    config.ramp[CacheLayer.LOCAL] = 0

    @py_cache.cached(
        key_type=KEY_TYPE, id_arg="sid", use_case=USE_CASE, track_for_invalidation=True, default_config=config
    )
    async def read(sid: str) -> dict:
        return {"written": "as pickle"}

    with py_cache.enable():
        await read(sid)

    result = go.get(sid)
    assert result.returncode == EXIT_MISS, (
        f"expected a clean miss on a pickle entry, got rc={result.returncode} "
        f"out={result.stdout!r} err={result.stderr!r}"
    )


def test_go_and_python_render_identical_keys(go: GoClient, urn_prefix: str) -> None:
    # The keys themselves, with no Redis involved. This is the check that fails loudly when
    # key construction drifts -- every other test here would just report a mysterious miss.
    from gcache._internal.state import _GLOBAL_GCACHE_STATE
    from gcache.config import GCacheKey

    sid = "sid-key-shape"
    args = [("beta", "2"), ("alpha", "1")]  # deliberately out of order

    previous = _GLOBAL_GCACHE_STATE.urn_prefix
    _GLOBAL_GCACHE_STATE.urn_prefix = urn_prefix
    try:
        py_key = GCacheKey(
            key_type=KEY_TYPE,
            id=sid,
            use_case=USE_CASE,
            args=sorted(args, key=lambda a: a[0]),
            invalidation_tracking=True,
        )
        py_value_key = py_key.urn
        py_watermark_key = py_key.prefix + "#watermark"
    finally:
        _GLOBAL_GCACHE_STATE.urn_prefix = previous

    go_keys = go.render_keys(sid, args="beta=2,alpha=1")

    assert go_keys["value_key"] == py_value_key
    assert go_keys["watermark_key"] == py_watermark_key
