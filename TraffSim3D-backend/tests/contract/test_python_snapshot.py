"""Cross-language contract test (Python sim ↔ TS sim).

Regenerates the Python-side state trajectories in
`snapshots/python_<name>.json` from `test_vector.json`, so the on-disk
Python artefacts can be refreshed (and inspected) on demand.

The **schema** of those files is owned by
`tests/contract/test_cross_lang_consistency.py`, and this module reuses that
module's writer instead of having its own. Two writers with two schemas was
a real defect: this legacy writer emitted the older shape (no `light`, no
`final_state`, plus a `tolerance` key), and because pytest collects
`test_cross_lang_consistency.py` first (alphabetically), it **overwrote** the
newer, richer files at the end of every session — so the on-disk
"Python-side snapshot" that a reader is most likely to open was missing
exactly the traffic-light bits the contract exists to compare.

The `python_*.json` files are gitignored and read by nobody: the contract
compares Python's *live* output against the committed TS goldens. They are a
debugging convenience, not a gate.
"""

from __future__ import annotations

import json
from pathlib import Path

try:
    # pytest's default ("prepend") import mode puts this directory on
    # `sys.path`, so the sibling module is importable by its bare name.
    from test_cross_lang_consistency import _write_python_snapshot
except ImportError:  # pragma: no cover - alternative import mode
    # `pythonpath = ["."]` in pyproject.toml makes the package path work too.
    from tests.contract.test_cross_lang_consistency import _write_python_snapshot

CONTRACT_DIR = Path(__file__).parent
VECTOR_PATH = CONTRACT_DIR / "test_vector.json"


def test_python_snapshots_match_test_vector() -> None:
    """Refresh the Python-side snapshots from `test_vector.json`.

    The written files carry the same schema as the TS goldens — the light
    bits (`nsGreen` / `ewGreen`) and the `final_state` block included —
    because both sides are produced by the same `_write_python_snapshot`
    helper.
    """
    vec = json.loads(VECTOR_PATH.read_text(encoding="utf-8"))
    sample_every = vec.get("sample_every", 5)
    for v in vec["vectors"]:
        snap = _write_python_snapshot(v, sample_every)
        # Sanity: at least one sample was captured, and it carries the
        # traffic-light bits the contract compares.
        assert len(snap["samples"]) >= 1
        assert "light" in snap["samples"][0]
        assert "final_state" in snap
