"""M4 Must: training task control — pause / resume / terminate.

Training runs as a **detached subprocess** (spawned by
`POST /api/v1/rl/train`), so the API process cannot reach into it directly
and does not even retain its `Popen` handle across requests. Control
therefore travels through a small JSON file, mirroring the existing
`status.py` pattern.

Deliberately **not** POSIX signals (`SIGSTOP`/`SIGCONT`): they do not exist
on Windows, and this project develops on Windows.

Design note — **desired state, not an event queue**
-----------------------------------------------
The file records the state the trainer *should be in* (`running` / `paused` /
`terminated`) plus a monotonic `epoch`. Consequences:

- `pause` twice is idempotent — the second call is a no-op, not a queued
  double-pause that would strand the trainer.
- A request made *while* paused (typically `terminate`) is never lost,
  because the trainer re-reads the file rather than consuming a queue.
- `epoch` lets the caller tell "same request, still paused" from "something
  changed", so a polling loop does not re-fire a transition.

Pausing blocks inside the SB3 step callback: the training process simply
stops executing environment steps while holding its model in memory. That
makes `resume` instant and lossless — no checkpoint round-trip, no policy
reload — which a save-and-exit design would require.
"""
from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any, Callable

from . import paths as _paths

STATE_RUNNING = "running"
STATE_PAUSED = "paused"
STATE_TERMINATED = "terminated"

#: API action name -> desired state.
ACTIONS: dict[str, str] = {
    "pause": STATE_PAUSED,
    "resume": STATE_RUNNING,
    "terminate": STATE_TERMINATED,
}

# Default no longer lands in /tmp — on Windows that path is drive-relative,
# which would make the control channel appear on a different drive depending
# on where uvicorn was launched. See paths.py for the full rationale.
_DEFAULT_PATH = _paths.control_file()


def get_control_path() -> Path:
    return _DEFAULT_PATH


def read_control() -> dict[str, Any]:
    """Current desired state.

    A missing, empty or corrupt file reads as ``running`` — a broken control
    channel must never wedge a training run.
    """
    path = get_control_path()
    if not path.exists():
        return {"state": STATE_RUNNING, "epoch": 0, "requested_at_ms": None}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"state": STATE_RUNNING, "epoch": 0, "requested_at_ms": None}
    state = data.get("state")
    if state not in (STATE_RUNNING, STATE_PAUSED, STATE_TERMINATED):
        return {"state": STATE_RUNNING, "epoch": 0, "requested_at_ms": None}
    try:
        epoch = int(data.get("epoch", 0))
    except (TypeError, ValueError):
        epoch = 0
    return {
        "state": state,
        "epoch": epoch,
        "requested_at_ms": data.get("requested_at_ms"),
    }


def _write_atomic(payload: dict[str, Any]) -> None:
    path = get_control_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".control_", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.replace(tmp_path, path)
    except Exception:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


def request(action: str) -> dict[str, Any]:
    """Ask the running trainer to enter `action`'s state.

    Idempotent: the epoch advances on every call, but the resulting *state*
    is whatever the last call asked for.
    """
    if action not in ACTIONS:
        raise ValueError(f"unknown control action: {action!r}")
    current = read_control()
    payload = {
        "state": ACTIONS[action],
        # Monotonic so a stale file can never rewind the trainer's view.
        "epoch": int(current.get("epoch", 0)) + 1,
        "requested_at_ms": int(time.time() * 1000),
        "action": action,
    }
    _write_atomic(payload)
    return payload


def clear_control() -> None:
    """Drop any outstanding request (used when a run starts)."""
    _write_atomic({
        "state": STATE_RUNNING,
        "epoch": int(read_control().get("epoch", 0)) + 1,
        "requested_at_ms": int(time.time() * 1000),
        "action": "clear",
    })


def poll(seen_epoch: int = 0) -> tuple[str, int]:
    """Non-blocking read. Returns ``(state, epoch)``."""
    c = read_control()
    return str(c["state"]), int(c["epoch"])


def wait_while_paused(
    seen_epoch: int,
    *,
    timeout_s: float | None = None,
    poll_interval_s: float = 0.1,
    sleep: Callable[[float], None] = time.sleep,
) -> tuple[str, int]:
    """Block while paused, returning the new ``(state, epoch)`` on exit.

    ``sleep`` is injectable so tests can drive the loop without real time.
    ``timeout_s`` is counted in poll intervals, not wall-clock, so the
    watchdog is deterministic; a slow filesystem stretches the real duration
    slightly, which is acceptable for a safety valve that only exists to
    stop a forgotten pause from hanging the process forever.
    """
    max_polls = (
        max(1, int(timeout_s / poll_interval_s)) if timeout_s is not None else None
    )
    state, epoch = poll(seen_epoch)
    polls = 0
    while state == STATE_PAUSED:
        if max_polls is not None and polls >= max_polls:
            break
        polls += 1
        sleep(poll_interval_s)
        state, epoch = poll(epoch)
    return state, epoch
