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

import pytest

from gcache._internal.envelope import ENVELOPE_VERSION, EnvelopeDecodeError, decode

_VECTORS_PATH = pathlib.Path(__file__).parent.parent / "conformance" / "envelope_vectors.json"
_DATA = json.loads(_VECTORS_PATH.read_text())
_VECTORS = _DATA["vectors"]


def test_the_vector_file_is_where_both_suites_expect_it() -> None:
    # A missing or moved file must fail loudly here rather than making both suites vacuously
    # green by parametrizing over an empty list -- which is exactly how a shared-fixture
    # suite dies quietly.
    assert _VECTORS_PATH.exists(), f"shared vectors missing at {_VECTORS_PATH}"
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


@pytest.mark.parametrize("vector", _VECTORS, ids=lambda v: v["name"])
def test_envelope_vector(vector: dict) -> None:
    raw = vector["envelope"].encode("utf-8")

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
