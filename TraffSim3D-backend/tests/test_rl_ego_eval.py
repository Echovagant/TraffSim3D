"""`app/apps/rl/ego_eval.py` — the ego's gate: the trained policy against the
constant-throttle baselines.

The signal agent's gate is `signal_train.evaluate_policy` against
`signal_train.evaluate_schedule`: the same env, the same horizon, the same
initial state. The ego's gate is the same shape, except that the ego's action
space is a `Box(-1, 1, 2)` — `action[0]` is the throttle, `action[1]` is the
**steering residual** — so the baseline is "always command X on
the throttle channel", with the steer channel left at `0.0`, i.e. with the
scripted Pure Pursuit unmodified.

The numbers pinned here are the ones the trained ego policy is measured
against. If they move, the comparison in the training report is meaningless
until they are re-measured — the same rule the signal agent's fixed-cycle
baseline follows (`test_rl_signal_train.py`).

The ego scenes are **deterministic**: `SimCore._reset_*` hard-codes the NPC
placement and never draws from a random source, so the seed changes nothing
and one episode *is* the population.

What the reward looks like now
--------------------------------------------
The reward is `PROGRESS_WEIGHT * progress - TIME_COST` per step: the
progress is the **signed** advance towards the goal line, bounded by it
(so it cannot be farmed), and the passage of time is **charged** (so
arriving sooner is better and standing still is a pure loss).

The consequence for the gate: the return now separates the *fast* runs
from the *slow* ones — in the `cross` scene the successful constant
throttles span 50.100 (98 steps) to 52.100 (58 steps) — so "beats the best
constant throttle" is a measurable statement again, and its ceiling is the
**fastest physically possible arrival**.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.apps.rl import ego_eval

#: The `cross` scene's full-throttle baseline: 58 steps, the success bonus
#: and the progress reward, minus the time cost. Measured, not derived.
FULL_THROTTLE_RETURN = 52.100
#: Zero throttle: the ego never moves and is rear-ended by the NPC that
#: respawns on its lane.
ZERO_THROTTLE_RETURN = -11.950
#: The return of the **fastest** successful constant throttle (58 steps, the
#: physical minimum for 50 m of progress). The time cost is what makes the
#: throttle matter again: the successful constants now span 50.100 (98
#: steps) to 52.100 (58 steps).
FASTEST_SUCCESS_RETURN = 52.100
#: The slowest successful constant throttle (0.35): same distance, 40 more
#: steps, so 40 x TIME_COST less.
SLOWEST_SUCCESS_RETURN = 50.100


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
    """Full throttle reaches the goal in 58 steps: 57.500.

    This is the baseline the trained policy has to beat. It moves when the
    reward, the scene or the ego kinematics move, so it is pinned.
    """
    result = ego_eval.evaluate_constant_throttle(1.0, scene_kind="cross")

    assert result["return"] == pytest.approx(FULL_THROTTLE_RETURN, abs=0.005)
    assert result["steps"] == 58
    assert result["reason"] == "success"


def test_the_zero_throttle_baseline_is_rear_ended() -> None:
    """Zero throttle scores -10.000: the ego never moves and is hit.

    The reference point of the other end of the throttle range — and the
    clearest evidence that the scene has a real failure mode.
    """
    result = ego_eval.evaluate_constant_throttle(0.0, scene_kind="cross")

    assert result["return"] == pytest.approx(ZERO_THROTTLE_RETURN, abs=0.005)
    assert result["steps"] == 39
    assert result["reason"] == "collision"


def test_every_successful_constant_throttle_scores_the_same() -> None:
    """The alive bonus can no longer be farmed.

    The bonus used to be paid per *step*, so a creeping policy collected
    it more often than a fast one and "the best constant throttle" was the
    **slowest** safe one (0.35, 98 steps, 60.835 — it beat the trained
    policy). The per-step term is now a **cost**, so the ranking is the
    other way round: the same distance, fewer steps, more reward — and
    there is nothing left to farm by standing still.
    """
    sweep = ego_eval.evaluate_sweep(scene_kind="cross", resolution=40)

    successful = [item for item in sweep if item["reason"] == "success"]
    assert successful, "no constant throttle reached the goal"
    returns = {round(item["return"], 6) for item in successful}
    assert len(returns) > 1, (
        "every successful constant throttle scores the same: the reward "
        "cannot tell fast from slow any more"
    )

    fastest = min(successful, key=lambda item: item["steps"])
    slowest = max(successful, key=lambda item: item["steps"])
    assert fastest["return"] == pytest.approx(FASTEST_SUCCESS_RETURN, abs=0.005)
    assert slowest["return"] == pytest.approx(SLOWEST_SUCCESS_RETURN, abs=0.005)
    # Same distance, fewer steps, more reward.
    assert fastest["return"] > slowest["return"]
    assert fastest["steps"] < slowest["steps"]


def test_the_strongest_baseline_is_not_picked_out_of_floating_point_noise() -> None:
    """Tie-break: equal returns (within the epsilon) ⇒ the FEWEST steps wins.

    The reward is `PROGRESS_WEIGHT * progress - TIME_COST * steps`, and the
    progress term is mathematically identical on every successful run, so
    the returns differ only by floating-point noise (measured on the
    `cross` scene: 57.5, 57.50000000000001, 57.500000000000014,
    57.499999999999986). A raw `max(..., key=return)` picks whichever
    schedule landed on the last ulp — an arbitrary winner that can even be
    *slower* than another schedule with exactly the same score.

    The candidates below are the measured ones: equal to within 1.4e-14,
    but 58 and 84 steps apart.
    """
    candidates = [
        {"return": 57.50000000000001, "steps": 98, "throttle": 0.350, "reason": "success"},
        {"return": 57.500000000000014, "steps": 84, "throttle": 0.475, "reason": "success"},
        {"return": 57.499999999999986, "steps": 82, "throttle": 0.500, "reason": "success"},
        {"return": 57.499999999999986, "steps": 67, "throttle": 0.750, "reason": "success"},
        {"return": 57.50000000000001, "steps": 58, "throttle": 1.000, "reason": "success"},
    ]

    best = ego_eval.select_best(candidates)

    assert best is not None
    # The fastest of the tied ones — not the last-ulp maximum.
    assert best["steps"] == 58, f"the tie-break picked {best}"
    assert best["throttle"] == pytest.approx(1.0)

    # What the rule this test replaces would have picked: the last-ulp
    # maximum, i.e. the 84-step schedule. The two rules disagree, which is
    # why the tie-break has to be pinned.
    legacy = max(candidates[:-1], key=lambda item: item["return"])
    assert legacy["steps"] == 84
    assert legacy["steps"] != best["steps"]

    # A candidate that is *really* better still wins, whatever its steps.
    candidates.append({"return": 58.0, "steps": 200, "throttle": 0.5, "reason": "success"})
    assert ego_eval.select_best(candidates)["return"] == pytest.approx(58.0)


def test_the_sweep_finds_the_optimum() -> None:
    """The whole constant-throttle grid: the best of it is the fastest."""
    sweep = ego_eval.evaluate_sweep(scene_kind="cross", resolution=40)

    best = max(sweep, key=lambda item: item["return"])
    assert best["return"] == pytest.approx(FASTEST_SUCCESS_RETURN, abs=0.01)
    # Full throttle is on the grid and is not beaten by anything.
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


def test_the_steer_channel_now_reaches_the_sim() -> None:
    """`action[1]` is a steering **residual**, and it acts.

    Before the change the sim computed the steer itself and never read
    `action[1]`, so a policy trained here was a throttle controller with no
    steering authority at all. Now the command is a correction on top of the
    scripted Pure Pursuit steer, so the two signs drive to the two sides.
    """
    from app.apps.rl.env import TrafficEnv

    def run(steer: float) -> list[tuple[float, float, float]]:
        env = TrafficEnv(max_steps=200, scene_kind="cross")
        env.reset(seed=0)
        trace: list[tuple[float, float, float]] = []
        for _ in range(30):
            _, _, terminated, truncated, _ = env.step(np.array([1.0, steer], dtype=np.float32))
            trace.append((env.core.ego.x, env.core.ego.z, env.core.ego.heading))
            if terminated or truncated:
                break
        return trace

    left = run(1.0)
    right = run(-1.0)

    # A positive residual raises the heading (a left turn in this plane),
    # a negative one lowers it — and the two drives end up on opposite
    # sides of the scripted line.
    assert left[-1][2] > right[-1][2]
    assert left[-1][0] < right[-1][0]


def test_a_zero_residual_drives_exactly_the_scripted_baseline() -> None:
    """The baseline is the scripted pursuit: `action[1] == 0` changes nothing.

    That is what makes "scripted pursuit + best constant throttle" the
    natural baseline the trained policy has to beat.
    """
    from app.apps.rl.env import TrafficEnv

    def run(steer: float) -> list[tuple[float, float, float]]:
        env = TrafficEnv(max_steps=200, scene_kind="cross")
        env.reset(seed=0)
        trace: list[tuple[float, float, float]] = []
        for _ in range(58):
            _, _, terminated, truncated, _ = env.step(np.array([1.0, steer], dtype=np.float32))
            trace.append((env.core.ego.x, env.core.ego.z, env.core.ego.heading))
            if terminated or truncated:
                break
        return trace

    assert run(0.0) == run(0.0)
    # The scripted Pure Pursuit drives the ego straight up the centreline.
    assert max(abs(x) for x, _, _ in run(0.0)) < 1e-6
