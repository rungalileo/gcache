"""Cross-language conformance vectors for the gcache wire protocol.

Read by all three implementations in this repo -- ``tests/test_conformance.py``,
``packages/gcache-ts/test/gcache-conformance.test.ts`` and ``go/conformance_test.go`` -- and
shipped as package data so a consumer in ANOTHER repository can read the same vectors from an
installed gcache rather than mirroring them.

The package-data decision predates the Go client living here. It was made when orbit held the
Go implementation and the only way to check three-way agreement was across a repo boundary --
which turned out not to work: five cross-language claims went silently false in one afternoon,
because a comment in one repo asserting another repo's behaviour is not something any test can
execute. The Go client now lives in ``go/`` and reads this file directly.

The shipping stays useful anyway, for two reasons. A downstream service embedding gcache can
assert its own payloads against the same corpus, and ``vectors_path()`` still exists for a
non-Python consumer that needs a real file. It is ~6 KB of JSON on every install.

Usage from another repo::

    from gcache.conformance import load_vectors

    data = load_vectors()          # dict: envelopeVersion, vectors, keyRendering
    for v in data["vectors"]:
        ...
"""

import json
from functools import lru_cache
from importlib import resources
from typing import Any

__all__ = ["VECTORS_FILENAME", "load_vectors", "vectors_path"]

VECTORS_FILENAME = "envelope_vectors.json"


@lru_cache(maxsize=1)
def load_vectors() -> dict[str, Any]:
    """Return the parsed conformance vectors.

    Read through importlib.resources rather than a filesystem path so it works from a wheel,
    a zipapp, and an editable install alike -- a consumer computing a path relative to
    ``gcache.__file__`` breaks on the first of those.
    """
    text = resources.files(__package__).joinpath(VECTORS_FILENAME).read_text(encoding="utf-8")
    parsed: dict[str, Any] = json.loads(text)
    return parsed


def vectors_path() -> str:
    """Filesystem path to the vectors, for a consumer that must shell out to another language.

    Prefer :func:`load_vectors`. This exists because the Go half of the conformance suite is
    a separate binary that takes a file argument, and it cannot be handed a zip-internal
    resource.
    """
    with resources.as_file(resources.files(__package__).joinpath(VECTORS_FILENAME)) as p:
        return str(p)
