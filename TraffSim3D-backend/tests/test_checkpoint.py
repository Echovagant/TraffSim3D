"""Plan 045: PPO checkpoint management tests."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.apps.rl import checkpoint as ckpt


@pytest.fixture
def tmp_ckpt_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Redirect PPO_CHECKPOINT_DIR to a temp dir for isolation."""
    monkeypatch.setenv("PPO_CHECKPOINT_DIR", str(tmp_path))
    # Force module-level _DEFAULT_DIR re-eval by setting it directly.
    # NOTE: use monkeypatch.setattr, not a bare assignment — a bare
    # `ckpt._DEFAULT_DIR = ...` leaks into every later test in the session,
    # leaving the module pointed at a deleted tmp_path.
    monkeypatch.setattr(ckpt, "_DEFAULT_DIR", tmp_path)
    return tmp_path


def test_save_checkpoint_creates_file(tmp_ckpt_dir: Path) -> None:
    """With a real bytes file as the 'model', verify path + per-process dir."""

    # Use a real file write via _per_process_dir + a tiny "model" shim
    class _FakeModel:
        def save(self, p: str) -> None:
            Path(p).write_bytes(b"fake-ppo-weights")

    model = _FakeModel()
    path = ckpt.save_checkpoint(model, 1000)
    assert path.exists()
    assert path.name == "ppo_step_0001000.zip"
    # Per-process subdir
    assert path.parent.parent == tmp_ckpt_dir
    assert path.parent.name.startswith("pid")


def test_list_checkpoints_returns_newest_first(tmp_ckpt_dir: Path) -> None:
    # Create 3 mock checkpoints at different mtimes
    import time

    paths = []
    for i, step in enumerate([100, 200, 300]):
        p = tmp_ckpt_dir / ckpt._per_process_dir().name / f"ppo_step_{step:07d}.zip"  # type: ignore[attr-defined]
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"x")
        # Set distinct mtimes
        import os as _os

        _os.utime(p, (time.time() + i, time.time() + i))
        paths.append(p)
    ckpts = ckpt.list_checkpoints()
    assert len(ckpts) == 3
    # Newest first
    assert ckpts[0]["name"] == "ppo_step_0000300.zip"
    assert ckpts[2]["name"] == "ppo_step_0000100.zip"
    # Each entry has size + mtime + process
    for c in ckpts:
        assert "size_kb" in c
        assert "mtime_ms" in c
        assert c["process"].startswith("pid")


def test_prune_old_keeps_n_newest(tmp_ckpt_dir: Path) -> None:
    pdir = ckpt._per_process_dir()  # type: ignore[attr-defined]
    pdir.mkdir(parents=True, exist_ok=True)
    import time

    for i in range(8):
        p = pdir / f"ppo_step_{i:07d}.zip"
        p.write_bytes(b"x")
        os.utime(p, (time.time() + i, time.time() + i))
    deleted = ckpt._prune_old(pdir, keep=3)
    assert deleted == 5
    remaining = sorted(pdir.glob("*.zip"))
    assert len(remaining) == 3


def test_prune_all_checkpoints_across_processes(tmp_ckpt_dir: Path) -> None:
    """Two fake processes each have 4 checkpoints → keep 5 total."""
    import time

    for pid in ["pid111", "pid222"]:
        sub = tmp_ckpt_dir / pid
        sub.mkdir(parents=True, exist_ok=True)
        for i in range(4):
            p = sub / f"ppo_step_{i:07d}.zip"
            p.write_bytes(b"x")
            os.utime(p, (time.time() + i, time.time() + i))
    deleted = ckpt.prune_all_checkpoints(keep_total=5)
    assert deleted == 3
    remaining = ckpt.list_checkpoints()
    assert len(remaining) == 5


def test_list_checkpoints_empty_when_no_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When PPO_CHECKPOINT_DIR doesn't exist, list returns empty."""
    nonexistent = tmp_path / "nonexistent"
    monkeypatch.setattr(ckpt, "_DEFAULT_DIR", nonexistent)
    assert ckpt.list_checkpoints() == []
    assert ckpt.prune_all_checkpoints() == 0
