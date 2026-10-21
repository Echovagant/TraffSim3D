"""`app/apps/rl/ego_eval.py` — the ego's gate: the trained policy against the
constant-throttle baselines.

The signal agent's gate is `signal_train.evaluate_policy` against
`signal_train.evaluate_schedule`: the same env, the same horizon, the same
initial state. The ego's gate is the same shape, except that the ego's action
space is a `Box(-1, 1, 2)` — `action[0]` is the throttle, `action[1]` is the
steering command — so the baseline is "always command X on the throttle
channel".

The numbers pinned here are the ones the trained ego policy is measured
against. If they move, the comparison in the training report is meaningless
until they are re-measured — the same rule the signal agent's fixed-cycle
baseline follows (`test_rl_signal_train.py`).

The ego scenes are **deterministic**: `SimCore._reset_*` hard-codes the NPC
placement and never draws from a random source, so the seed changes nothing
and one episode *is* the population.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.apps.rl import ego_eval

#: The `cross` scene's full-throttle baseline: 58 steps, the success bonus,
#: and the progress reward. Measured, not derived.
FULL_THROTTLE_RETURN = 59.101
#: Zero throttle: the ego never moves and is rear-ended by the NPC that
#: respawns on its lane.
ZERO_THROTTLE_RETURN = -8.050
#: The best constant throttle on a 0.025 grid: slow enough to collect the
#: per-step alive bonus, fast enough to stay ahead of that NPC.
BEST_CONSTANT_THROTTLE = 0.35
BEST_CONSTANT_RETURN = 60.8355


class _ConstantThrottlePolicy:
    """A stand-in policy: always commands the same throttle.

    It has no `observation_space`, so the harness feeds it the flat
    observation — exactly like a policy trained on a plain `TrafficEnv`.
    """

    def __init__(self, throttle: float) -> None:
        self.throttle = throttle
        self.calls = 0

    def predict(self, _obs, deterministic: bool = False):  # noqa: ANN001, ANN201
        self.calls += 1
        return np.array([self.throttle, 0.0], dtype=np.float32), None


# --------------------------------------------------------------------------
# The baselines the trained policy is compared against
# --------------------------------------------------------------------------


def test_the_full_throttle_baseline_scores_the_measured_value() -> None:
    """Full throttle reaches the goal in 58 steps: 59.101.

    This is the baseline the trained policy has to beat. It moves the moment
    the reward, the scene or the ego kinematics move, so it is pinned.
    """
    result = ego_eval.evaluate_constant_throttle(1.0, scene_kind="cross")

    assert result["return"] == pytest.approx(FULL_THROTTLE_RETURN, abs=0.005)
    assert result["steps"] == 58
    assert result["reason"] == "success"


def test_the_zero_throttle_baseline_is_rear_ended() -> None:
    """Zero throttle scores -8.050: the ego never moves and is hit.

    The reference point of the other end of the throttle range — and the
    clearest evidence that the scene has a real failure mode.
    """
    result = ego_eval.evaluate_constant_throttle(0.0, scene_kind="cross")

    assert result["return"] == pytest.approx(ZERO_THROTTLE_RETURN, abs=0.005)
    assert result["steps"] == 39
    assert result["reason"] == "collision"


def test_a_slower_constant_throttle_beats_full_throttle() -> None:
    """The gate is winnable: a constant throttle of 0.35 scores 60.84.

    The per-step alive bonus (0.05) means that a *slower* ego that still
    arrives collects more reward than a fast one — so full throttle is **not**
    the optimum of this reward, and a trained policy has something to beat
    beyond "accelerate".
    """
    best = ego_eval.evaluate_constant_throttle(BEST_CONSTANT_THROTTLE, scene_kind="cross")

    assert best["return"] == pytest.approx(BEST_CONSTANT_RETURN, abs=0.005)
    assert best["return"] > FULL_THROTTLE_RETURN
    assert best["reason"] == "success"


def test_the_sweep_finds_that_optimum() -> None:
    """The whole constant-throttle grid: the best of it is 0.35 / 60.84."""
    sweep = ego_eval.evaluate_sweep(scene_kind="cross", resolution=40)

    best = max(sweep, key=lambda item: item["return"])
    assert best["throttle"] == pytest.approx(BEST_CONSTANT_THROTTLE, abs=0.025)
    assert best["return"] == pytest.approx(BEST_CONSTANT_RETURN, abs=0.01)
    # Full throttle is on the grid and is *not* the optimum.
    full = next(item for item in sweep if item["throttle"] == pytest.approx(1.0))
    assert full["return"] == pytest.approx(FULL_THROTTLE_RETURN, abs=0.005)


def test_the_throttle_landscape_has_a_collision_cliff() -> None:
    """Below ~0.33 the ego is rear-ended; above it, it arrives.

    The NPC that respawns on the ego's lane drives into it at 8 m/s, so a
    slow ego is hit from behind. The cliff is what puts the optimum where it
    is: the slowest throttle that still clears the NPC.
    """
    slow = ego_eval.evaluate_constant_throttle(0.30, scene_kind="cross")
    fast = ego_eval.evaluate_constant_throttle(0.35, scene_kind="cross")

    assert slow["reason"] == "collision"
    assert fast["reason"] == "success"


# --------------------------------------------------------------------------
# The evaluation harness itself
# --------------------------------------------------------------------------


def test_the_scene_is_deterministic_across_seeds() -> None:
    """The seed changes nothing: one episode is the whole population.

    `SimCore._reset_*` hard-codes the NPC placement, so a "held-out seed"
    would be the same episode — which is why the ego has no train/eval
    condition split the way the signal agent has one.
    """
    returns = [
        ego_eval.evaluate_constant_throttle(1.0, scene_kind="cross", seed=seed)["return"]
        for seed in (0, 1, 7)
    ]

    assert returns[0] == pytest.approx(returns[1])
    assert returns[1] == pytest.approx(returns[2])


def test_evaluate_policy_and_the_constant_baseline_agree() -> None:
    """A policy that commands a constant throttle scores the baseline.

    The two paths must be the same measurement: the trained policy is scored
    through `evaluate_policy`, the baseline through
    `evaluate_constant_throttle`, and they may only differ by the policy.
    """
    baseline = ego_eval.evaluate_constant_throttle(0.5, scene_kind="cross")
    policy = ego_eval.evaluate_policy(_ConstantThrottlePolicy(0.5), scene_kind="cross")

    assert policy["return"] == pytest.approx(baseline["return"], abs=1e-6)
    assert policy["steps"] == baseline["steps"]
    assert policy["reason"] == baseline["reason"]


def test_evaluate_policy_reports_the_throttle_distribution() -> None:
    """The report needs the action distribution, not just the return."""
    policy = ego_eval.evaluate_policy(_ConstantThrottlePolicy(0.5), scene_kind="cross")

    assert policy["throttle_mean"] == pytest.approx(0.5, abs=1e-6)
    assert policy["throttle_min"] == pytest.approx(0.5, abs=1e-6)
    assert policy["throttle_max"] == pytest.approx(0.5, abs=1e-6)
    assert policy["throttle_full_share"] == 0.0
    assert sum(policy["throttle_histogram"].values()) == policy["steps"]


def test_the_steer_channel_never_reaches_the_sim() -> None:
    """The sim reads `action[0]` only: the steering command is inert.

    `SimCore.step` computes the steer itself, with Pure Pursuit, and never
    reads `action[1]`. A policy trained in this environment therefore
    modulates the **throttle**; the steering is scripted. The test pins that
    fact so a change to it cannot happen silently.
    """
    from app.apps.rl.env import TrafficEnv

    def run(steer: float) -> list[tuple[float, float, float]]:
        env = TrafficEnv(max_steps=200, scene_kind="cross")
        env.reset(seed=0)
        trace: list[tuple[float, float, float]] = []
        for _ in range(58):
            obs, _reward, terminated, truncated, _info = env.step(
                np.array([1.0, steer], dtype=np.float32)
            )
            trace.append((env.core.ego.x, env.core.ego.z, env.core.ego.heading))
            if terminated or truncated:
                break
        return trace

    assert run(-1.0) == run(1.0)
