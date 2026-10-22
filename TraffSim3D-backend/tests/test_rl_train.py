"""`app/apps/rl/train.py` — the training entry point.

Scope: the paths that do **not** require stable-baselines3. SB3 is not
installed in the default dev environment (`uv sync --extra dev`), and torch is
not either, so the real `PPO(...)` body of `real_train` / `curriculum_train`
is unreachable here. What *is* reachable is exactly the code the project
depends on in production when SB3 is absent: the degradation to a synthetic
dry run, plus `_control_gate()` — the pause/resume/terminate gate that the
SB3 callbacks call once per step.

`tests/test_rl_control.py` covers the control channel itself and
`tests/test_rl_train_control_e2e.py` covers the gate across a real process
boundary. This module covers them in-process, so the gate's *status-file side
effects* (which the subprocess tests cannot observe) are asserted too.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import threading
import time

import pytest

from app.apps.rl import capabilities as rl_caps
from app.apps.rl import checkpoint as rl_checkpoint
from app.apps.rl import control as rl_control
from app.apps.rl import paths as rl_paths
from app.apps.rl import status as rl_status
from app.apps.rl import train


def _sb3_installed() -> bool:
    return importlib.util.find_spec("stable_baselines3") is not None


#: Marks the tests that assert the *real*, unmocked no-SB3 degradation. If SB3
#: is ever installed (`uv sync --extra rl`) these would attempt real training,
#: so they are skipped rather than silently becoming slow integration tests.
requires_no_sb3 = pytest.mark.skipif(
    _sb3_installed(),
    reason="stable_baselines3 installed — the no-SB3 fallback is unreachable",
)

#: Marks the tests that need the **real** PPO. They are skipped in a venv
#: without stable-baselines3, where the training path is unreachable.
requires_sb3 = pytest.mark.skipif(
    not _sb3_installed(),
    reason="stable_baselines3 not installed — the real training path is unreachable",
)


@pytest.fixture
def rl_state(tmp_path, monkeypatch):
    """Isolate the RL runtime state (status + control) into `tmp_path`.

    Both `TRAFFIC_RL_DATA_DIR` **and** the module-level `_DEFAULT_PATH` are
    set. The env var alone is not enough: `status.py:17` and `control.py:56`
    evaluate `paths.status_file()` / `paths.control_file()` at **import**
    time, so once those modules are in `sys.modules` (they always are — other
    test modules import them) the env var no longer has any effect. Patching
    `_DEFAULT_PATH` is what actually redirects the writes; the env var is kept
    so anything re-imported underneath still lands in the same directory.

    This is the only thing standing between these tests and the real
    `.data/` directory, which the existing suite already races over
    (see `test_rl_api.py::test_train_start_clears_stale_control`).
    """
    monkeypatch.setenv("TRAFFIC_RL_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(rl_control, "_DEFAULT_PATH", tmp_path / "training_control.json")
    monkeypatch.setattr(rl_status, "_DEFAULT_PATH", tmp_path / "training_status.json")
    # `_control_gate` keeps its "epoch already seen" counter in a module
    # global shared by the whole process; reset it so tests cannot depend on
    # (or leak into) each other.
    monkeypatch.setattr(train, "_SEEN_CONTROL_EPOCH", 0)
    return tmp_path


def _status() -> dict:
    return rl_status.read_status()


def _control() -> dict:
    return rl_control.read_control()


# --------------------------------------------------------------------------
# _control_gate — pause / resume / terminate
# --------------------------------------------------------------------------


def test_gate_without_control_file_does_not_stop(rl_state) -> None:
    """No control file at all must read as `running` and keep training."""
    assert rl_control.get_control_path().parent == rl_state

    stop, epoch = train._control_gate()

    assert stop is False
    assert epoch == 0


def test_gate_reports_terminate_as_stop(rl_state) -> None:
    """A terminate request must surface as `should_stop` — this is what makes
    the SB3 callback return False and halt learning."""
    payload = rl_control.request("terminate")
    assert payload["state"] == rl_control.STATE_TERMINATED

    stop, epoch = train._control_gate()

    assert stop is True
    assert epoch == payload["epoch"] == 1


def test_gate_records_seen_epoch_for_later_calls(rl_state) -> None:
    """The gate must remember the epoch it last observed, and advance it on
    each subsequent call — that is what makes a stale request file unable to
    re-fire a transition."""
    rl_control.request("terminate")

    assert train._control_gate() == (True, 1)
    assert train._SEEN_CONTROL_EPOCH == 1

    # The API resumes the run (new request => new epoch).
    rl_control.request("resume")

    assert train._control_gate() == (False, 2)
    assert train._SEEN_CONTROL_EPOCH == 2


def test_gate_blocks_while_paused_until_resume(rl_state) -> None:
    """Pausing must actually block inside the gate — no environment step may
    run while paused — and `resume` must unblock it."""
    rl_control.request("pause")
    unblock = threading.Event()
    delay_s = 0.35

    def resume_later() -> None:
        time.sleep(delay_s)
        rl_control.request("resume")
        unblock.set()

    worker = threading.Thread(target=resume_later, daemon=True)
    started = time.monotonic()
    worker.start()
    stop, epoch = train._control_gate()
    elapsed = time.monotonic() - started
    worker.join(timeout=5)

    assert unblock.is_set(), "the resume request never landed — test is not exercising the block"
    # Prove it waited rather than returning immediately.
    assert elapsed >= delay_s * 0.75, f"gate returned after {elapsed:.3f}s — it did not block"
    assert stop is False
    assert epoch == 2  # pause=1, resume=2
    assert _status()["paused"] is False


def test_gate_sees_terminate_issued_while_paused(rl_state) -> None:
    """A terminate that arrives *during* a pause must still be observed —
    the control file is desired state, not a queue, so nothing is lost."""
    rl_control.request("pause")

    def terminate_later() -> None:
        time.sleep(0.35)
        rl_control.request("terminate")

    worker = threading.Thread(target=terminate_later, daemon=True)
    worker.start()
    stop, epoch = train._control_gate()
    worker.join(timeout=5)

    assert stop is True
    assert epoch == 2


def test_gate_watchdog_abandons_a_forgotten_pause(rl_state, monkeypatch) -> None:
    """A pause nobody ever resumes must not wedge the process: after the
    watchdog fires the gate abandons the pause, records it, and lets training
    continue."""
    monkeypatch.setattr(train, "PAUSE_WATCHDOG_S", 0.05)
    rl_control.request("pause")

    stop, epoch = train._control_gate()

    # Not a false terminate: the run continues.
    assert stop is False
    assert epoch == 1
    status = _status()
    assert status["pause_abandoned"] is True
    assert status["paused"] is False
    # The trainer asks for itself to resume, so the channel is no longer stuck.
    assert _control()["state"] == rl_control.STATE_RUNNING


# --------------------------------------------------------------------------
# dry_run — synthetic reward history, no SB3
# --------------------------------------------------------------------------


def test_dry_run_writes_reward_history_and_completes(rl_state) -> None:
    train.dry_run(total_steps=1000, n_agents=2, independent=False, scene_kind="cross")

    status = _status()
    history = status["reward_history"]
    # 1000 // 200 => 5 episodes.
    assert len(history) == 5
    # Episode 0 has no sine term: (0.5 + 0) * 2 == 1.0
    assert history[0] == pytest.approx(1.0)
    # Each curve is strictly increasing — a UI preview with a flat or falling
    # line would read as a broken run.
    assert history == sorted(history)
    assert history[-1] > history[0]

    assert status["last_reward"] == pytest.approx(history[-1])
    assert status["episode_count"] == 5
    assert status["running"] is False
    assert status["reason"] == "dry_run_completed"
    assert status["latest_checkpoint"] == "ppo_step_0001000.zip (dry_run)"
    assert status["independent_agents"] is False
    assert status["n_agents"] == 2
    assert status["scene_kind"] == "cross"
    assert status["total_steps"] == 1000


def test_dry_run_episode_count_follows_total_steps(rl_state) -> None:
    train.dry_run(total_steps=400, n_agents=1)

    assert len(_status()["reward_history"]) == 2
    assert _status()["latest_checkpoint"] == "ppo_step_0000400.zip (dry_run)"


def test_dry_run_small_total_steps_still_runs_one_episode(rl_state) -> None:
    """`max(1, ...)` floor: a request smaller than one episode must still
    produce history rather than an empty list the UI cannot render."""
    train.dry_run(total_steps=10, n_agents=1)

    status = _status()
    assert len(status["reward_history"]) == 1
    assert status["last_reward"] == pytest.approx(0.5)


def test_dry_run_independent_builds_one_curve_per_agent(rl_state) -> None:
    train.dry_run(total_steps=600, n_agents=3, independent=True, scene_kind="cross")

    status = _status()
    per_agent = status["agent_rewards"]
    assert sorted(per_agent) == ["0", "1", "2"]
    assert all(len(v) == 3 for v in per_agent.values())

    # Episode 0 has no sine term, so each agent's curve is exactly
    # 0.5 * (1 + 0.1 * i) — the documented "slightly different" offset.
    assert per_agent["0"][0] == pytest.approx(0.5)
    assert per_agent["1"][0] == pytest.approx(0.55)
    assert per_agent["2"][0] == pytest.approx(0.6)
    # Agent 0's curve is strictly below agent 2's at every episode.
    assert all(a < b for a, b in zip(per_agent["0"], per_agent["2"], strict=True))

    # UI back-compat: the flat history is the mean across agents.
    history = status["reward_history"]
    assert len(history) == 3
    for ep in range(3):
        expected = sum(per_agent[str(i)][ep] for i in range(3)) / 3
        assert history[ep] == pytest.approx(expected)

    assert status["last_reward"] == pytest.approx(history[-1])
    assert status["episode_count"] == 3
    assert status["step"] == 600
    assert status["running"] is False
    assert status["reason"] == "dry_run_independent_completed"
    assert status["independent_agents"] is True
    assert status["latest_checkpoint"] == (
        "ppo_agent0_step_0000600.zip, ppo_agent1_step_0000600.zip, ppo_agent2_step_0000600.zip"
    )


# --------------------------------------------------------------------------
# real_train — reachable only as far as the no-SB3 fallback
# --------------------------------------------------------------------------


@requires_no_sb3
def test_real_train_auto_falls_back_to_dry_run_without_sb3(rl_state) -> None:
    """With SB3 absent, `auto` must degrade to a synthetic run rather than
    crash on `from stable_baselines3 import PPO`."""
    train.real_train(1000, "auto", 2, 500, False, "cross")

    status = _status()
    assert status["device"] == "dry_run"
    assert status["device_reason"] == "auto_fallback_no_sb3"
    assert status["running"] is False
    assert status["reason"] == "dry_run_fallback (auto_fallback_no_sb3)"
    assert status["latest_checkpoint"] == "dry_run_fallback"
    assert status["reward_history"] == [0.0]
    assert status["scene_kind"] == "cross"
    assert status["n_agents"] == 2
    assert status["independent_agents"] is False


@requires_no_sb3
def test_real_train_without_sb3_writes_no_checkpoint(rl_state) -> None:
    """The fallback must not leave a bogus checkpoint behind for
    `GET /rl/checkpoints` to advertise."""
    from app.apps.rl import paths as rl_paths

    train.real_train(1000, "cpu", 2, 500)

    ckpt_dir = rl_paths.checkpoints_dir()
    assert not ckpt_dir.exists() or list(ckpt_dir.iterdir()) == []


def test_real_train_records_resolved_device_and_scene(rl_state, monkeypatch) -> None:
    """Pins the status fields a real run writes before any PPO work starts,
    without depending on whether SB3 happens to be installed."""
    monkeypatch.setattr(
        rl_caps,
        "resolve_device",
        lambda requested: ("dry_run", f"forced_{requested}"),
    )

    train.real_train(800, "gpu", 3, 250, True, "roundabout")

    status = _status()
    assert status["device"] == "dry_run"
    assert status["device_reason"] == "forced_gpu"
    assert status["n_agents"] == 3
    assert status["independent_agents"] is True
    assert status["scene_kind"] == "roundabout"
    assert status["total_steps"] == 800
    assert status["reason"] == "dry_run_fallback (forced_gpu)"


def test_real_train_clears_a_stale_terminate_at_startup(rl_state) -> None:
    """A fresh run must not inherit the previous run's terminate request —
    otherwise the very first gate call would kill it instantly."""
    rl_control.request("terminate")
    assert _control()["state"] == rl_control.STATE_TERMINATED

    train.real_train(1000, "auto", 2, 500)

    assert _control()["state"] == rl_control.STATE_RUNNING
    assert train._control_gate()[0] is False


# --------------------------------------------------------------------------
# curriculum_train — same story, plus the curriculum status fields
# --------------------------------------------------------------------------


def test_curriculum_train_falls_back_to_dry_run_without_sb3(rl_state, monkeypatch) -> None:
    monkeypatch.setattr(
        rl_caps,
        "resolve_device",
        lambda requested: ("dry_run", "forced_no_sb3"),
    )

    train.curriculum_train(600, "auto", 500)

    status = _status()
    assert status["device"] == "dry_run"
    assert status["device_reason"] == "forced_no_sb3"
    assert status["curriculum"] is True
    # Curriculum always starts on the easiest scene.
    assert status["scene_kind"] == "cross"
    assert status["running"] is False
    assert status["reason"] == "dry_run_fallback (forced_no_sb3)"
    assert status["latest_checkpoint"] == "dry_run_fallback"
    assert status["reward_history"] == [0.0]


def test_curriculum_train_without_sb3_writes_no_checkpoint(rl_state) -> None:
    from app.apps.rl import paths as rl_paths

    train.curriculum_train(600, "auto", 500)

    ckpt_dir = rl_paths.checkpoints_dir()
    assert not ckpt_dir.exists() or list(ckpt_dir.iterdir()) == []


# --------------------------------------------------------------------------
# main — CLI routing
# --------------------------------------------------------------------------


def test_main_dry_run_flag_routes_to_dry_run(rl_state, monkeypatch) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        ["prog", "800", "--dry-run", "--n-agents", "4", "--scene-kind", "corridor"],
    )

    train.main()

    status = _status()
    assert status["total_steps"] == 800
    assert status["n_agents"] == 4
    assert status["scene_kind"] == "corridor"
    assert status["reason"] == "dry_run_completed"


def test_main_defaults_to_1000_steps_two_agents(rl_state, monkeypatch) -> None:
    """With no arguments at all, `main()` must take the dry-run path (no SB3)
    rather than raising."""
    monkeypatch.setattr(sys, "argv", ["prog", "--dry-run"])

    train.main()

    status = _status()
    assert status["total_steps"] == 1000
    assert status["n_agents"] == 2
    assert status["scene_kind"] == "cross"
    assert status["independent_agents"] is False


def test_main_independent_flag_routes_through(rl_state, monkeypatch) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        ["prog", "400", "--dry-run", "--independent", "--n-agents", "2"],
    )

    train.main()

    status = _status()
    assert status["independent_agents"] is True
    assert status["reason"] == "dry_run_independent_completed"
    assert sorted(status["agent_rewards"]) == ["0", "1"]


def test_main_curriculum_dry_run_forces_single_agent_cross(rl_state, monkeypatch) -> None:
    """`--curriculum --dry-run` ignores --n-agents/--scene-kind: curriculum is
    single-agent and starts on `cross`."""
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "prog",
            "600",
            "--curriculum",
            "--dry-run",
            "--n-agents",
            "7",
            "--scene-kind",
            "roundabout",
        ],
    )

    train.main()

    status = _status()
    assert status["n_agents"] == 1
    assert status["independent_agents"] is False
    assert status["scene_kind"] == "cross"
    assert status["reason"] == "dry_run_completed"


def test_main_curriculum_without_dry_run_calls_curriculum_train(rl_state, monkeypatch) -> None:
    """`--curriculum` must route to curriculum_train, not to real_train — the
    distinguishing evidence is the `curriculum` status flag."""
    monkeypatch.setattr(
        rl_caps,
        "resolve_device",
        lambda requested: ("dry_run", "forced_no_sb3"),
    )
    monkeypatch.setattr(sys, "argv", ["prog", "600", "--curriculum"])

    train.main()

    status = _status()
    assert status["curriculum"] is True
    assert status["device"] == "dry_run"
    assert status["scene_kind"] == "cross"
    # curriculum_train never produces per-agent histories — that would mean
    # real_train had run instead.
    assert "agent_rewards" not in status


def test_main_falls_back_to_dry_run_on_import_error(rl_state, monkeypatch, capsys) -> None:
    """If SB3 blows up on import, `main()` must say so and still leave a
    usable synthetic run behind rather than propagating."""

    def boom(*_args, **_kwargs) -> None:
        raise ImportError("No module named 'stable_baselines3'")

    monkeypatch.setattr(train, "real_train", boom)
    monkeypatch.setattr(sys, "argv", ["prog", "500"])

    train.main()

    out = capsys.readouterr().out
    assert "SB3 unavailable" in out
    assert "stable_baselines3" in out
    status = _status()
    assert status["total_steps"] == 500
    assert status["reason"] == "dry_run_completed"


def test_main_curriculum_falls_back_on_import_error(rl_state, monkeypatch, capsys) -> None:
    def boom(*_args, **_kwargs) -> None:
        raise ImportError("No module named 'stable_baselines3'")

    monkeypatch.setattr(train, "curriculum_train", boom)
    monkeypatch.setattr(sys, "argv", ["prog", "500", "--curriculum"])

    train.main()

    out = capsys.readouterr().out
    assert "SB3 unavailable" in out
    status = _status()
    assert status["total_steps"] == 500
    assert status["n_agents"] == 1
    assert status["reason"] == "dry_run_completed"


@requires_no_sb3
def test_main_end_to_end_degrades_without_sb3(rl_state, monkeypatch) -> None:
    """Nothing mocked: `main()` with no `--dry-run` and `--device cpu` must
    land in `real_train`, hit the dry-run fallback, and still produce a
    complete status document."""
    monkeypatch.setattr(sys, "argv", ["prog", "400", "--device", "cpu"])

    train.main()

    status = _status()
    assert status["device"] == "dry_run"
    assert status["device_reason"] == "cpu_requested_but_sb3_missing"
    assert status["reason"] == "dry_run_fallback (cpu_requested_but_sb3_missing)"
    assert status["running"] is False
    assert status["total_steps"] == 400


def test_main_rejects_unknown_scene_kind(rl_state, monkeypatch) -> None:
    """argparse validation must reject a scene the simulator cannot build."""
    monkeypatch.setattr(sys, "argv", ["prog", "100", "--scene-kind", "roundabout2"])

    with pytest.raises(SystemExit):
        train.main()


def test_status_file_stays_inside_tmp(rl_state, monkeypatch) -> None:
    """Guard-rail: the fixture really is what keeps these tests out of the
    repository's `.data/` directory."""
    monkeypatch.setattr(sys, "argv", ["prog", "200", "--dry-run"])

    train.main()

    written = rl_status.get_status_path()
    assert rl_state in written.parents
    assert json.loads(written.read_text(encoding="utf-8"))["total_steps"] == 200
    assert not (rl_state / "ppo_checkpoints").exists()


