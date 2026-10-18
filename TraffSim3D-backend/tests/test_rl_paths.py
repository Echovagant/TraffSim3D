"""Regression: RL runtime paths must not depend on the cwd's drive.

Windows gotcha this guards
--------------------------
`Path('/tmp/x').is_absolute()` is **False** on Windows; it resolves against
the current working directory's drive. The engine used to default all three
runtime paths to `/tmp`, so the same code wrote to `D:\\tmp\\` when launched
from a D: project and `C:\\tmp\\` from C: — which is where the six orphaned
`C:\\tmp\\ppo_checkpoints\\pid*` dirs came from.

POSIX gotcha: `/tmp` is conventionally wiped on reboot, taking every trained
model with it.
"""

from __future__ import annotations

from pathlib import Path

from app.apps.rl import checkpoint as rl_ckpt
from app.apps.rl import control as rl_control
from app.apps.rl import paths as rl_paths
from app.apps.rl import status as rl_status


def test_all_runtime_paths_are_absolute() -> None:
    """The bug in one assertion: /tmp is drive-relative on Windows."""
    for path in (
        rl_ckpt.get_checkpoint_dir(),
        rl_status.get_status_path(),
        rl_control.get_control_path(),
    ):
        assert path.is_absolute(), f"{path} is not absolute"


def test_runtime_paths_are_not_under_tmp() -> None:
    """No runtime state may live in a conventionally-wiped location."""
    for path in (
        rl_ckpt.get_checkpoint_dir(),
        rl_status.get_status_path(),
        rl_control.get_control_path(),
    ):
        parts = {p.lower() for p in Path(path).parts}
        assert "tmp" not in parts, f"{path} still lands in a tmp directory"


def test_default_paths_sit_under_the_backend_root() -> None:
    """Anchored to the package location, so cwd cannot move them."""
    root = rl_paths._BACKEND_ROOT  # noqa: SLF001
    for path in (
        rl_ckpt.get_checkpoint_dir(),
        rl_status.get_status_path(),
        rl_control.get_control_path(),
    ):
        assert Path(root) in Path(path).parents


def test_data_root_env_override_moves_all_three(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("TRAFFIC_RL_DATA_DIR", str(tmp_path / "elsewhere"))
    assert rl_paths.checkpoints_dir() == tmp_path / "elsewhere" / "ppo_checkpoints"
    assert rl_paths.status_file() == tmp_path / "elsewhere" / "training_status.json"
    assert rl_paths.control_file() == tmp_path / "elsewhere" / "training_control.json"


def test_per_path_env_override_wins_over_data_root(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("TRAFFIC_RL_DATA_DIR", str(tmp_path / "elsewhere"))
    monkeypatch.setenv("PPO_CHECKPOINT_DIR", str(tmp_path / "ckpt"))
    assert rl_paths.checkpoints_dir() == tmp_path / "ckpt"
    # The other two still follow data_root.
    assert rl_paths.status_file() == tmp_path / "elsewhere" / "training_status.json"


def test_data_root_is_created_on_demand(tmp_path, monkeypatch) -> None:
    target = tmp_path / "fresh"
    monkeypatch.setenv("TRAFFIC_RL_DATA_DIR", str(target))
    assert not target.exists()
    root = rl_paths.data_root()
    assert root.is_dir()
    assert root == target


def test_same_path_regardless_of_cwd(tmp_path, monkeypatch) -> None:
    """Launching from a different directory must not move the artifacts."""
    before_ckpt = rl_paths.checkpoints_dir()
    before_status = rl_paths.status_file()
    before_control = rl_paths.control_file()

    deeper = tmp_path / "deeper"
    deeper.mkdir()
    monkeypatch.chdir(deeper)

    assert rl_paths.checkpoints_dir() == before_ckpt
    assert rl_paths.status_file() == before_status
    assert rl_paths.control_file() == before_control
