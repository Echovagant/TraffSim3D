"""Plan 045: PPO model checkpoint management.

Each subprocess gets its own subdirectory (pid-scoped) to avoid filename
collisions when multiple training runs are spawned concurrently. The
default CHECKPOINT_DIR holds all subprocesses' checkpoints; the API
endpoint lists them in mtime-descending order.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

_DEFAULT_DIR = Path(os.environ.get("PPO_CHECKPOINT_DIR", "/tmp/ppo_checkpoints"))
CHECKPOINT_KEEP = 5  # retain the most recent N checkpoints per process


def get_checkpoint_dir() -> Path:
    return _DEFAULT_DIR


def _per_process_dir() -> Path:
    """Each subprocess gets its own subdirectory under the global dir."""
    return _DEFAULT_DIR / f"pid{os.getpid()}"


def save_checkpoint(model: Any, step: int) -> Path:
    """Save PPO model to a per-process subdirectory and prune old ones."""
    pdir = _per_process_dir()
    pdir.mkdir(parents=True, exist_ok=True)
    path = pdir / f"ppo_step_{step:07d}.zip"
    model.save(str(path))
    _prune_old(pdir, CHECKPOINT_KEEP)
    return path


def list_checkpoints() -> list[dict[str, Any]]:
    """List all checkpoints across all per-process subdirs, newest first."""
    if not _DEFAULT_DIR.exists():
        return []
    files: list[Path] = []
    for sub in _DEFAULT_DIR.iterdir():
        if sub.is_dir():
            files.extend(sub.glob("ppo_step_*.zip"))
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return [
        {
            "name": p.name,
            "process": p.parent.name,  # 'pid12345'
            "size_kb": round(p.stat().st_size / 1024, 1),
            "mtime_ms": int(p.stat().st_mtime * 1000),
        }
        for p in files
    ]


def prune_all_checkpoints(keep_total: int = CHECKPOINT_KEEP) -> int:
    """Delete old checkpoints across all processes, keeping the newest
    `keep_total` overall. Returns number of files deleted."""
    if not _DEFAULT_DIR.exists():
        return 0
    files: list[Path] = []
    for sub in _DEFAULT_DIR.iterdir():
        if sub.is_dir():
            files.extend(sub.glob("ppo_step_*.zip"))
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    deleted = 0
    for p in files[keep_total:]:
        try:
            p.unlink()
            deleted += 1
        except OSError:
            pass
    return deleted


def _prune_old(pdir: Path, keep: int) -> int:
    """Within a per-process dir, keep the newest N checkpoints."""
    if not pdir.exists():
        return 0
    files = sorted(pdir.glob("ppo_step_*.zip"),
                   key=lambda p: p.stat().st_mtime, reverse=True)
    deleted = 0
    for p in files[keep:]:
        try:
            p.unlink()
            deleted += 1
        except OSError:
            pass
    return deleted