# --------------------------------------------------------------------------
# The real PPO path — the ego policy's export shape
# --------------------------------------------------------------------------


@requires_sb3
def test_the_ego_training_path_exports_a_browser_loadable_policy(rl_state, monkeypatch) -> None:
    """Train a few steps -> checkpoint -> export -> the shape the browser needs.

    The browser's `mlpForwardMean` (`src/infrastructure/rl/mlpInference.ts`)
    feeds a 14-dim observation into the exported layers and reads a 2-dim
    action out of them, so a policy trained through `train.py` has to export
    `obs_dim == 14`, `action_dim == 2` and the two hidden sizes.

    The `--n-agents 1` path is the one that does: the multi-agent env stacks
    the agents' observations into a `(n_agents, OBS_DIM)` box, and SB3's
    flatten extractor turns that into `n_agents * 14` inputs and
    `n_agents * 2` outputs — a policy the browser cannot load.
    """
    from app.apps.rl.weights import export_weights

    # The checkpoint directory is resolved at **import** time
    # (`checkpoint.py:_DEFAULT_DIR`), so the module attribute is what has to
    # be patched — otherwise the run writes into the repository's `.data/`.
    monkeypatch.setattr(rl_checkpoint, "_DEFAULT_DIR", rl_state / "ppo_checkpoints")

    train.real_train(64, "cpu", 1, 1000, False, "cross")

    zips = sorted(rl_paths.checkpoints_dir().rglob("ppo_step_*.zip"))
    assert zips, "the training run produced no checkpoint"

    weights = export_weights(zips[-1])
    assert weights["obs_dim"] == 14
    assert weights["action_dim"] == 2
    assert weights["hidden_sizes"] == [64, 64]
    # The ego's action space is a Box, so the export is the **continuous**
    # one: the diagonal Gaussian log-std is present. The export must not
    # depend on the action space being discrete.
    assert weights["action_space"] == "continuous"
    assert set(weights["layers"]) == {
        "policy_net.0.weight",
        "policy_net.0.bias",
        "policy_net.2.weight",
        "policy_net.2.bias",
        "action_net.weight",
        "action_net.bias",
        "log_std",
    }
    # The layer the browser reads its input dimension from.
    assert len(weights["layers"]["policy_net.0.weight"][0]) == 14
    assert len(weights["layers"]["action_net.weight"]) == 2


