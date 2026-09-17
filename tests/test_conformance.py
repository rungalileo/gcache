"""Python half of the shared cross-language envelope conformance suite.

Both this file and ``go/conformance_test.go`` read the same ``envelope_vectors.json``,
so a divergence fails a test here instead of escaping to review as it did twice before.
"""

import base64
import json
import pathlib
from typing import Any

import pytest

from gcache._internal.envelope import ENVELOPE_VERSION, EnvelopeDecodeError, decode
from gcache.conformance import load_vectors, vectors_path

# Read through the package accessor, not a repo-relative path -- TS and Go read it by
# relative path, so this is the only thing that exercises the packaged form (a missing
# poetry include would otherwise surface downstream instead of here).
_DATA = load_vectors()
_VECTORS = _DATA["vectors"]


def test_the_vector_file_is_where_every_suite_expects_it() -> None:
    # A missing or moved file must fail loudly here rather than making the suites vacuously
    # green by parametrizing over an empty list -- which is exactly how a shared-fixture
    # suite dies quietly.
    assert pathlib.Path(vectors_path()).exists(), f"shared vectors missing at {vectors_path()}"
    # EXACT, not a floor: a floor of 14 let two vectors disappear from 16 with every guard
    # still green. Count lives in the fixture, so adding a vector is one edit that both
    # suites check.
    assert len(_VECTORS) == _DATA["vectorCount"], (
        f"fixture declares vectorCount={_DATA['vectorCount']} but carries {len(_VECTORS)} vectors"
    )
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

        # Checked HERE, unconditionally -- inside the per-vector accept/reject branch, a
        # vector whose rejectedBy names THIS client could skip past it, and with no
        # asymmetry vectors currently in the file, that branch never ran at all.
        if "rejectedBy" in v or "acceptedBy" in v:
            assert v.get("rejectedBy"), f"{v['name']}: acceptedBy without rejectedBy"
            assert v.get("acceptedBy"), f"{v['name']}: rejectedBy without acceptedBy"
            assert v.get("asymmetryIsSafe"), f"{v['name']}: an asymmetry must justify its direction"
            assert v["expect"] == "reject", f"{v['name']}: an asymmetry is expressed on a reject vector"
            overlap = set(v["rejectedBy"]) & set(v["acceptedBy"])
            assert not overlap, f"{v['name']}: a client cannot both accept and reject: {overlap}"
            known = {"python", "go"}
            unknown = (set(v["rejectedBy"]) | set(v["acceptedBy"])) - known
            assert not unknown, f"{v['name']}: unknown client(s) {unknown}"


