"""Training status persistence (status.json)."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

# Default status file — overridable via env var for tests.
from . import atomic_write
from . import paths as _paths

# Default no longer lands in /tmp — on Windows that path is drive-relative.
# See paths.py for the rationale.
_DEFAULT_PATH = _paths.status_file()


def get_status_path() -> Path:
    return _DEFAULT_PATH


def read_status() -> dict[str, Any]:
    """Return current training status. Empty dict if no training has run."""
    path = get_status_path()
    if not path.exists():
        return {}
    try:
        result: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
        return result
    except (json.JSONDecodeError, OSError):
        return {}


def write_status(d: dict[str, Any]) -> None:
    """Atomic write — write to tmp file then rename.

    The rename is retried while Windows reports the destination as
    busy: the trainer polls this file in a loop, so a write could
    otherwise lose the race and raise — and a raised write means the
    run stops reporting its own progress.
    """
    atomic_write.write_json_atomic(get_status_path(), d, prefix=".status_")


def init_status(total_steps: int) -> None:
    """Initialize status.json at the start of a training run."""
    write_status(
        {
            "running": True,
            "paused": False,
            "step": 0,
            "total_steps": total_steps,
            "episode_count": 0,
            "last_reward": 0.0,
            "reward_history": [],
            "started_at_ms": int(time.time() * 1000),
            "finished_at_ms": None,
            "reason": "",
        }
    )


def append_reward(reward: float, max_history: int = 200) -> None:
    """Append an episode reward to the history (bounded)."""
    s = read_status()
    history = s.get("reward_history", [])
    history.append(float(reward))
    if len(history) > max_history:
        history = history[-max_history:]
    s["reward_history"] = history
    s["last_reward"] = float(reward)
    s["step"] = int(s.get("step", 0)) + 1
    s["episode_count"] = int(s.get("episode_count", 0)) + 1
    write_status(s)


def set_paused(paused: bool) -> None:
    """Flag a live run as paused/resumed (task control)."""
    s = read_status()
    s["paused"] = bool(paused)
    write_status(s)


def finalize_status(reason: str = "completed") -> None:
    s = read_status()
    s["running"] = False
    s["paused"] = False
    s["finished_at_ms"] = int(time.time() * 1000)
    s["reason"] = reason
    write_status(s)
