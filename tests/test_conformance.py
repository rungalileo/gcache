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

# Read through the package accessor, not a repo-relative path. That is how the OTHER repo's
# consumer reads it (orbit's Go conformance suite, via an installed gcache), so exercising
# the same entry point here means a packaging mistake -- a missing poetry include, say --
# fails this suite instead of only failing across the repo boundary where nobody sees it.
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
            # And the agreement flag must match reality, so the file cannot quietly claim
            # parity it does not have.
            assert (case["python"] == case["typescript"]) == case["agree"], (
                f"{case['name']}: agree={case['agree']} contradicts the recorded renderings"
            )
            if not case["agree"]:
                assert case.get("reason"), f"{case['name']} must explain a divergence"
    finally:
        _GLOBAL_GCACHE_STATE.urn_prefix = original


def test_an_empty_prefix_is_unreachable_through_the_public_api() -> None:
    # The empty-prefix row above is a divergence gcache now forbids rather than documents, so
    # the rejection and the record must not drift apart: if someone re-enables urn_prefix=""
    # the vector file's reason becomes a lie.
    import inspect

    from gcache.gcache import GCache

    case = next(c for c in _DATA["keyRendering"]["cases"] if c["name"] == "empty-prefix")
    assert not case["agree"], "the empty-prefix case is recorded as divergent"
    src = inspect.getsource(GCache.__init__)
    assert "raise EmptyUrnPrefixNotSupported()" in src, (
        "the vector file says this configuration is rejected at construction; it is not"
    )


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
