"""Training status persistence (`app/apps/rl/status.py`).

The status file is written while the trainer polls it, and the API
reads it between requests. On Windows that means the write can lose
a file-busy race — and a raised write is a run that stops reporting
its own progress.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

import pytest

from app.apps.rl import status as rl_status


@pytest.fixture
def status_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the status file at an isolated path."""
    path = tmp_path / "training_status.json"
    monkeypatch.setattr(rl_status, "_DEFAULT_PATH", path)
    return path


@pytest.mark.skipif(os.name != "nt", reason="Windows file locking only")
def test_write_status_survives_a_busy_destination(status_file: Path) -> None:
    """A status write must wait for a reader instead of raising.

    `os.replace` fails with ERROR_ACCESS_DENIED while another handle
    has the destination open. The trainer polls the status file in a
    tight loop, so the write has to retry rather than lose the update.
    """
    status_file.write_text('{"running": true}', encoding="utf-8")

    handle = open(status_file, encoding="utf-8")
    holder = threading.Timer(0.25, handle.close)
    holder.start()
    try:
        started = time.monotonic()
        rl_status.write_status({"running": False, "step": 7})
        waited = time.monotonic() - started
    finally:
        holder.cancel()
        handle.close()

    # The wait is the point: a write that did not have to wait proves
    # nothing about the race.
    assert waited >= 0.2
    assert json.loads(status_file.read_text(encoding="utf-8"))["step"] == 7
