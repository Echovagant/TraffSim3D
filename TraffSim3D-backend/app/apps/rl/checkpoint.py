"""PPO model checkpoint management.

Each subprocess gets its own subdirectory (pid-scoped) to avoid filename
collisions when multiple training runs are spawned concurrently. The
default CHECKPOINT_DIR holds all subprocesses' checkpoints; the API
endpoint lists them in mtime-descending order.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from . import paths as _paths

# Default no longer lands in /tmp — on Windows that path is drive-relative and
# silently split checkpoints across drives. See paths.py for the rationale.
_DEFAULT_DIR = _paths.checkpoints_dir()
CHECKPOINT_KEEP = 5  # retain the most recent N checkpoints per process


def get_checkpoint_dir() -> Path:
    return _DEFAULT_DIR


def _per_process_dir() -> Path:
    """Each subprocess gets its own subdirectory under the global dir."""
    return _DEFAULT_DIR / f"pid{os.getpid()}"


def save_checkpoint(
    model: Any,
    step: int,
    agent_id: int | None = None,
) -> Path:
    """Save PPO model to a per-process subdirectory and prune old ones.

    If `agent_id` is provided (true multi-agent), the filename
    includes `agent{id}` so per-agent checkpoints don't collide.
    """
    pdir = _per_process_dir()
    pdir.mkdir(parents=True, exist_ok=True)
    name = (
        f"ppo_agent{agent_id}_step_{step:07d}.zip"
        if agent_id is not None
        else f"ppo_step_{step:07d}.zip"
    )
    path = pdir / name
    model.save(str(path))
    _prune_old(pdir, CHECKPOINT_KEEP)
    return path


def save_named_checkpoint(model: Any, name: str) -> Path:
    """Save a checkpoint under an explicit file name.

    `save_checkpoint` names the file after the training step, so two
    runs that save at the same step overwrite each other. A multi-seed
    run keeps one policy per seed and the name has to
    say which seed it belongs to — e.g.
    `signal_seed0_step_0210000.zip`.

    The file lands in the same per-process directory as the regular
    checkpoints. It is deliberately NOT matched by the `ppo_step_*`
    pattern the checkpoint list reads, so a per-seed file never shows
    up there as if it were the run's deliverable.
    """
    if not name.endswith(".zip") or "/" in name or "\\" in name or name.startswith("."):
        raise ValueError(f"invalid checkpoint name {name!r}")
    pdir = _per_process_dir()
    pdir.mkdir(parents=True, exist_ok=True)
    path = pdir / name
    model.save(str(path))
    return path


def list_checkpoints() -> list[dict[str, Any]]:
    """List all checkpoints across all per-process subdirs, newest first.

    Each entry includes `agent_id` (parsed from filename; null for
    shared-policy checkpoints): ppo_agent0_step_*.zip → 0,
    ppo_step_*.zip → None.
    """
    import re

    pattern = re.compile(r"^ppo(?:_agent(\d+))?_step_\d+\.zip$")
    if not _DEFAULT_DIR.exists():
        return []
    files: list[Path] = []
    for sub in _DEFAULT_DIR.iterdir():
        if sub.is_dir():
            for p in sub.iterdir():
                if pattern.match(p.name):
                    files.append(p)
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    out: list[dict[str, Any]] = []
    for p in files:
        m = pattern.match(p.name)
        agent_id: int | None = int(m.group(1)) if (m and m.group(1)) else None
        out.append(
            {
                "name": p.name,
                "process": p.parent.name,
                "agent_id": agent_id,
                "size_kb": round(p.stat().st_size / 1024, 1),
                "mtime_ms": int(p.stat().st_mtime * 1000),
            }
        )
    return out


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
    files = sorted(pdir.glob("ppo_step_*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)
    deleted = 0
    for p in files[keep:]:
        try:
            p.unlink()
            deleted += 1
        except OSError:
            pass
    return deleted
