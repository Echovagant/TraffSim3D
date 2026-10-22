"""`app/apps/rl/signal_train.py` — the signal agent's training entry point.

The smoke test is the training gate: train a **tiny** number of steps,
produce a checkpoint, export the weights, and assert the export is a
**discrete** five-action policy (no `log_std`).

The evaluation helpers are pinned too, because the numbers they produce are
the ones the trained policy is compared against:

- `evaluate_schedule` on `no_op` must reproduce the fixed 30/30 cycle's
  return (-423.1 over 600 steps) — the baseline a trained policy has to
  beat. If that number moves, the comparison itself is no longer valid.
- `evaluate_policy` must score a policy deterministically (the browser runs
  the argmax) and report the action histogram.

The multi-seed run is covered too:

- the "pick the best" logic is pinned on a known set of candidates;
- every seed's measured return has to be recorded — the seeds that
  collapsed onto the baseline included;
- the **evaluation set must be separate from the training set**: the policy
  is scored on a different initial condition, and the difference has to be
  a real one (a different scene, a different baseline), not a different
  RNG seed in a deterministic sim.
"""

from __future__ import annotations

import json
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
    """The fixed 30/30 cycle on the **open** traffic: -292.8 over 600 steps.

    This is the number measured on the open traffic and the gate the trained policy
    is compared against; if it moves, the comparison is meaningless.

    The closed loop's number was -423.1. The traffic
    changed, so the baseline changed with it - that is the point of the
    open-traffic model, and the reason the published numbers had to be
    rewritten rather than annotated.
    """
    result = signal_train.evaluate_schedule(signal_train.NO_OP_INDEX)
    assert result["steps"] == 600
    assert result["action"] == "no_op"
    assert result["return"] == pytest.approx(-292.8, abs=0.05)


