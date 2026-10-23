"""PPO model checkpoint management.

Each subprocess gets its own subdirectory (pid-scoped) to avoid filename
collisions when multiple training runs are spawned concurrently. The
default CHECKPOINT_DIR holds all subprocesses' checkpoints; the API
endpoint lists them in mtime-descending order.
"""

from __future__ import annotations

import os
import re
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


def _newest_first(p: Path) -> tuple[float, int, str]:
    """Sort key: newest first, with a deterministic tie-break.

    Several checkpoints can share an mtime — the timestamp resolution
    is coarse enough that files written in the same millisecond tie —
    and a stable sort would then keep the *oldest* of the tied files.
    The step number in the name breaks the tie the way the timestamps
    would have.
    """
    m = re.search(r"step_(\d+)\.zip$", p.name)
    step = int(m.group(1)) if m else -1
    return (p.stat().st_mtime, step, p.name)


def list_checkpoints() -> list[dict[str, Any]]:
    """List all checkpoints across all per-process subdirs, newest first.

    Each entry includes `agent_id` (parsed from filename; null for
    shared-policy checkpoints): ppo_agent0_step_*.zip → 0,
    ppo_step_*.zip → None.

    Two families of checkpoint live side by side, and the API has to tell
    them apart — the ego agent drives (continuous, two actions) while the
    signal agent commands the traffic light (discrete, five actions). The
    browser rejects a checkpoint whose action space does not match the
    policy it is loaded into, so the listing says which is which:

    - `ppo_step_*.zip` / `ppo_agent<N>_step_*.zip` → `policy_kind = "ego"`
    - `signal_seed<N>_step_*.zip` → `policy_kind = "signal"`

    The signal family used to be invisible here: the listing's pattern
    matched only the ego names, so the API never offered a signal
    checkpoint and the UI's signal-policy picker could only ever list
    ego policies — which the loader then rejects, because an ego policy
    is continuous and a signal policy must be discrete.
    """
    pattern = re.compile(r"^ppo(?:_agent(\d+))?_step_\d+\.zip$")
    signal_pattern = re.compile(r"^signal_seed\d+_step_\d+\.zip$")
    if not _DEFAULT_DIR.exists():
        return []
    files: list[Path] = []
    for sub in _DEFAULT_DIR.iterdir():
        if sub.is_dir():
            for p in sub.iterdir():
                if pattern.match(p.name) or signal_pattern.match(p.name):
                    files.append(p)
    files.sort(key=_newest_first, reverse=True)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for p in files:
        # The same checkpoint name can live in more than one directory (a
        # run's own pid-scoped dir and a curated one). The API addresses a
        # checkpoint by **name**, so a duplicate would show up twice in the
        # picker and could resolve to either copy. Keep the newest of each
        # name — the files are sorted newest-first, so the first one wins.
        if p.name in seen:
            continue
        seen.add(p.name)
        m = pattern.match(p.name)
        agent_id: int | None = int(m.group(1)) if (m and m.group(1)) else None
        out.append(
            {
                "name": p.name,
                "process": p.parent.name,
                "agent_id": agent_id,
                # "ego" | "signal" — the agent the checkpoint belongs to.
                # The frontend uses it to fill the right picker.
                "policy_kind": "signal" if signal_pattern.match(p.name) else "ego",
                "size_kb": round(p.stat().st_size / 1024, 1),
                "mtime_ms": int(p.stat().st_mtime * 1000),
            }
        )
    return out


def prune_all_checkpoints(keep_total: int = CHECKPOINT_KEEP) -> int:
    """Delete old checkpoints across all processes, keeping the newest
    `keep_total` overall. Returns number of files deleted.

    Both checkpoint families are pruned: the ego policies
    (`ppo_step_*.zip`) and the signal policies (`signal_seed*_step_*.zip`).
    The signal family was previously missed, so a long-running signal
    training session accumulated its checkpoints without limit.
    """
    if not _DEFAULT_DIR.exists():
        return 0
    files: list[Path] = []
    for sub in _DEFAULT_DIR.iterdir():
        if sub.is_dir():
            files.extend(sub.glob("ppo_step_*.zip"))
            files.extend(sub.glob("signal_seed*_step_*.zip"))
    files.sort(key=_newest_first, reverse=True)
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
    files = sorted(pdir.glob("ppo_step_*.zip"), key=_newest_first, reverse=True)
    deleted = 0
    for p in files[keep:]:
        try:
            p.unlink()
            deleted += 1
        except OSError:
            pass
    return deleted
