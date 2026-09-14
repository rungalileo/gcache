"""Cross-language conformance vectors for the gcache wire protocol.

Shipped as package data, not left in the repo root, so a consumer in ANOTHER repository can
read the same vectors from an installed gcache rather than mirroring them. orbit is that
consumer today: ``libs/go/gcache/tests`` drives the Go client, whose envelope reader has to
agree with this one, and a hand-mirrored copy there would restore exactly the failure mode
this fixture exists to remove -- two suites each passing against their own assumptions.

It is ~6 KB of JSON on every install. That is the cost; the benefit is that "the three clients
agree" becomes a thing a test can check across repository boundaries instead of a claim in a
PR description.

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
