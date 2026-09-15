"""The README's metric label table must match what metrics.py actually declares.

Written because the table had drifted and nothing could notice. It listed `reason` as the
only label on `gcache_degraded_read_counter` (there are four), omitted `layer` from three
histograms and `operation` from one, and asserted in prose that "all metrics include
`use_case` and `key_type`" -- which was false for `gcache_invalidation_counter`, the one
metric that carries neither a use case nor a way to join one.

That class of error is worse than an ordinary stale comment: a PromQL query written against
a label a metric does not have returns an empty result rather than an error, so the dashboard
reads as "no degraded reads" instead of "your query is wrong".
"""

import re
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
_METRIC_ROW = re.compile(r"^\| `(gcache_[a-z_]+)` \| \w+ \| (.+?) \|$", re.M)
_DECL = re.compile(r'name=prefix \+ "([a-z_]+)",\s*labelnames=\[([^\]]*)\]')


def _declared_labels() -> dict[str, list[str]]:
    src = (_ROOT / "src/gcache/_internal/metrics.py").read_text()
    return {
        name: [part.strip().strip('"') for part in labels.split(",") if part.strip()]
        for name, labels in _DECL.findall(src)
    }


def _documented_labels() -> dict[str, list[str]]:
    readme = (_ROOT / "README.md").read_text()
    return {name: re.findall(r"`([a-z_]+)`", cell) for name, cell in _METRIC_ROW.findall(readme)}


def test_every_metric_is_documented() -> None:
    declared, documented = _declared_labels(), _documented_labels()
    assert declared, "no metrics parsed from metrics.py -- the declaration shape changed"
    assert set(declared) == set(documented), (
        f"README metric table and metrics.py disagree on WHICH metrics exist. "
        f"Only in code: {sorted(set(declared) - set(documented))}. "
        f"Only in README: {sorted(set(documented) - set(declared))}."
    )


def test_documented_labels_match_the_declarations() -> None:
    # Order matters as well as membership: the labels are positional at every call site
    # (`.labels(key.use_case, key.key_type, self.layer().name, reason)`), so a reader who
    # trusts a reordered table writes a query whose label values are shifted.
    declared, documented = _declared_labels(), _documented_labels()
    wrong = {n: (declared[n], documented[n]) for n in declared if declared[n] != documented.get(n)}
    assert not wrong, "README label lists disagree with metrics.py: " + "; ".join(
        f"{n}: code={code} readme={doc}" for n, (code, doc) in sorted(wrong.items())
    )


def test_every_reason_value_is_documented() -> None:
    # The `reason` labels are the ones an operator actually has to guess at, and they are
    # string literals scattered across the read path rather than an enum, so nothing but a
    # test like this can keep the list complete.
    readme = (_ROOT / "README.md").read_text()
    redis_cache = (_ROOT / "src/gcache/_internal/redis_cache.py").read_text()
    emitted = set(re.findall(r'_record_degraded_read\([^,]+, "([a-z_]+)"\)', redis_cache))
    emitted |= set(re.findall(r'record_degraded\("([a-z_]+)"\)', redis_cache))
    assert len(emitted) >= 8, f"expected to find the degraded-read reasons, found {sorted(emitted)}"
    undocumented = sorted(r for r in emitted if f"`{r}`" not in readme)
    assert not undocumented, f"degraded-read reasons emitted but not in the README: {undocumented}"

    wrappers = (_ROOT / "src/gcache/_internal/wrappers.py").read_text()
    reasons_block = re.search(r"class DisabledReasons\(Enum\):\n((?:\s+\w+ = \"\w+\"\n)+)", wrappers)
    assert reasons_block, "DisabledReasons enum not found -- its shape changed"
    disabled = set(re.findall(r'(\w+) = "\w+"', reasons_block.group(1)))
    missing = sorted(r for r in disabled if f"`{r}`" not in readme)
    assert not missing, f"DisabledReasons values not in the README: {missing}"
