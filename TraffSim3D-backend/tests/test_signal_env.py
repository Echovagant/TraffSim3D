"""Plan 074 Sprint 3 (S3a-2): the signal agent's environment.

The gate that matters here is the **counterfactual reward test**: from
the same initial state, a schedule that serves both axes must score
better than a schedule that only ever serves one. If the two came out
equal (or reversed), the reward would not be pricing the *cross-axis*
delay and Plan 074 §2 D2 would not be met — the agent would learn to
starve the opposite axis.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.apps.rl.signal_env import MAX_QUEUE, SIG_OBS_DIM, SignalEnv
from app.apps.rl.sim_core import (
    DT,
    NPC_SPEED,
    SIGNAL_ACTION_NAMES,
    SimCore,
    Vehicle,
)

# The action index is the position in `SIGNAL_ACTION_NAMES` — the order
# is part of the cross-language contract.
ACTION_INDEX = {name: index for index, name in enumerate(SIGNAL_ACTION_NAMES)}


def _run(schedule: list[int], steps: int = 600) -> tuple[float, dict]:
    """Run a fixed action schedule from the default initial state."""
    env = SignalEnv(max_steps=steps)
    env.reset(seed=0)
    total = 0.0
    info: dict = {}
    for index in schedule:
        _, reward, terminated, truncated, info = env.step(index)
        total += reward
        if terminated or truncated:
            break
    return total, info


def test_the_env_turns_on_the_responsive_traffic_but_the_core_default_does_not() -> None:
    """The responsive traffic is opt-in: the contract vectors keep
    running the default path, which must stay bit-identical."""
    assert SimCore().responsive_traffic is False
    env = SignalEnv()
    assert env.core.responsive_traffic is True


def test_the_observation_has_the_planned_shape_and_stays_in_range() -> None:
    env = SignalEnv(max_steps=40)
    obs, _ = env.reset(seed=0)

    assert obs.shape == (SIG_OBS_DIM,)
    assert obs.dtype == np.float32
    assert env.observation_space.contains(obs)

    for index in range(len(SIGNAL_ACTION_NAMES)):
        obs, reward, terminated, truncated, _ = env.step(index)
        assert env.observation_space.contains(obs), f"action {index} left the observation box"
        assert reward <= 0.0, "the reward is a negative delay"


def test_the_action_index_maps_to_the_signal_action_names_in_order() -> None:
    """The mapping is the *position* in `SIGNAL_ACTION_NAMES` — the order
    is a cross-language contract, not an implementation detail."""
    assert SIGNAL_ACTION_NAMES == (
        "extend_green",
        "shorten_red",
        "preempt",
        "force_all_red",
        "no_op",
    )
    env = SignalEnv(max_steps=40)
    env.reset(seed=0)

    for index, name in enumerate(SIGNAL_ACTION_NAMES):
        _, _, _, _, info = env.step(index)
        assert info["action"] == name
        assert ACTION_INDEX[name] == index


def test_the_chosen_action_really_reaches_the_light() -> None:
    """`preempt` puts the light into the all-red clearance — the
    observation must show it (idx 4)."""
    env = SignalEnv(max_steps=40)
    env.reset(seed=0)

    env.step(ACTION_INDEX["preempt"])
    obs = env._obs()
    assert obs[2] == 0.0, "the NS axis must not be green"
    assert obs[3] == 0.0, "the EW axis must not be green"
    assert obs[4] == 1.0, "both axes stopped = all-red"


def test_the_observation_layout_matches_the_plan() -> None:
    """Plan 074 §2 D1, index by index."""
    env = SignalEnv(max_steps=40)
    env.reset(seed=0)

    # Two vehicles queue up on the NS axis, the EW road stays empty.
    env.core.npcs = [
        Vehicle(x=0.0, z=-20.0, heading=np.pi / 2, speed=NPC_SPEED),
        Vehicle(x=0.0, z=-30.0, heading=np.pi / 2, speed=NPC_SPEED),
    ]
    env.core.light.ns_green = False
    env.core.light.ew_green = True
    for _ in range(60):
        env.core.light.ns_green = False
        env.core.light.ew_green = True
        env.core.light.cycle_timer = 0.0
        env.step(ACTION_INDEX["no_op"])

    obs = env._obs()
    assert obs[0] == pytest.approx(2 / MAX_QUEUE), "idx 0: NS queue / MAX_QUEUE"
    assert obs[1] == 0.0, "idx 1: EW queue / MAX_QUEUE"
    assert obs[2] == 0.0, "idx 2: NS has right of way"
    assert obs[3] == 1.0, "idx 3: EW has right of way"
    assert obs[4] == 0.0, "idx 4: not all-red"

    # idx 5: the phase clock, as a fraction of the cycle duration.
    env.core.light.cycle_timer = 15.0
    assert env._obs()[5] == pytest.approx(0.5)
    env.core.light.cycle_timer = 0.0
    assert env._obs()[5] == pytest.approx(0.0)


def test_the_reward_is_the_negative_delay() -> None:
    """The reward is the negative area under the queue curve."""
    env = SignalEnv(max_steps=40)
    env.reset(seed=0)

    _, reward, _, _, info = env.step(ACTION_INDEX["no_op"])
    assert reward == pytest.approx(-(info["queue_ns"] + info["queue_ew"]) * DT)
    assert reward <= 0.0


def test_serving_both_axes_beats_starving_one_axis() -> None:
    """The counterfactual gate (Plan 074 §2 D2).

    Both schedules start from the same initial state:

    * "serve both" shortens the red on every step, so the phase turns
      over and neither axis is starved;
    * "serve one axis" extends the green on every step, so the green is
      held for the whole episode and the cross traffic waits.

    The second one must score *worse*. The reward therefore has to price
    the cross-axis delay — otherwise "extend forever" would be optimal,
    which is exactly the residual risk D2 was written to mitigate.
    """
    serve_both, both_info = _run([ACTION_INDEX["shorten_red"]] * 600)
    serve_one, one_info = _run([ACTION_INDEX["extend_green"]] * 600)

    assert serve_both > serve_one, (
        f"the schedule that starves one axis must score worse "
        f"(serve_both={serve_both}, serve_one={serve_one})"
    )
    # The mechanism behind the number: it is the *cross* axis that pays.
    assert one_info["queue_ew"] > 0, "the starved axis must be queued"
    assert both_info["queue_ew"] == 0, "the served axes must not queue"

    # A less extreme "serve both" schedule must beat it as well, so the
    # result does not hinge on one particular action pattern.
    moderate = [
        ACTION_INDEX["shorten_red"] if i % 10 == 0 else ACTION_INDEX["no_op"] for i in range(600)
    ]
    moderate_return, _ = _run(moderate)
    assert moderate_return > serve_one


def test_the_episode_ends_with_the_step_limit() -> None:
    """The signal agent has no success condition of its own: the episode
    ends by truncation."""
    env = SignalEnv(max_steps=25)
    env.reset(seed=0)

    truncated = False
    for _ in range(25):
        _, _, terminated, truncated, _ = env.step(ACTION_INDEX["no_op"])
        if terminated:
            break
    assert truncated is True


def test_an_out_of_range_action_is_rejected() -> None:
    env = SignalEnv(max_steps=10)
    env.reset(seed=0)

    with pytest.raises(ValueError):
        env.step(len(SIGNAL_ACTION_NAMES))