def _applies_to_python(vector: dict) -> bool:
    """Whether this vector's stated expectation is Python's.

    A few vectors record a DELIBERATE asymmetry -- one client can't represent the value
    faithfully, so it rejects rather than serving the same bytes as a different number.
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
    # executed; the Go half is a recorded literal that its own suite checks.
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

            # Partition must match what the recorded strings say, not a `agree: bool` --
            # a partition survives a client being added or removed; a boolean would not.
            actual: dict[str, list[str]] = {}
            for client in ("go", "python"):
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
    # Asserts real behaviour, not `inspect.getsource(GCache.__init__)` for the raise -- a
    # source-text check stays green even if the CONDITION changes. Reachable because
    # GCache.__init__ validates config BEFORE the singleton check the conftest fixture holds.
    from gcache import GCache, GCacheConfig
    from gcache.exceptions import EmptyUrnPrefixNotSupported
    from tests.conftest import FakeCacheConfigProvider

    # Both clients render an empty prefix identically, so the vector records agreement -- but
    # it is still refused at construction, because it writes into a key space no namespaced
    # deployment reads. The rendering is reachable only below the public API.
    case = next(c for c in _DATA["keyRendering"]["cases"] if c["name"] == "empty-prefix")
    assert case["agreeingClients"] == [["go", "python"]]

    with pytest.raises(EmptyUrnPrefixNotSupported):
        GCache(GCacheConfig(cache_config_provider=FakeCacheConfigProvider(), urn_prefix=""))

    # It must beat GCacheAlreadyInstantiated, which is what the ordering above buys: the
    # caller learns their config is invalid rather than that another instance exists.
    from gcache.exceptions import GCacheAlreadyInstantiated

    assert not issubclass(EmptyUrnPrefixNotSupported, GCacheAlreadyInstantiated)
    # And it is a ValueError, so an existing construction guard still catches it.
    assert issubclass(EmptyUrnPrefixNotSupported, ValueError)


def test_the_watermark_and_envelope_parsers_really_do_differ() -> None:
    # Vector file records this asymmetry with measured values: json.loads keeps exact ints
    # at any magnitude, float() rounds above 2^53. Go reaches both fields via float64, so
    # tightening the watermark would diverge from Go, not converge.
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
    # Args sort by name in both clients, so caller order cannot change the key. Exists
    # because keyRendering's cases carry no args, so Go sorted while Python's constructor
    # didn't, and every suite stayed green.
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
            for client in ("go", "python"):
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
    # 'already-alpha' renders the same sorted or unsorted, so an all-alphabetical corpus
    # can't detect a client that stops sorting -- how the Go/Python split survived. At
    # least one case must differ from its own input-order rendering.
    def input_order_rendering(case: dict[str, Any]) -> str:
        body = "&".join(f"{name}={value}" for name, value in case["args"])
        return f"{case['urnPrefix']}:{case['keyType']}:{case['id']}?{body}#{case['useCase']}"

    cases = _DATA["argOrdering"]["cases"]
    discriminating = [c for c in cases if c["python"] != input_order_rendering(c)]
    assert discriminating, (
        "every argOrdering case renders the same sorted or unsorted, so this corpus cannot "
        "detect a client that stopped sorting -- add a case whose args are not alphabetical"
    )


def test_hashed_components_match_the_shared_digests() -> None:
    # Go asserts the same cases. A digest the two clients disagree on makes a hashed component
    # unfindable by the other language -- a cache that writes fine and never hits, with no
    # error on either side, which is the failure this corpus exists to catch.
    from gcache import hash_component

    section = _DATA["hashedComponents"]
    assert section["algorithm"] == "sha256"
    assert section["encoding"] == "hex-lower"
    assert section["cases"], "the hashed-component cases are gone"

    for case in section["cases"]:
        actual = hash_component(case["input"])
        assert actual == case["digest"], f"{case['input'][:40]!r}: {actual} != {case['digest']}"
        assert actual == actual.lower() and len(actual) == 64, "lowercase hex, fixed width"


def test_an_unhashable_component_raises_rather_than_substituting() -> None:
    # Deliberately absent from the corpus: Python cannot encode a lone surrogate and Go hashes
    # whatever bytes it holds, so there is no agreed digest. Raising is the two clients
    # declining to disagree -- returning a digest over some substitute would put them in
    # different key spaces silently.
    import pytest

    from gcache import hash_component
    from gcache.exceptions import GCacheError, UnhashableKeyComponent

    with pytest.raises(UnhashableKeyComponent):
        hash_component("conv-\ud800-42")
    # Catchable the way every other gcache failure is.
    assert issubclass(UnhashableKeyComponent, GCacheError)
    assert issubclass(UnhashableKeyComponent, ValueError)


def test_the_proto_envelope_matches_the_shared_bytes() -> None:
    # Go asserts this same section. The PROTO framing is hand-written in both clients, so
    # nothing but these bytes stops them drifting -- and a drift is silent: one client writes
    # an entry the other cannot read, with no error on the write side.
    import base64

    from gcache._internal.envelope import decode, encode_proto

    section = _DATA["protoEnvelope"]
    c = section["canonical"]
    payload = base64.b64decode(c["payloadBase64"])
    expected = base64.b64decode(c["envelopeBase64"])

    ttl_sec = (c["expiresAtMs"] - c["createdAtMs"]) // 1000
    actual = encode_proto(created_at_ms=c["createdAtMs"], ttl_sec=ttl_sec, payload=payload)
    assert actual == expected, f"{actual.hex()} != {expected.hex()}"
    assert len(actual) == c["envelopeLength"]

    decoded = decode(expected, allow_pickle=False)
    assert decoded.created_at_ms == c["createdAtMs"]
    assert decoded.expires_at_ms == c["expiresAtMs"]
    assert decoded.payload == payload


def test_the_proto_first_byte_range_is_disjoint_from_the_other_framings() -> None:
    # The whole reason the framing needs no magic prefix. Asserted over the RANGE rather than
    # one example, because the guarantee is about every field the schema may ever use: a tag
    # byte is (field << 3) | wire_type, and the range only holds while fields stay <= 14.
    section = _DATA["protoEnvelope"]
    lo, hi = section["firstByteRange"]["min"], section["firstByteRange"]["max"]
    others = section["otherFramings"]

    assert not lo <= others["json"] <= hi, "JSON's '{' must not fall inside the PROTO range"
    assert not lo <= others["pickle"] <= hi, "pickle's 0x80 must not fall inside the PROTO range"

    # Every tag byte a conforming envelope can start with, for any field 1-14 and any proto3
    # wire type, lands in the range.
    for field in range(1, 15):
        for wire in (0, 1, 2, 5):
            assert lo <= (field << 3) | wire <= hi, f"field {field} wire {wire} escapes the range"
    # And field 16 with a varint is exactly pickle's marker -- the reason for the cap.
    assert (16 << 3) | 0 == others["pickle"]


@pytest.mark.parametrize("case", _DATA["protoEnvelope"]["rejects"], ids=lambda c: c["name"])
def test_the_proto_envelope_rejects_what_go_rejects(case: dict) -> None:
    # Each of these is a value no gcache client writes. Accepting one means answering a hit
    # with data the other client would refuse.
    import base64

    from gcache._internal.envelope import EnvelopeDecodeError, decode

    with pytest.raises(EnvelopeDecodeError):
        decode(base64.b64decode(case["envelopeBase64"]), allow_pickle=False)
