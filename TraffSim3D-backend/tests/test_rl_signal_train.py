"""`app/apps/rl/signal_train.py` — the signal agent's training entry point.

The smoke test is the plan's T5 gate: train a **tiny** number of steps,
produce a checkpoint, export the weights, and assert the export is a
**discrete** five-action policy (no `log_std`).

The evaluation helpers are pinned too, because the numbers they produce are
the ones the trained policy is compared against:

- `evaluate_schedule` on `no_op` must reproduce the fixed 30/30 cycle's
  return (-423.1 over 600 steps) — the baseline a trained policy has to
  beat. If that number moves, the comparison itself is no longer valid.
- `evaluate_policy` must score a policy deterministically (the browser runs
  the argmax) and report the action histogram.
"""

from __future__ import annotations

import sys

import pytest

from app.apps.rl import checkpoint as rl_checkpoint
from app.apps.rl import control as rl_control
from app.apps.rl import paths as rl_paths
from app.apps.rl import signal_train, train
from app.apps.rl import status as rl_status
from app.apps.rl.sim_core import SIGNAL_ACTION_NAMES


def _sb3_installed() -> bool:
    try:
        import stable_baselines3  # noqa: F401
    except ImportError:
        return False
    return True


requires_sb3 = pytest.mark.skipif(
    not _sb3_installed(),
    reason="stable-baselines3 not installed — the real training path is unreachable",
)


@pytest.fixture
def rl_state(tmp_path, monkeypatch):
    """Isolate the RL runtime state (status + control + checkpoints).

    The env var alone is not enough: `status.py` / `control.py` /
    `checkpoint.py` evaluate their paths at **import** time, so the module
    attributes have to be patched for the writes to land in `tmp_path`.
    """
    monkeypatch.setenv("TRAFFIC_RL_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PPO_CHECKPOINT_DIR", str(tmp_path / "ppo_checkpoints"))
    monkeypatch.setattr(rl_control, "_DEFAULT_PATH", tmp_path / "training_control.json")
    monkeypatch.setattr(rl_status, "_DEFAULT_PATH", tmp_path / "training_status.json")
    monkeypatch.setattr(rl_checkpoint, "_DEFAULT_DIR", tmp_path / "ppo_checkpoints")
    # `_control_gate` keeps its "epoch already seen" counter in a module
    # global shared by the whole process.
    monkeypatch.setattr(train, "_SEEN_CONTROL_EPOCH", 0)
    return tmp_path


# --------------------------------------------------------------------------
# The baseline the trained policy has to beat
# --------------------------------------------------------------------------


def test_no_op_schedule_reproduces_the_fixed_cycle_baseline() -> None:
    """The fixed 30/30 cycle must score -423.1 over 600 steps.

    This is the number Plan 074 T9 measured and the gate the trained policy
    is compared against; if it moves, the comparison is meaningless.
    """
    result = signal_train.evaluate_schedule(signal_train.NO_OP_INDEX)
    assert result["steps"] == 600
    assert result["action"] == "no_op"
    assert result["return"] == pytest.approx(-423.1, abs=0.05)


def test_the_degenerate_schedules_are_worse_than_the_fixed_cycle() -> None:
    """The other constant actions must all score below the fixed cycle.

    These are the numbers Plan 074 T9 measured (flicker -437.2, starve
    -455.4, preempt -777.6).
    """
    baseline = signal_train.evaluate_schedule(signal_train.NO_OP_INDEX)["return"]
    for name in ("shorten_red", "extend_green", "preempt"):
        index = SIGNAL_ACTION_NAMES.index(name)
        result = signal_train.evaluate_schedule(index)
        assert result["return"] < baseline, f"{name} is not worse than the fixed cycle"


def test_evaluate_schedule_reports_the_action_histogram() -> None:
    result = signal_train.evaluate_schedule(signal_train.NO_OP_INDEX)
    assert result["actions"] == {"no_op": 600}


# --------------------------------------------------------------------------
# evaluate_policy
# --------------------------------------------------------------------------


class _ConstantPolicy:
    """A stand-in policy: always answers `action_index`."""

    def __init__(self, action_index: int) -> None:
        self.action_index = action_index
        self.calls = 0

    def predict(self, _obs, deterministic: bool = False):  # noqa: ANN001, ANN201
        self.calls += 1
        return self.action_index, None


def test_evaluate_policy_scores_deterministically() -> None:
    policy = _ConstantPolicy(signal_train.NO_OP_INDEX)
    result = signal_train.evaluate_policy(policy, episodes=3)
    assert result["episodes"] == 3
    assert len(result["returns"]) == 3
    # The env is deterministic, so the episodes agree.
    assert result["returns"] == [result["returns"][0]] * 3
    assert result["return"] == pytest.approx(-423.1, abs=0.05)
    assert result["actions"] == {"no_op": 1800}


def test_evaluate_policy_reports_the_action_distribution() -> None:
    policy = _ConstantPolicy(SIGNAL_ACTION_NAMES.index("shorten_red"))
    result = signal_train.evaluate_policy(policy, episodes=1)
    assert set(result["actions"]) <= {"shorten_red"}
    assert sum(result["actions"].values()) == 600


# --------------------------------------------------------------------------
# The training run itself
# --------------------------------------------------------------------------


