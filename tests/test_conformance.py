"""Python half of the shared cross-language envelope conformance suite.

Both this file and ``packages/gcache-ts/test/gcache-conformance.test.ts`` read
``conformance/envelope_vectors.json``. Neither may hardcode a case: one source of truth is
the entire point, because parity used to be asserted by hand-mirrored literals in two suites
running in separate CI workflows -- so a divergence was only ever caught by a human reading
both. Two escaped that way and were found in review rather than by a test.
"""

import base64
import json
import pathlib
from typing import Any

import pytest

from gcache._internal.envelope import ENVELOPE_VERSION, EnvelopeDecodeError, decode
from gcache.conformance import load_vectors, vectors_path

# Read through the package accessor, not a repo-relative path. The TypeScript and Go suites
# both read the file by relative path, so nothing else exercises the packaged form -- and a
# packaging mistake (a missing poetry include, say) would then only surface downstream, in
# whatever service installed gcache and could not find the vectors.
_DATA = load_vectors()
_VECTORS = _DATA["vectors"]


def test_the_vector_file_is_where_every_suite_expects_it() -> None:
    # A missing or moved file must fail loudly here rather than making the suites vacuously
    # green by parametrizing over an empty list -- which is exactly how a shared-fixture
    # suite dies quietly.
    assert pathlib.Path(vectors_path()).exists(), f"shared vectors missing at {vectors_path()}"
    assert len(_VECTORS) >= 14, f"expected the full vector set, got {len(_VECTORS)}"
    assert _DATA["envelopeVersion"] == ENVELOPE_VERSION, (
        "the vector file's envelopeVersion must track ENVELOPE_VERSION, or every "
        "version-sensitive vector silently tests the wrong thing"
    )
    # Every vector must declare an expectation, and every accept must say what it decodes to.
    for v in _VECTORS:
        assert v["expect"] in ("accept", "reject"), v["name"]
        assert v.get("why"), f"{v['name']} must record why it exists"
        if v["expect"] == "accept":
            assert "decoded" in v, f"{v['name']} is an accept case with no expected decode"

        # The asymmetry invariant is checked HERE, unconditionally, rather than inside the
        # per-vector branch that handles "this client accepts what another rejects". A
        # reviewer caught why that mattered: in the branch, the check only ran when the
        # reading client happened to be on the accepting side, so a vector whose rejectedBy
        # names THIS client could omit acceptedBy and asymmetryIsSafe entirely and still
        # pass. And with no asymmetry vectors currently in the file, neither branch ran at
        # all -- the invariant was unexercised. Global and unconditional is the only placement
        # where every vector is subject to it regardless of which side each client is on.
        if "rejectedBy" in v or "acceptedBy" in v:
            assert v.get("rejectedBy"), f"{v['name']}: acceptedBy without rejectedBy"
            assert v.get("acceptedBy"), f"{v['name']}: rejectedBy without acceptedBy"
            assert v.get("asymmetryIsSafe"), f"{v['name']}: an asymmetry must justify its direction"
            assert v["expect"] == "reject", f"{v['name']}: an asymmetry is expressed on a reject vector"
            overlap = set(v["rejectedBy"]) & set(v["acceptedBy"])
            assert not overlap, f"{v['name']}: a client cannot both accept and reject: {overlap}"
            known = {"python", "typescript", "go"}
            unknown = (set(v["rejectedBy"]) | set(v["acceptedBy"])) - known
            assert not unknown, f"{v['name']}: unknown client(s) {unknown}"


def _applies_to_python(vector: dict) -> bool:
    """Whether this vector's stated expectation is Python's.

    Most vectors apply to every client. A few record a DELIBERATE asymmetry -- one client
    cannot represent the value faithfully, so rejecting it there yields a miss-and-rewrite
    rather than two clients serving the same bytes as different numbers. Those carry
    ``rejectedBy``/``acceptedBy``, and a suite must not assert another client's answer.
    """
    rejected_by = vector.get("rejectedBy")
    if rejected_by is None:
        return True
    assert vector.get("acceptedBy"), f"{vector['name']}: rejectedBy needs acceptedBy"
    assert vector.get("asymmetryIsSafe"), f"{vector['name']}: an asymmetry must justify its direction"
    return "python" in rejected_by