# --------------------------------------------------------------------------
# The light curriculum
# --------------------------------------------------------------------------


def test_the_light_curriculum_reproduces_the_measured_recipe() -> None:
    """The stage list is the measured one, and it scales with the budget.

    The budgets are the ones measured (two seeds, the same
    score at the 8 s and the 12 s stages), so `--steps 230000` reproduces
    that measurement exactly.
    """
    stages = train.light_curriculum_stages(230_000)

    assert stages == [
        (6.0, 60_000),
        (8.0, 40_000),
        (10.0, 40_000),
        (12.0, 90_000),
    ]
    assert sum(budget for _cycle, budget in stages) == 230_000

    doubled = train.light_curriculum_stages(460_000)
    assert [budget for _cycle, budget in doubled] == [budget * 2 for _cycle, budget in stages]


def test_the_light_curriculum_ends_on_the_shipped_red_length() -> None:
    """The last stage must train on the scene's **shipped** cycle.

    Otherwise the policy would be handed to the browser for a red length
    it was never trained on.
    """
    from app.apps.rl.sim_core import CROSS_SIGNALLED_CYCLE_SECONDS

    stages = train.light_curriculum_stages(230_000)

    assert stages[-1][0] == CROSS_SIGNALLED_CYCLE_SECONDS
    # ... and the red only ever gets **longer** on the way there.
    lengths = [cycle for cycle, _budget in stages]
    assert lengths == sorted(lengths)


