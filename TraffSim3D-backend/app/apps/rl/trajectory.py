"""Trajectory logging for RL training data collection.

Captures per-step vehicle state during RL training episodes and writes
to CSV files for offline RL datasets or post-hoc analysis.

Storage layout:
    <backend root>/.data/trajectories/
      pid{pid}/
        manifest.json
        episode_000000.csv
        episode_000001.csv

Where the output lands is decided by `app/apps/rl/paths.py`, the same module
that owns the checkpoint / status / control paths. The previous default was
`%TEMP%/traffsim_trajectories` on Windows and `/tmp/traffsim_trajectories` on
POSIX — a directory that is wiped on reboot, lives outside the repo, and on
Windows is not even stable across accounts. `paths.py` explains the `/tmp`
drive-relative trap in full.
"""

from __future__ import annotations

import csv
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import paths as _paths


def default_trajectory_dir() -> Path:
    """Resolve the trajectory output directory.

    Resolved lazily (not at import time) so `TRAFFIC_RL_DATA_DIR` and
    `TRAFFSIM_TRAJECTORY_DIR` overrides apply to a running process, and so
    importing this module never creates a directory on disk.
    """
    return _paths.trajectories_dir()


CSV_HEADER = [
    "episode_id",
    "step",
    "sim_time",
    "vehicle_id",
    "is_ego",
    "x",
    "z",
    "heading",
    "speed",
    "action_accel",
    "reward",
    "terminated",
    "truncated",
    "info_reason",
]


@dataclass
class TrajectoryRow:
    """Single trajectory sample for one vehicle at one timestep."""

    episode_id: int
    step: int
    sim_time: float
    vehicle_id: str
    is_ego: bool
    x: float
    z: float
    heading: float
    speed: float
    action_accel: float
    reward: float
    terminated: bool
    truncated: bool
    info_reason: str

    def to_csv_row(self) -> list:
        return [
            self.episode_id,
            self.step,
            f"{self.sim_time:.3f}",
            self.vehicle_id,
            self.is_ego,
            f"{self.x:.3f}",
            f"{self.z:.3f}",
            f"{self.heading:.4f}",
            f"{self.speed:.3f}",
            f"{self.action_accel:.3f}",
            f"{self.reward:.4f}",
            self.terminated,
            self.truncated,
            self.info_reason,
        ]


class TrajectoryLogger:
    """Buffers and writes per-episode trajectory CSVs."""

    def __init__(
        self,
        base_dir: Path | None = None,
        flush_every: int = 50,
    ) -> None:
        self._base_dir = base_dir or default_trajectory_dir()
        self._flush_every = flush_every
        self._pid_dir = self._base_dir / f"pid{os.getpid()}"
        self._pid_dir.mkdir(parents=True, exist_ok=True)

        self._episode_id = 0
        self._step_count = 0
        self._sim_time = 0.0
        self._buffer: list[TrajectoryRow] = []
        self._file = None
        self._writer = None
        self._scene_kind = ""
        self._total_episodes = 0
        self._total_rows = 0

    def start_episode(self, scene_kind: str, seed: int | None) -> None:
        """Open a new CSV file for the next episode."""
        self._scene_kind = scene_kind
        self._step_count = 0
        self._sim_time = 0.0
        self._buffer = []

        filename = self._pid_dir / f"episode_{self._episode_id:06d}.csv"
        self._file = open(filename, "w", newline="")
        self._writer = csv.writer(self._file)
        self._writer.writerow(CSV_HEADER)

    def record_step(
        self,
        core: Any,
        action: Any,
        reward: float,
        terminated: bool,
        truncated: bool,
        info: dict,
    ) -> None:
        """Write one row per vehicle (ego + NPCs) from the current sim state."""
        if self._writer is None:
            return

        action_accel = float(action[0]) if hasattr(action, "__len__") else 0.0
        info_reason = info.get("reason", "")

        # Ego vehicle
        self._buffer.append(
            TrajectoryRow(
                episode_id=self._episode_id,
                step=self._step_count,
                sim_time=self._sim_time,
                vehicle_id="ego",
                is_ego=True,
                x=core.ego.x,
                z=core.ego.z,
                heading=core.ego.heading,
                speed=core.ego.speed,
                action_accel=action_accel,
                reward=reward,
                terminated=terminated,
                truncated=truncated,
                info_reason=info_reason,
            )
        )

        # NPC vehicles
        for i, npc in enumerate(core.npcs):
            self._buffer.append(
                TrajectoryRow(
                    episode_id=self._episode_id,
                    step=self._step_count,
                    sim_time=self._sim_time,
                    vehicle_id=f"npc_{i}",
                    is_ego=False,
                    x=npc.x,
                    z=npc.z,
                    heading=npc.heading,
                    speed=npc.speed,
                    action_accel=0.0,
                    reward=0.0,
                    terminated=terminated,
                    truncated=truncated,
                    info_reason=info_reason,
                )
            )

        self._step_count += 1
        self._sim_time += 0.1  # DT = 0.1

        # Flush buffer periodically
        if len(self._buffer) >= self._flush_every * (1 + len(core.npcs)):
            self._flush_buffer()

    def _flush_buffer(self) -> None:
        """Write buffered rows to disk."""
        if self._writer is None or not self._buffer:
            return
        for row in self._buffer:
            self._writer.writerow(row.to_csv_row())
        self._file.flush()
        self._total_rows += len(self._buffer)
        self._buffer = []

    def end_episode(self) -> None:
        """Flush buffer, close file, update manifest."""
        self._flush_buffer()
        if self._file is not None:
            self._file.close()
            self._file = None
            self._writer = None

        self._total_episodes += 1
        self._episode_id += 1
        self._update_manifest()

    def _update_manifest(self) -> None:
        """Write manifest.json with episode metadata."""
        manifest = {
            "total_episodes": self._total_episodes,
            "total_rows": self._total_rows,
            "scene_kind": self._scene_kind,
            "pid": os.getpid(),
        }
        manifest_path = self._pid_dir / "manifest.json"
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2)

    def close(self) -> None:
        """Final flush (safety net)."""
        self._flush_buffer()
        if self._file is not None:
            self._file.close()
            self._file = None


def list_trajectories(base_dir: Path | None = None) -> list[dict[str, Any]]:
    """List all trajectory files across per-process dirs."""
    base = base_dir or default_trajectory_dir()
    if not base.exists():
        return []

    results = []
    for pid_dir in base.iterdir():
        if not pid_dir.is_dir() or not pid_dir.name.startswith("pid"):
            continue
        manifest_path = pid_dir / "manifest.json"
        manifest = {}
        if manifest_path.exists():
            with open(manifest_path) as f:
                manifest = json.load(f)

        for csv_file in sorted(pid_dir.glob("episode_*.csv")):
            results.append(
                {
                    "filename": csv_file.name,
                    "pid_dir": pid_dir.name,
                    "size_kb": round(csv_file.stat().st_size / 1024, 1),
                    "mtime_ms": int(csv_file.stat().st_mtime * 1000),
                    **manifest,
                }
            )
    return results


def prune_trajectories(base_dir: Path | None = None, keep: int = 20) -> int:
    """Delete old trajectory files, keeping newest `keep`."""
    base = base_dir or default_trajectory_dir()
    if not base.exists():
        return 0

    all_files = []
    for pid_dir in base.iterdir():
        if not pid_dir.is_dir() or not pid_dir.name.startswith("pid"):
            continue
        for csv_file in pid_dir.glob("episode_*.csv"):
            all_files.append(csv_file)

    if len(all_files) <= keep:
        return 0

    # Sort by mtime, oldest first
    all_files.sort(key=lambda f: f.stat().st_mtime)
    to_delete = all_files[: len(all_files) - keep]

    for f in to_delete:
        f.unlink()

    return len(to_delete)


def get_trajectory_path(filename: str, base_dir: Path | None = None) -> Path | None:
    """Find a trajectory file by filename across all pid dirs."""
    base = base_dir or default_trajectory_dir()
    if not base.exists():
        return None

    for pid_dir in base.iterdir():
        if not pid_dir.is_dir() or not pid_dir.name.startswith("pid"):
            continue
        candidate = pid_dir / filename
        if candidate.exists():
            return candidate
    return None