def test_the_degenerate_schedules_are_worse_than_the_fixed_cycle() -> None:
    """The other constant actions must all score below the fixed cycle.

    These are the numbers measured on the open traffic
    (starve-one-axis -553.8, preempt -888.0). The flicker is **not** in
    this list any more: in the open model it is the *better* schedule
    (-260.8), because the delay is dominated by the red's duration rather
    than by the inter-green clearance - the same flip the closed loop
    had the other way round (in the closed loop: flicker -437.2 against the
    fixed cycle's -423.1).

    So the honest bar for a trained policy on the open traffic is the
    **strongest constant schedule** (the flicker), not the fixed cycle.
    """
    baseline = signal_train.evaluate_schedule(signal_train.NO_OP_INDEX)["return"]
    for name in ("extend_green", "preempt"):
        index = SIGNAL_ACTION_NAMES.index(name)
        result = signal_train.evaluate_schedule(index)
        assert result["return"] < baseline, f"{name} is not worse than the fixed cycle"

    flicker = signal_train.evaluate_schedule(SIGNAL_ACTION_NAMES.index("shorten_red"))["return"]
    assert flicker > baseline, (
        "the flicker is the strongest constant schedule on the open "
        f"traffic ({flicker} against {baseline})"
    )


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
    # The open traffic's fixed cycle: -292.8.
    assert result["return"] == pytest.approx(-292.8, abs=0.05)
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
    """THE SMOKE GATE: train a few steps -> checkpoint -> export -> discrete.

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
    # The open traffic's fixed-cycle baseline.
    assert "-292.8" in out


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


# --------------------------------------------------------------------------
# The multi-seed run
# --------------------------------------------------------------------------


def test_select_best_seed_picks_the_highest_return() -> None:
    """The "pick the best" logic: the highest measured return wins.

    The candidates and their returns are given, so the expectation is
    not a measurement — it is the rule.
    """
    records = [
        {"seed": 0, "eval_return": -520.3},
        {"seed": 1, "eval_return": -399.9},
        {"seed": 2, "eval_return": -560.1},
    ]

    best = signal_train.select_best_seed(records)

    assert best["seed"] == 1
    assert best["eval_return"] == -399.9


def test_select_best_seed_breaks_a_tie_by_the_earlier_candidate() -> None:
    """A tie must not depend on the order the seeds happened to finish in."""
    records = [
        {"seed": 7, "eval_return": -500.0},
        {"seed": 8, "eval_return": -500.0},
    ]

    assert signal_train.select_best_seed(records)["seed"] == 7


def test_select_best_seed_rejects_an_empty_candidate_list() -> None:
    with pytest.raises(ValueError):
        signal_train.select_best_seed([])


def test_the_training_condition_is_the_dense_scenario_of_t9() -> None:
    """The training condition must stay the scenario that was measured.

    Those numbers (-423.1 for the fixed cycle) were measured on the
    dense scenario; if the training condition drifted away from it, the
    baseline the trained policy is compared against would no longer be
    the published one.
    """
    from app.apps.rl import signal_env
    from app.apps.rl.signal_conditions import TRAIN_CONDITION

    assert TRAIN_CONDITION.ns_vehicles_per_lane == signal_env.DENSE_NS_VEHICLES_PER_LANE
    assert TRAIN_CONDITION.ew_vehicles_per_lane == signal_env.DENSE_EW_VEHICLES_PER_LANE
    assert TRAIN_CONDITION.stream_start == signal_env.DENSE_STREAM_START
    assert TRAIN_CONDITION.stream_spacing == signal_env.DENSE_STREAM_SPACING
    assert TRAIN_CONDITION.phase_offset == 0.0


def test_the_evaluation_condition_differs_from_the_training_condition() -> None:
    """The evaluation set must be a *different* initial condition.

    The sim is deterministic, so a different RNG seed changes nothing —
    the condition itself has to differ. The check is on the measured
    scene, not only on the declared numbers: a different number of
    vehicles, a different initial observation and a different fixed-cycle
    baseline.
    """
    from app.apps.rl.signal_conditions import EVAL_CONDITION, TRAIN_CONDITION

    assert EVAL_CONDITION != TRAIN_CONDITION
    assert EVAL_CONDITION.name != TRAIN_CONDITION.name

    train_env = signal_train.make_env(60, TRAIN_CONDITION)
    eval_env = signal_train.make_env(60, EVAL_CONDITION)
    train_obs, _ = train_env.reset(seed=0)
    eval_obs, _ = eval_env.reset(seed=0)

    # A different scene ...
    assert len(eval_env.core.npcs) != len(train_env.core.npcs)
    # ... a different observation ...
    assert train_obs.tolist() != eval_obs.tolist()
    # ... and a different fixed-cycle baseline to beat.
    train_base = signal_train.evaluate_schedule(
        signal_train.NO_OP_INDEX, condition=TRAIN_CONDITION
    )["return"]
    eval_base = signal_train.evaluate_schedule(signal_train.NO_OP_INDEX, condition=EVAL_CONDITION)[
        "return"
    ]
    assert train_base != eval_base
    # The open traffic's fixed cycle on the training condition.
    assert train_base == pytest.approx(-292.8, abs=0.05)
    # ... and the evaluation condition's own.
    assert eval_base == pytest.approx(-313.6, abs=0.05)


def test_the_multi_seed_run_records_every_seed(rl_state) -> None:
    """Every seed's result has to be recorded — the failures included.

    The multi-seed run is the delivery form of the procedure: it must not keep
    only the winner. Each record carries the seed's measured return and
    whether it beat the fixed cycle.
    """
    summary = signal_train.train_signal_seeds(
        64,
        seeds=[0, 1, 2],
        device="cpu",
        save_every=32,
        n_steps=32,
        batch_size=16,
        eval_every=32,
    )

    assert summary["trained"] is True
    records = summary["seed_results"]
    assert len(records) == 3
    assert [record["seed"] for record in records] == [0, 1, 2]
    for record in records:
        assert isinstance(record["eval_return"], float)
        assert isinstance(record["train_return"], float)
        assert record["beats_baseline"] in (True, False)
        assert record["best_step"] >= 0


@requires_sb3
def test_the_multi_seed_run_keeps_the_best_seed(rl_state) -> None:
    """The winner is the seed with the best measured evaluation return."""
    summary = signal_train.train_signal_seeds(
        64,
        seeds=[0, 1],
        device="cpu",
        save_every=32,
        n_steps=32,
        batch_size=16,
        eval_every=32,
    )

    records = summary["seed_results"]
    best = max(records, key=lambda record: record["eval_return"])
    assert summary["best_seed"] == best["seed"]
    assert summary["winner"]["eval_return"] == best["eval_return"]
    assert summary["best_return"] == best["eval_return"]


@requires_sb3
def test_the_multi_seed_run_writes_the_per_seed_results_into_the_metadata(
    rl_state,
) -> None:
    """The run's metadata must carry every seed, not only the winner."""
    summary = signal_train.train_signal_seeds(
        64,
        seeds=[0, 1],
        device="cpu",
        save_every=32,
        n_steps=32,
        batch_size=16,
        eval_every=32,
    )

    metadata_path = rl_paths.data_root() / "signal_training_run.json"
    assert metadata_path.exists()
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert [record["seed"] for record in metadata["per_seed"]] == [0, 1]
    assert metadata["best_seed"] == summary["best_seed"]
    # The conditions are recorded too — the metadata has to say what the
    # selection was made on.
    assert metadata["conditions"]["eval"]["name"] == "eval"
    assert metadata["conditions"]["train"]["name"] == "train"
    assert metadata["baselines"]["eval"] != metadata["baselines"]["train"]