@pytest.mark.parametrize("vector", _VECTORS, ids=lambda v: v["name"])
def test_envelope_vector(vector: dict) -> None:
    raw = vector["envelope"].encode("utf-8")

    if vector["expect"] == "reject" and not _applies_to_python(vector):
        # Python is on the accepting side of a deliberate asymmetry. Assert that it really
        # does accept, rather than skipping -- a skip here would let Python silently start
        # rejecting too, which would make the recorded asymmetry a lie.
        assert "python" in vector["acceptedBy"], vector["name"]
        got = decode(raw, allow_pickle=False)
        assert got.created_at_ms is not None
        return

    if vector["expect"] == "reject":
        # EnvelopeDecodeError specifically, not "any exception": every failure mode has to
        # arrive as the one exception callers convert to a miss. Anything else escapes
        # RedisCache.get, and a cache must not be able to fail a request.
        with pytest.raises(EnvelopeDecodeError):
            decode(raw, allow_pickle=False)
        return

    got = decode(raw, allow_pickle=False)
    expected = vector["decoded"]
    assert got.created_at_ms == expected["createdAtMs"]
    assert got.expires_at_ms == expected["expiresAtMs"]
    # Ints, not floats -- a whole-number float on the wire must still decode to an int, or
    # the value re-serializes differently from how every writer emits it.
    assert isinstance(got.created_at_ms, int) and not isinstance(got.created_at_ms, bool)
    assert isinstance(got.expires_at_ms, int) and not isinstance(got.expires_at_ms, bool)

    if "payloadBase64" in expected:
        assert got.payload == base64.b64decode(expected["payloadBase64"])
    else:
        payload = got.payload.decode("utf-8") if isinstance(got.payload, bytes) else got.payload
        assert payload == expected["payload"]


def test_the_key_rendering_divergences_are_still_what_the_file_says() -> None:
    # Not decode vectors -- a record of what each client renders, so a change to either side
    # shows up as a failure here instead of as silently unshared entries. The Python half is
    # executed; the TypeScript half is a recorded literal that its own suite checks.
    from gcache._internal.state import _GLOBAL_GCACHE_STATE
    from gcache.config import render_prefix

    original = _GLOBAL_GCACHE_STATE.urn_prefix
    try:
        for case in _DATA["keyRendering"]["cases"]:
            _GLOBAL_GCACHE_STATE.urn_prefix = case["urnPrefix"]
            rendered = render_prefix(case["keyType"], case["id"], tracked=False)
            assert rendered == case["python"], (
                f"{case['name']}: Python renders {rendered!r}, file says {case['python']!r}"
            )

            # The partition must match what the recorded strings actually say, so the file
            # cannot claim an agreement its own values contradict. This replaced a two-way
            # `agree: bool`, which could not express the real situation once Go arrived:
            # Go and Python agree, TypeScript does not, and a boolean has no way to say so.
            actual: dict[str, list[str]] = {}
            for client in ("go", "python", "typescript"):
                actual.setdefault(case[client], []).append(client)
            expected = sorted((sorted(v) for v in actual.values()), key=lambda g: g[0])
            assert case["agreeingClients"] == expected, (
                f"{case['name']}: agreeingClients={case['agreeingClients']} contradicts the "
                f"recorded renderings, which group as {expected}"
            )
            if len(case["agreeingClients"]) > 1:
                assert case.get("reason"), f"{case['name']} must explain a divergence"
    finally:
        _GLOBAL_GCACHE_STATE.urn_prefix = original


def test_an_empty_prefix_is_unreachable_through_the_public_api() -> None:
    # The empty-prefix row above is a divergence gcache now forbids rather than documents, so
    # the rejection and the record must not drift apart: if someone re-enables urn_prefix=""
    # the vector file's reason becomes a lie.
    #
    # This used to assert `inspect.getsource(GCache.__init__)` contained the raise, and a
    # reviewer was right to call that out: a source-text check stays green if the CONDITION
    # is changed and the text left behind, so it would not have caught the regression it
    # exists to catch. It was written that way because the singleton check came first, which
    # made the branch unreachable in-process while the conftest fixture holds an instance.
    # GCache.__init__ now validates pure config BEFORE the singleton check, so the real path
    # is reachable and this asserts behaviour.
    from gcache import GCache, GCacheConfig
    from gcache.exceptions import EmptyUrnPrefixNotSupported
    from tests.conftest import FakeCacheConfigProvider

    case = next(c for c in _DATA["keyRendering"]["cases"] if c["name"] == "empty-prefix")
    assert len(case["agreeingClients"]) > 1, "the empty-prefix case is recorded as divergent"
    # Specifically: Python and Go omit the empty component, TypeScript joins it. This is the
    # divergence that survives fixing the percent-encoding, which is why it is an error here
    # rather than a documented caveat.
    assert ["go", "python"] in case["agreeingClients"]

    with pytest.raises(EmptyUrnPrefixNotSupported):
        GCache(GCacheConfig(cache_config_provider=FakeCacheConfigProvider(), urn_prefix=""))

    # It must beat GCacheAlreadyInstantiated, which is what the ordering above buys: the
    # caller learns their config is invalid rather than that another instance exists.
    from gcache.exceptions import GCacheAlreadyInstantiated

    assert not issubclass(EmptyUrnPrefixNotSupported, GCacheAlreadyInstantiated)
    # And it is a ValueError, so an existing construction guard still catches it.
    assert issubclass(EmptyUrnPrefixNotSupported, ValueError)


