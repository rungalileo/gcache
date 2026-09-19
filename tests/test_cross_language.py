"""Cross-language conformance tests for the gcache wire protocol.

Go and Python write into the same Redis key space; a one-character drift in key
construction silently splits it into a quiet miss. Needs Redis (redislite) and the Go
toolchain to build ``gcachectl``.
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
from google.protobuf import descriptor_pb2
from redis.asyncio import Redis

from gcache import CacheLayer, Envelope, GCache, GCacheConfig, GCacheKeyConfig, JsonSerializer, ProtoSerializer

from .conftest import REDIS_PORT

# `gcachectl -op get` exits with this on a miss, so a miss is distinguishable from an error.
EXIT_MISS = 10

KEY_TYPE = "session_id"
USE_CASE = "gcache_tests::cross_language"


@pytest.fixture(scope="session")
def gcachectl(tmp_path_factory: pytest.TempPathFactory) -> str:
    """Build the Go CLI from source in this repo and return its path.

    Built, not located, so the binary under test is always this working copy's source -- a
    stale prebuilt would report agreement with code nobody runs. Skips if Go is absent (CI
    must never skip -- see the conformance workflow).
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
        # Must point at the redislite instance the fixtures started, or the two halves
        # would compare against different servers and the suite would pass by never
        # disagreeing.
        env = {**os.environ, "GALILEO_REDIS_HOST": "localhost", "GALILEO_REDIS_PORT": str(REDIS_PORT)}
        return subprocess.run(cmd, capture_output=True, text=True, timeout=30, env=env)

    def put(self, sid: str, value: dict, envelope: str = "json") -> subprocess.CompletedProcess:
        return self._run(*self._key_flags(sid), "-op", "put", "-value", json.dumps(value), "-envelope", envelope)

    def get(self, sid: str, envelope: str = "json") -> subprocess.CompletedProcess:
        return self._run(*self._key_flags(sid), "-op", "get", "-envelope", envelope)

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

    Sweeps both key forms: a tracked key is wrapped in braces (the Redis Cluster hash tag
    keeping value and watermark in one slot), so ``{prefix...`` won't match ``prefix*`` and
    a prefix-only sweep would leave tracked keys behind.
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

    Port comes from the fixture that started the server, not read independently -- if
    Python and Go ever pointed at different servers, the suite would pass by never being
    able to disagree.
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

    The counter proves a *cache read* happened, not a fallback -- the return value alone
    would pass even on a miss.
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
    # Deliberately NOT alphabetical, passed unsorted to BOTH clients: both sort internally,
    # so this is a real comparison rather than one where hand-sorted args could mask a
    # disagreement between the two constructors.
    args = [("beta", "2"), ("alpha", "1")]

    previous = _GLOBAL_GCACHE_STATE.urn_prefix
    _GLOBAL_GCACHE_STATE.urn_prefix = urn_prefix
    try:
        py_key = GCacheKey(
            key_type=KEY_TYPE,
            id=sid,
            use_case=USE_CASE,
            args=args,
            invalidation_tracking=True,
        )
        py_value_key = py_key.urn
        py_watermark_key = py_key.prefix + "#watermark"
    finally:
        _GLOBAL_GCACHE_STATE.urn_prefix = previous

    go_keys = go.render_keys(sid, args="beta=2,alpha=1")

    assert go_keys["value_key"] == py_value_key
    assert go_keys["watermark_key"] == py_watermark_key


# --- PROTO envelope -------------------------------------------------------------------
#
# The tests above run entirely on Envelope.JSON. PROTO is the envelope orbit's
# session-identity cache actually ships, so leaving it out meant the framing in production
# use had never been round-tripped between the two languages through a real Redis -- the
# corpus pins the bytes and the keys separately, but nothing exercised the composition.
#
# descriptor_pb2.FileOptions rather than a schema of our own: gcache deliberately has no
# .proto and no codegen pipeline, and FileOptions is already compiled into both languages.


def assert_stored_framing(redis_server: redislite.Redis, value_key: str, expect: str) -> None:
    """Assert the FRAMING actually in Redis, by its leading byte.

    Necessary because gcache reads by sniffing the leading byte rather than trusting the
    key's declared envelope, so a reader happily accepts either framing. A value-level
    assertion therefore passes no matter which envelope the writer used -- verified: making
    the Go side write EnvelopeJSON instead of PROTO left every value assertion green. Only
    the stored bytes distinguish them.

    Ranges are gcache's own dispatch table: 0x08..0x75 protobuf (fields 1-14, any wire
    type), 0x7b '{' JSON, 0x80 pickle.
    """
    raw = redis_server.get(value_key)
    assert raw is not None, f"nothing stored at {value_key}"
    first = raw[0]
    if expect == "proto":
        assert 0x08 <= first <= 0x75, f"expected a protobuf envelope, got first byte 0x{first:02x}"
    elif expect == "json":
        assert first == 0x7B, f"expected a JSON envelope, got first byte 0x{first:02x}"
    else:
        raise AssertionError(f"unknown framing {expect!r}")


def proto_reader(gc: GCache, sentinel: descriptor_pb2.FileOptions) -> tuple[Callable, dict]:
    """The PROTO counterpart of python_reader, including its fallback counter.

    The counter is what separates "read Go's entry" from "ran the fallback and produced an
    equal value" -- for proto especially, comparing the returned message alone would pass
    against an empty cache.
    """
    config = GCacheKeyConfig.enabled(3600)
    config.ramp[CacheLayer.LOCAL] = 0  # force every read through the shared Redis layer

    calls = {"n": 0}

    @gc.cached(
        key_type=KEY_TYPE,
        id_arg="sid",
        use_case=USE_CASE,
        track_for_invalidation=True,
        envelope=Envelope.PROTO,
        serializer=ProtoSerializer(descriptor_pb2.FileOptions),
        default_config=config,
    )
    async def read(sid: str) -> descriptor_pb2.FileOptions:
        calls["n"] += 1
        return sentinel

    return read, calls


@pytest.mark.asyncio
async def test_python_reads_a_proto_value_written_by_go(
    go: GoClient, py_cache: GCache, redis_server: redislite.Redis
) -> None:
    sid = "sid-proto-go-to-py"
    written = {"goPackage": "from-go", "javaPackage": "com.galileo.x"}

    result = go.put(sid, written, envelope="proto")
    assert result.returncode == 0, result.stderr
    assert_stored_framing(redis_server, go.render_keys(sid)["value_key"], "proto")

    # A sentinel that differs in BOTH fields, so a fallback result cannot be mistaken for
    # Go's entry on a partial match.
    sentinel = descriptor_pb2.FileOptions(go_package="python-fallback", java_package="com.galileo.fallback")
    read, calls = proto_reader(py_cache, sentinel=sentinel)
    with py_cache.enable():
        got = await read(sid)

    assert calls["n"] == 0, "Python ran its fallback instead of reading Go's PROTO entry"
    assert got.go_package == "from-go"
    assert got.java_package == "com.galileo.x"


@pytest.mark.asyncio
async def test_go_reads_a_proto_value_written_by_python(
    go: GoClient, py_cache: GCache, redis_server: redislite.Redis
) -> None:
    sid = "sid-proto-py-to-go"
    written = descriptor_pb2.FileOptions(go_package="from-python", java_package="com.galileo.py")

    read, _ = proto_reader(py_cache, sentinel=written)
    with py_cache.enable():
        await read(sid)  # populates Redis via the fallback
    assert_stored_framing(redis_server, go.render_keys(sid)["value_key"], "proto")

    result = go.get(sid, envelope="proto")
    assert result.returncode == 0, f"Go missed Python's PROTO entry: {result.stderr}"
    # PARSED, not the raw bytes: Go's protojson injects randomised whitespace
    # (internal/detrand), so its output is not byte-stable even for one message.
    assert json.loads(result.stdout) == {"goPackage": "from-python", "javaPackage": "com.galileo.py"}


@pytest.mark.asyncio
async def test_a_proto_entry_is_not_readable_as_json(go: GoClient) -> None:
    """The two framings must not silently cross over.

    gcache dispatches on the leading byte, so a PROTO entry (0x08..0x75) read by a
    JSON-declared caller must degrade to a MISS, not to a half-parsed value. Without this,
    an envelope mismatch between the two services would surface as corrupt data rather than
    as a cache that simply never hits.
    """
    sid = "sid-proto-not-json"
    assert go.put(sid, {"goPackage": "from-go"}, envelope="proto").returncode == 0

    result = go.get(sid, envelope="json")
    assert result.returncode != 0, f"a JSON reader accepted a PROTO entry: {result.stdout!r}"
