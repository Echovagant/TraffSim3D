"""Runtime state paths for the RL engine.

Why this module exists — `/tmp` is a trap on this project's platform
--------------------------------------------------------------------------------
The engine used to default all three of its runtime paths to `/tmp`:

    checkpoint.py  PPO_CHECKPOINT_DIR      /tmp/ppo_checkpoints
    status.py      TRAFFIC_PPO_STATUS      /tmp/traffic_ppo_status.json
    control.py     TRAFFIC_PPO_CONTROL     /tmp/traffic_ppo_control.json

On Windows, `Path("/tmp/x")` is **not absolute** — `is_absolute()` is False,
and it resolves against the *current working directory's drive*. Verified:

    >>> Path('/tmp/ppo_checkpoints').is_absolute()
    False
    >>> Path('/tmp/ppo_checkpoints').resolve()   # launched from D:
    WindowsPath('D:/tmp/ppo_checkpoints')

So the same code silently wrote to `D:\\tmp\\` when launched from this project
on D:, and to `C:\\tmp\\` when launched from a C: location — which is exactly
where the six orphaned `C:\\tmp\\ppo_checkpoints\\pid*` directories came from.
Checkpoints split across drives with no discoverable home, and `GET /rl/checkpoints`
only ever saw whichever drive the process happened to be on.

On POSIX, `/tmp` is conventionally wiped on reboot, which would additionally
destroy every trained model.

Default: `<backend root>/.data/<name>`
--------------------------------------------------------------------------------
Anchored to this package's own location, **not** the cwd — so the path is the
same no matter which directory uvicorn was started from, on any drive, on any
platform. It lives inside the repo so it is obvious where the artifacts went.

Override precedence (most specific wins):

    TRAFFIC_RL_DATA_DIR   → moves all three at once
    PPO_CHECKPOINT_DIR    → checkpoints only
    TRAFFIC_PPO_STATUS    → status file only
    TRAFFIC_PPO_CONTROL   → control channel only

Note on containers: this fixes the drive-splitting and POSIX-reboot-wipe
problems, but durability across *container recreation* still requires the
deployment to mount a volume — that is ADR-007 (Docker Compose, still
Proposed), not something a path default can solve.
"""
from __future__ import annotations

import os
from pathlib import Path

# app/apps/rl/paths.py → parents[3] == TraffSim3D-backend/
_BACKEND_ROOT = Path(__file__).resolve().parents[3]


def data_root() -> Path:
    """Base directory for all RL runtime state. Created on demand."""
    root = Path(os.environ.get("TRAFFIC_RL_DATA_DIR", _BACKEND_ROOT / ".data"))
    root.mkdir(parents=True, exist_ok=True)
    return root


def checkpoints_dir() -> Path:
    """Where PPO checkpoints are written (per-process subdirectories)."""
    return Path(os.environ.get("PPO_CHECKPOINT_DIR") or data_root() / "ppo_checkpoints")


def status_file() -> Path:
    """Training progress JSON shared between the API and the trainer."""
    return Path(os.environ.get("TRAFFIC_PPO_STATUS") or data_root() / "training_status.json")


def control_file() -> Path:
    """pause / resume / terminate requests the trainer polls."""
    return Path(os.environ.get("TRAFFIC_PPO_CONTROL") or data_root() / "training_control.json")