@requires_sb3
def test_the_multi_seed_run_records_the_per_seed_results_in_the_status(
    rl_state,
) -> None:
    """The status document (what the API serves) carries every seed too."""
    signal_train.train_signal_seeds(
        64,
        seeds=[0, 1],
        device="cpu",
        save_every=32,
        n_steps=32,
        batch_size=16,
        eval_every=32,
    )

    status = rl_status.read_status()
    assert status["running"] is False
    assert [record["seed"] for record in status["signal_seed_results"]] == [0, 1]
    assert status["best_seed"] in (0, 1)
    assert status["latest_checkpoint"].endswith(".zip")


@requires_sb3
def test_the_multi_seed_run_keeps_one_checkpoint_per_seed(rl_state) -> None:
    """Each seed's policy survives on disk — the losers included."""
    signal_train.train_signal_seeds(
        64,
        seeds=[0, 1],
        device="cpu",
        save_every=32,
        n_steps=32,
        batch_size=16,
        eval_every=32,
    )

    zips = sorted(rl_paths.checkpoints_dir().rglob("signal_seed*.zip"))
    assert len(zips) == 2
    assert any("signal_seed0_" in path.name for path in zips)
    assert any("signal_seed1_" in path.name for path in zips)


@requires_sb3
def test_the_multi_seed_run_can_train_the_seeds_in_parallel(rl_state) -> None:
    """`workers > 1` trains one seed per process — the same result.

    The seeds are independent, so the parallel path must produce the
    same per-seed numbers as the sequential one.
    """
    summary = signal_train.train_signal_seeds(
        64,
        seeds=[0, 1],
        device="cpu",
        save_every=32,
        n_steps=32,
        batch_size=16,
        eval_every=32,
        workers=2,
    )

    assert summary["trained"] is True
    assert [record["seed"] for record in summary["seed_results"]] == [0, 1]
    for record in summary["seed_results"]:
        assert isinstance(record["eval_return"], float)
    # One checkpoint per seed, each in the directory of the process that
    # trained it.
    zips = sorted(rl_paths.checkpoints_dir().rglob("signal_seed*.zip"))
    assert len(zips) == 2


@requires_sb3
def test_the_multi_seed_cli_reports_every_seed(rl_state, monkeypatch, capsys) -> None:
    """The CLI prints every seed's number and names the winner."""
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "prog",
            "64",
            "--seeds",
            "0,1",
            "--device",
            "cpu",
            "--save-every",
            "32",
            "--eval-every",
            "32",
            "--n-steps",
            "32",
            "--batch-size",
            "16",
        ],
    )

    signal_train.main()

    out = capsys.readouterr().out
    assert "seed" in out
    # Both seeds are on the table — a failed seed is never hidden.
    assert "beats train" in out
    assert "beats eval" in out
    assert "best seed" in out
    assert "fixed cycle" in out
    assert "run metadata" in out
    assert list(rl_paths.checkpoints_dir().rglob("ppo_step_*.zip"))


# --------------------------------------------------------------------------
# The evaluation series
# --------------------------------------------------------------------------


def _point(step: int, value: float = -400.0) -> dict[str, object]:
    return {
        "step": step,
        "return": value,
        "baseline": -423.1,
        "condition": "train",
    }


def test_append_eval_point_appends_one_point_per_evaluation() -> None:
    """The series grows by exactly one point per evaluation."""
    series: list[dict[str, object]] = []
    for index in range(5):
        series = signal_train.append_eval_point(series, _point((index + 1) * 10))
        assert len(series) == index + 1

    assert [point["step"] for point in series] == [10, 20, 30, 40, 50]


def test_append_eval_point_bounds_the_series() -> None:
    """The series must not grow without limit.

    The bound is what keeps the status document the same order of magnitude
    no matter how long the run is — `reward_history` is bounded the same way.
    """
    series: list[dict[str, object]] = []
    for index in range(signal_train.EVAL_SERIES_MAX_POINTS + 25):
        series = signal_train.append_eval_point(series, _point(index))

    assert len(series) == signal_train.EVAL_SERIES_MAX_POINTS
    # The **newest** points are the ones that survive.
    assert series[-1]["step"] == signal_train.EVAL_SERIES_MAX_POINTS + 24
    assert series[0]["step"] == 25


def test_append_eval_point_does_not_mutate_the_series_it_is_given() -> None:
    original = [_point(10)]
    series = signal_train.append_eval_point(original, _point(20))
    assert len(original) == 1
    assert len(series) == 2


@requires_sb3
def test_the_training_run_appends_one_point_per_evaluation(rl_state) -> None:
    """One evaluation -> one point in the series.

    The run is chunked: every `eval_every` steps the deterministic policy is
    scored, and each of those scores has to land in the series — that is what
    turns a single overwritten number into a curve.
    """
    summary = signal_train.train_signal_policy(
        64,
        device="cpu",
        save_every=32,
        n_steps=32,
        batch_size=16,
        eval_every=32,
    )

    series = summary["eval_series"]
    assert [point["step"] for point in series] == [32, 64]
    assert all(point["condition"] == "train" for point in series)
    assert all(isinstance(point["return"], float) for point in series)

    # The status document — what `GET /api/v1/rl/status` serves — carries
    # the same curve.
    status = rl_status.read_status()
    assert status["signal_eval_series"] == series


@requires_sb3
def test_each_point_carries_the_baseline_of_its_own_condition(rl_state) -> None:
    """A point's baseline is the fixed cycle **on that point's condition**.

    The multi-seed run is explicit that two conditions' numbers are not
    comparable, so a point may never borrow another condition's baseline.
    The training condition's fixed cycle is -423.1 (the dense scenario); the
    held-out evaluation condition's is a different number.
    """
    from app.apps.rl.signal_conditions import EVAL_CONDITION

    signal_train.train_signal_policy(
        64,
        device="cpu",
        save_every=32,
        n_steps=32,
        batch_size=16,
        eval_every=32,
    )

    train_baseline = signal_train.evaluate_schedule(
        signal_train.NO_OP_INDEX, condition=signal_train.TRAIN_CONDITION
    )["return"]
    eval_baseline = signal_train.evaluate_schedule(
        signal_train.NO_OP_INDEX, condition=EVAL_CONDITION
    )["return"]
    assert train_baseline != eval_baseline

    series = rl_status.read_status()["signal_eval_series"]
    assert series
    for point in series:
        assert point["baseline"] == pytest.approx(train_baseline, abs=0.05)
        assert point["baseline"] != pytest.approx(eval_baseline, abs=0.05)


@requires_sb3
def test_the_multi_seed_run_publishes_the_curve_and_the_baselines(rl_state) -> None:
    """The multi-seed run's results have to be readable through the API.

    The status document is what `GET /api/v1/rl/status` serves, so the curve
    and the per-seed results belong there: a sidecar file under `.data/`
    would not be reachable by the UI.
    """
    summary = signal_train.train_signal_seeds(
        64,
        seeds=[0, 1],
        device="cpu",
        save_every=32,
        n_steps=32,
        batch_size=16,
        eval_every=32,
    )

    status = rl_status.read_status()
    # The delivered policy's curve ...
    assert status["signal_eval_series"] == summary["winner"]["eval_series"]
    assert status["signal_eval_series"]
    # ... the fixed cycle of every condition the run reports on ...
    assert set(status["signal_baselines"]) == {"train", "eval", "holdout"}
    assert status["signal_baselines"]["train"] != status["signal_baselines"]["eval"]
    # ... and every seed, with its own curve. A failed seed is not hidden.
    assert [record["seed"] for record in status["signal_seed_results"]] == [0, 1]
    for record in status["signal_seed_results"]:
        assert record["eval_series"]
