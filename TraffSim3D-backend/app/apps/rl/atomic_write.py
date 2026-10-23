"""Atomic JSON writes that survive Windows' file-busy semantics.

`os.replace` maps to `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING` on
Windows, and that fails with ERROR_ACCESS_DENIED while another handle
still has the destination open. The readers here hold the file open for
a few milliseconds at a time — the trainer polls the status and the
control files in a loop, the API reads them between requests — so a
write can lose that race by a hair.

The failure is not cosmetic: a lost status write hides the run, and a
lost control write is a terminate request that never arrives, so the
training process keeps running. The replace is therefore retried for a
bounded window, which turns the race into a short wait.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

#: How many times the replace is attempted before the error is raised.
REPLACE_ATTEMPTS = 12
#: First backoff step; attempt n waits `REPLACE_BACKOFF_S * n` seconds.
REPLACE_BACKOFF_S = 0.02


def replace_with_retry(tmp_path: str, path: Path) -> None:
    """`os.replace`, retried while Windows says the destination is busy."""
    for attempt in range(REPLACE_ATTEMPTS):
        try:
            os.replace(tmp_path, path)
            return
        except PermissionError:
            if attempt == REPLACE_ATTEMPTS - 1:
                raise
            time.sleep(REPLACE_BACKOFF_S * (attempt + 1))


def write_json_atomic(path: Path, payload: dict[str, Any], *, prefix: str) -> None:
    """Write `payload` as JSON, replacing `path` atomically.

    `prefix` names the scratch file, so a reader that lists the
    directory does not mistake it for a real artifact.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=prefix, suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        replace_with_retry(tmp_path, path)
    except Exception:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise
