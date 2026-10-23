"""Behavioural tests for the trajectory logger.

The logger writes one CSV row per vehicle per simulation step. Two things
matter beyond "it writes a file":

* the CSVs must be **readable back** with the documented header, so a
  downstream dataset loader can rely on them, and
* they must land **inside the project** (`<backend>/.data/`), never in the
  system temp directory. The temp directory is wiped on reboot and, on
  Windows, is not even stable across accounts — see `app/apps/rl/paths.py`
  for the full rationale.

These are property assertions, not snapshots.
"""

from __future__ import annotations

import csv
import json
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pytest

from app.apps.rl import paths as rl_paths
from app.apps.rl.trajectory import (
    CSV_HEADER,
    TrajectoryLogger,
    TrajectoryRow,
    default_trajectory_dir,
    get_trajectory_path,
    list_trajectories,
)


@dataclass
class _Vehicle:
    x: float
    z: float
    heading: float
    speed: float


@dataclass
class _Core:
    ego: _Vehicle
    npcs: list[_Vehicle]


def _core(n_npcs: int = 2) -> _Core:
    return _Core(
        ego=_Vehicle(x=1.0, z=2.0, heading=0.5, speed=7.5),
        npcs=[
            _Vehicle(x=float(i), z=float(i) + 1.0, heading=0.1 * i, speed=6.0)
            for i in range(n_npcs)
        ],
    )


def _read_csv(path: Path) -> tuple[list[str], list[list[str]]]:
    with open(path, newline="", encoding="utf-8") as fh:
        rows = list(csv.reader(fh))
    return rows[0], rows[1:]


# --- the output directory ---------------------------------------------------


def test_default_output_directory_is_inside_the_project() -> None:
    """The CSVs land under `<backend>/.data/`, not in the system temp dir."""
    target = default_trajectory_dir()

    assert target.is_absolute()
    assert Path(rl_paths._BACKEND_ROOT) in target.parents  # noqa: SLF001
    assert target == rl_paths.data_root() / "trajectories"


def test_default_output_directory_is_not_in_a_temp_folder() -> None:
    """The regression this locks: the old default was `%TEMP%/…`."""
    target = default_trajectory_dir()

    parts = {p.lower() for p in Path(target).parts}
    assert "tmp" not in parts, f"{target} still lands in a temp directory"

    temp_root = Path(tempfile.gettempdir()).resolve()
    assert temp_root not in Path(target).resolve().parents


def test_data_root_override_moves_the_trajectory_directory(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TRAFFIC_RL_DATA_DIR", str(tmp_path / "elsewhere"))
    assert default_trajectory_dir() == tmp_path / "elsewhere" / "trajectories"


def test_per_path_override_wins_over_the_data_root(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TRAFFIC_RL_DATA_DIR", str(tmp_path / "elsewhere"))
    monkeypatch.setenv("TRAFFSIM_TRAJECTORY_DIR", str(tmp_path / "csv"))
    assert default_trajectory_dir() == tmp_path / "csv"


# --- writing and reading back ----------------------------------------------


def test_a_written_episode_reads_back(tmp_path: Path) -> None:
    """Every step that was recorded is in the CSV."""
    logger = TrajectoryLogger(base_dir=tmp_path)
    logger.start_episode("cross", seed=0)

    steps = 5
    n_npcs = 2
    for _step in range(steps):
        logger.record_step(
            _core(n_npcs),
            np.array([0.5, 0.0]),
            reward=1.0,
            terminated=False,
            truncated=False,
            info={"reason": ""},
        )
    logger.end_episode()

    files = sorted(tmp_path.glob("pid*/episode_*.csv"))
    assert len(files) == 1
    header, rows = _read_csv(files[0])

    # One row per vehicle (ego + NPCs) per step.
    assert len(rows) == steps * (1 + n_npcs)
    assert [row[3] for row in rows[: 1 + n_npcs]] == ["ego", "npc_0", "npc_1"]


def test_the_header_matches_the_documented_one(tmp_path: Path) -> None:
    """The CSV header is exactly `CSV_HEADER` — a loader can rely on it."""
    logger = TrajectoryLogger(base_dir=tmp_path)
    logger.start_episode("cross", seed=0)
    logger.record_step(_core(), np.array([0.0, 0.0]), 0.0, False, False, {})
    logger.end_episode()

    files = sorted(tmp_path.glob("pid*/episode_*.csv"))
    header, _rows = _read_csv(files[0])

    assert header == CSV_HEADER
    assert header[0] == "episode_id"
    assert header[-1] == "info_reason"


def test_the_row_content_matches_the_sim_state(tmp_path: Path) -> None:
    """A row carries the vehicle state it was written from."""
    logger = TrajectoryLogger(base_dir=tmp_path)
    logger.start_episode("cross", seed=0)
    core = _core(n_npcs=0)
    logger.record_step(
        core,
        np.array([0.25, 0.0]),
        reward=2.5,
        terminated=False,
        truncated=False,
        info={"reason": ""},
    )
    logger.end_episode()

    files = sorted(tmp_path.glob("pid*/episode_*.csv"))
    _header, rows = _read_csv(files[0])
    row = rows[0]

    assert row[3] == "ego"
    assert row[4] == "True"
    assert float(row[5]) == pytest.approx(core.ego.x)
    assert float(row[6]) == pytest.approx(core.ego.z)
    assert float(row[7]) == pytest.approx(core.ego.heading)
    assert float(row[8]) == pytest.approx(core.ego.speed)
    assert float(row[9]) == pytest.approx(0.25)
    assert float(row[10]) == pytest.approx(2.5)


def test_steps_are_numbered_and_time_advances(tmp_path: Path) -> None:
    """Step index and sim time increase monotonically."""
    logger = TrajectoryLogger(base_dir=tmp_path)
    logger.start_episode("cross", seed=0)
    for _ in range(4):
        logger.record_step(_core(0), np.array([0.0, 0.0]), 0.0, False, False, {})
    logger.end_episode()

    files = sorted(tmp_path.glob("pid*/episode_*.csv"))
    _header, rows = _read_csv(files[0])

    steps = [int(row[1]) for row in rows]
    times = [float(row[2]) for row in rows]
    assert steps == [0, 1, 2, 3]
    assert times == sorted(times)
    assert times[0] == pytest.approx(0.0)


def test_episodes_are_separate_files(tmp_path: Path) -> None:
    """Each episode gets its own CSV, numbered in order."""
    logger = TrajectoryLogger(base_dir=tmp_path)
    for _ in range(3):
        logger.start_episode("cross", seed=0)
        logger.record_step(_core(0), np.array([0.0, 0.0]), 0.0, False, False, {})
        logger.end_episode()

    files = sorted(tmp_path.glob("pid*/episode_*.csv"))
    assert [f.name for f in files] == [
        "episode_000000.csv",
        "episode_000001.csv",
        "episode_000002.csv",
    ]


def test_the_manifest_counts_the_rows(tmp_path: Path) -> None:
    """The manifest reports how much was written."""
    logger = TrajectoryLogger(base_dir=tmp_path)
    logger.start_episode("corridor", seed=0)
    for _ in range(3):
        logger.record_step(_core(1), np.array([0.0, 0.0]), 0.0, False, False, {})
    logger.end_episode()

    manifests = list(tmp_path.glob("pid*/manifest.json"))
    assert len(manifests) == 1
    manifest = json.loads(manifests[0].read_text(encoding="utf-8"))

    assert manifest["total_episodes"] == 1
    assert manifest["total_rows"] == 6  # 3 steps x (ego + 1 NPC)
    assert manifest["scene_kind"] == "corridor"


def test_the_listing_finds_the_written_file(tmp_path: Path) -> None:
    """`list_trajectories` sees what was written."""
    logger = TrajectoryLogger(base_dir=tmp_path)
    logger.start_episode("cross", seed=0)
    logger.record_step(_core(0), np.array([0.0, 0.0]), 0.0, False, False, {})
    logger.end_episode()

    listed = list_trajectories(base_dir=tmp_path)

    assert len(listed) == 1
    assert listed[0]["filename"] == "episode_000000.csv"
    assert listed[0]["size_kb"] >= 0.0
    assert listed[0]["total_episodes"] == 1


def test_a_file_can_be_looked_up_by_name(tmp_path: Path) -> None:
    """`get_trajectory_path` finds the file again."""
    logger = TrajectoryLogger(base_dir=tmp_path)
    logger.start_episode("cross", seed=0)
    logger.record_step(_core(0), np.array([0.0, 0.0]), 0.0, False, False, {})
    logger.end_episode()

    found = get_trajectory_path("episode_000000.csv", base_dir=tmp_path)

    assert found is not None
    assert found.exists()
    assert get_trajectory_path("episode_999999.csv", base_dir=tmp_path) is None


def test_a_row_renders_the_documented_columns() -> None:
    """`TrajectoryRow.to_csv_row` has one value per header column."""
    row = TrajectoryRow(
        episode_id=0,
        step=1,
        sim_time=0.5,
        vehicle_id="ego",
        is_ego=True,
        x=1.0,
        z=2.0,
        heading=0.25,
        speed=8.0,
        action_accel=0.5,
        reward=1.25,
        terminated=False,
        truncated=False,
        info_reason="",
    )

    rendered = row.to_csv_row()

    assert len(rendered) == len(CSV_HEADER)
    assert rendered[3] == "ego"
    assert float(rendered[5]) == pytest.approx(1.0)