def test_the_watermark_and_envelope_parsers_really_do_differ() -> None:
    # The vector file records an asymmetry -- envelope timestamps stop at 2^53, the watermark
    # keeps an int64 bound -- and justifies it with measured Python values. If those
    # measurements stop holding, the justification becomes a story rather than a reason, so
    # execute them rather than trusting the prose.
    #
    # The split is real and easy to miss: json.loads returns an exact int at any magnitude,
    # float() returns a double and rounds above 2^53. Go reaches BOTH fields through a
    # float64, so Python's watermark already agrees with Go there and its envelope did not.
    # That is why tightening the watermark would introduce a divergence instead of closing
    # one -- the opposite of the obvious move.
    from gcache._internal.redis_cache import _parse_watermark
    from gcache.config import GCacheKey

    key = GCacheKey(key_type="kt", id="i", use_case="u", invalidation_tracking=True)
    noop: Any = lambda _reason: None  # noqa: E731 - a recorder that records nothing

    # Rounds, exactly as Go and JavaScript do. Asserted as equality to the ROUNDED value, not
    # merely "differs", so a parser change that rounds differently also fails.
    assert _parse_watermark(b"9007199254740993", key, noop) == 9007199254740992
    assert _parse_watermark(b"9007199254740995", key, noop) == 9007199254740996
    # And is exact at and below the boundary, so the test is about 2^53 and not about float()
    # being lossy everywhere.
    assert _parse_watermark(b"9007199254740991", key, noop) == 9007199254740991
    assert _parse_watermark(b"1757308800123", key, noop) == 1757308800123

    # The envelope side rejects what the watermark rounds -- the two halves of the asymmetry,
    # pinned together so neither can drift alone.
    raw = json.dumps(
        {
            "version": ENVELOPE_VERSION,
            "createdAtMs": 9007199254740993,
            "expiresAtMs": 9007199254740993,
            "encoding": "utf8",
            "payload": '{"a":1}',
        }
    ).encode()
    with pytest.raises(EnvelopeDecodeError, match="safe-integer"):
        decode(raw, allow_pickle=False)

    # The file must still say so, or the code and the record drift apart silently.
    assert "watermarkVsEnvelope" in _DATA, "the vector file must document why the bounds differ"


def test_argument_order_is_normalized_identically_by_every_client() -> None:
    # Args sort by name in all three clients, so caller order cannot change the key.
    #
    # This exists because its absence cost a real divergence: keyRendering's cases carry no
    # args at all, so Go sorted while Python's constructor did not, and every suite stayed
    # green. The sorted rendering is not a new convention -- cached() has always sorted
    # before constructing a key, so it is what every key in production already looks like.
    from gcache import GCacheKey
    from gcache._internal.state import _GLOBAL_GCACHE_STATE

    original = _GLOBAL_GCACHE_STATE.urn_prefix
    try:
        for case in _DATA["argOrdering"]["cases"]:
            _GLOBAL_GCACHE_STATE.urn_prefix = case["urnPrefix"]
            rendered = GCacheKey(
                key_type=case["keyType"],
                id=case["id"],
                use_case=case["useCase"],
                args=[(name, value) for name, value in case["args"]],
            ).urn
            assert rendered == case["python"], (
                f"{case['name']}: Python renders {rendered!r}, file says {case['python']!r}"
            )

            actual: dict[str, list[str]] = {}
            for client in ("go", "python", "typescript"):
                actual.setdefault(case[client], []).append(client)
            expected = sorted((sorted(v) for v in actual.values()), key=lambda g: g[0])
            assert case["agreeingClients"] == expected, (
                f"{case['name']}: agreeingClients={case['agreeingClients']} contradicts the "
                f"recorded renderings, which group as {expected}"
            )
            assert case.get("why"), f"{case['name']} must say what it is for"
    finally:
        _GLOBAL_GCACHE_STATE.urn_prefix = original


def test_the_arg_order_corpus_could_detect_a_client_that_stopped_sorting() -> None:
    # The control case's own weakness, asserted. 'already-alpha' renders the same whether a
    # client sorts or preserves input order, so a corpus of only alphabetical cases cannot
    # detect a client that stops sorting -- which is exactly how the Go/Python split
    # survived. At least one case must differ from its own input-order rendering.
    def input_order_rendering(case: dict[str, Any]) -> str:
        body = "&".join(f"{name}={value}" for name, value in case["args"])
        return f"{case['urnPrefix']}:{case['keyType']}:{case['id']}?{body}#{case['useCase']}"

    cases = _DATA["argOrdering"]["cases"]
    discriminating = [c for c in cases if c["python"] != input_order_rendering(c)]
    assert discriminating, (
        "every argOrdering case renders the same sorted or unsorted, so this corpus cannot "
        "detect a client that stopped sorting -- add a case whose args are not alphabetical"
    )
