"""Session-wide pytest setup.

Keeps the scratch files on the project's own drive.

`tempfile.gettempdir()` resolves to the OS temp directory, which on
Windows is `%LOCALAPPDATA%\\Temp` — normally the system drive. This
project keeps its runtime data under `TraffSim3D-backend/.data/`
(already gitignored) for exactly that reason, so the test suite points
`tempfile` at the same place: pytest's `tmp_path` factories and every
`tempfile.*` call inside the suite then land there too.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

_SCRATCH = Path(__file__).resolve().parent / ".data" / "pytest-tmp"


def pytest_configure(config: pytest.Config) -> None:
    """Redirect `tempfile` before pytest creates its base temp directory."""
    _SCRATCH.mkdir(parents=True, exist_ok=True)
    tempfile.tempdir = str(_SCRATCH)