@requires_sb3
def test_training_smoke_produces_a_discrete_checkpoint(rl_state) -> None:
    """THE T5 GATE: train a few steps -> checkpoint -> export -> discrete.

    The exported weights must have `action_dim == 5` and **no** `log_std`:
    an SB3 `CategoricalPolicy` has action logits, not a Gaussian log-std.
    """
    from app.apps.rl.weights import export_weights

    summary = signal_train.train_signal_policy(
        64,
        device="cpu",
        save_every=32,
        n_steps=32,
        batch_size=16,
    )
    assert summary["trained"] is True

    checkpoint = rl_paths.checkpoints_dir()
    assert checkpoint.exists()
    zips = sorted(checkpoint.rglob("ppo_step_*.zip"))
    assert zips, "the training run produced no checkpoint"

    weights = export_weights(zips[-1])
    assert weights["action_dim"] == 5
    assert weights["action_space"] == "discrete"
    assert weights["obs_dim"] == 6
    assert "log_std" not in weights["layers"]


@requires_sb3
def test_training_writes_the_shared_status_document(rl_state) -> None:
    signal_train.train_signal_policy(
        32,
        device="cpu",
        save_every=32,
        n_steps=32,
        batch_size=16,
    )
    status = rl_status.read_status()
    assert status["running"] is False
    assert status["policy_kind"] == "signal"
    assert status["action_space"] == "discrete"
    assert status["action_dim"] == 5
    assert status["obs_dim"] == 6
    assert status["latest_checkpoint"].endswith(".zip")
    assert "signal_ppo_completed" in status["reason"]


@requires_sb3
def test_training_clears_a_stale_terminate_at_startup(rl_state) -> None:
    rl_control.request("terminate")
    signal_train.train_signal_policy(
        32,
        device="cpu",
        save_every=32,
        n_steps=32,
        batch_size=16,
    )
    assert rl_control.read_control()["state"] == rl_control.STATE_RUNNING


@requires_sb3
def test_a_terminate_request_stops_the_run(rl_state) -> None:
    """A terminate request issued *while* the run is going must stop it.

    The control channel's job is to interrupt a **running** training, so the
    request is issued from a thread after the run has started. (A request
    that exists *before* the run is cleared by `clear_control()` — the same
    rule the ego trainer follows.)
    """
    import threading
    import time

    def terminate_later() -> None:
        time.sleep(0.5)
        rl_control.request("terminate")

    worker = threading.Thread(target=terminate_later, daemon=True)
    worker.start()
    summary = signal_train.train_signal_policy(
        4000,
        device="cpu",
        save_every=1000,
        n_steps=256,
        batch_size=64,
    )
    worker.join(timeout=5)
    assert summary["trained"] is False
    assert summary["reason"] == "terminated_by_request"
    assert rl_status.read_status()["reason"] == "terminated_by_request"


@requires_sb3
def test_the_trained_checkpoint_can_be_evaluated(rl_state) -> None:
    """The checkpoint the run produced must be loadable and scorable."""
    from stable_baselines3 import PPO

    signal_train.train_signal_policy(
        64,
        device="cpu",
        save_every=32,
        n_steps=32,
        batch_size=16,
    )
    zips = sorted(rl_paths.checkpoints_dir().rglob("ppo_step_*.zip"))
    assert zips
    model = PPO.load(str(zips[-1]), device="cpu")
    result = signal_train.evaluate_policy(model, episodes=1)
    assert len(result["returns"]) == 1
    # The reward is the total delay: always negative.
    assert result["return"] < 0


# --------------------------------------------------------------------------
# The CLI
# --------------------------------------------------------------------------


@requires_sb3
def test_main_baselines_prints_every_fixed_schedule(rl_state, monkeypatch, capsys) -> None:
    monkeypatch.setattr(sys, "argv", ["prog", "--baselines"])

    signal_train.main()

    out = capsys.readouterr().out
    for name in ("no_op", "shorten_red", "extend_green", "preempt"):
        assert name in out
    assert "-423.1" in out


@requires_sb3
def test_main_trains_and_reports_the_best_return(rl_state, monkeypatch, capsys) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        ["prog", "64", "--device", "cpu", "--save-every", "32", "--eval-every", "32"],
    )

    signal_train.main()

    out = capsys.readouterr().out
    assert "best return" in out
    assert "baseline (fixed 30/30)" in out
    # The run must have produced a checkpoint.
    assert list(rl_paths.checkpoints_dir().rglob("ppo_step_*.zip"))


@requires_sb3
def test_main_eval_scores_an_existing_checkpoint(rl_state, monkeypatch, capsys) -> None:
    signal_train.train_signal_policy(
        64,
        device="cpu",
        save_every=32,
        n_steps=32,
        batch_size=16,
    )
    zips = sorted(rl_paths.checkpoints_dir().rglob("ppo_step_*.zip"))
    assert zips
    monkeypatch.setattr(sys, "argv", ["prog", "--eval", str(zips[-1])])

    signal_train.main()

    out = capsys.readouterr().out
    assert "action_dim=5" in out
    assert "action_space=discrete" in out
    assert "return" in out


def test_training_degrades_to_a_dry_run_without_sb3(rl_state, monkeypatch) -> None:
    """Without SB3 the run must degrade to a synthetic run, not crash."""
    from app.apps.rl import capabilities as rl_caps

    monkeypatch.setattr(
        rl_caps,
        "resolve_device",
        lambda requested: ("dry_run", "forced_no_sb3"),
    )

    summary = signal_train.train_signal_policy(100, device="cpu")

    assert summary["trained"] is False
    assert summary["reason"] == "forced_no_sb3"
    status = rl_status.read_status()
    assert status["running"] is False
    assert status["latest_checkpoint"] == "dry_run_fallback"
    assert "dry_run_fallback" in status["reason"]
    # No checkpoint must be left behind for the API to advertise.
    ckpt_dir = rl_paths.checkpoints_dir()
    assert not ckpt_dir.exists() or list(ckpt_dir.iterdir()) == []