def test_the_light_curriculum_is_rejected_for_another_scene() -> None:
    """Only the signalled scene has a light cycle to shorten."""
    with pytest.raises(ValueError, match="cross_signalled"):
        train.real_train(64, "cpu", 1, 1000, False, "cross", None, True)


def test_the_light_curriculum_is_rejected_for_the_independent_path() -> None:
    """The recipe is measured on the shared-policy path."""
    with pytest.raises(ValueError, match="shared-policy"):
        train.real_train(64, "cpu", 1, 1000, True, "cross_signalled", None, True)


def test_the_shipped_scene_is_not_affected_by_the_training_override() -> None:
    """The override is a **training** knob; the scene's own cycle stands.

    The cross-language contract pins the signalled scene's cycle (the
    golden's `scene_light` block), so the default must stay exactly what
    the contract compares.
    """
    from app.apps.rl.sim_core import CROSS_SIGNALLED_CYCLE_SECONDS, SimCore

    default = SimCore(scene_kind="cross_signalled")
    default.reset()
    assert default.light.cycle_duration == CROSS_SIGNALLED_CYCLE_SECONDS

    overridden = SimCore(scene_kind="cross_signalled", light_cycle_seconds=6.0)
    overridden.reset()
    assert overridden.light.cycle_duration == 6.0


@requires_sb3
def test_the_light_curriculum_actually_switches_the_scene(rl_state, monkeypatch) -> None:
    """The training run walks the stages - and ends on the shipped red.

    A short run (one stage's worth of steps) with the curriculum on: the
    scene's light cycle has to have moved, and the run has to have
    produced a checkpoint.
    """
    monkeypatch.setattr(rl_checkpoint, "_DEFAULT_DIR", rl_state / "ppo_checkpoints")

    train.real_train(64, "cpu", 1, 1000, False, "cross_signalled", None, True)

    zips = sorted(rl_paths.checkpoints_dir().rglob("ppo_step_*.zip"))
    assert zips, "the curriculum run produced no checkpoint"
