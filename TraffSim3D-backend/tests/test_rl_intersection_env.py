"""The unsignalised-intersection environment and its baselines.

What is pinned here:

1. **The scenario is a junction without lights.** That is the whole
   point: the right of way has to be negotiated, not given by a phase.
2. **The reward charges the blocker.** A driver that holds up the
   traffic behind it pays for that traffic's waiting time — that is
   what makes the reward cooperative.
3. **The baselines are the yardstick.** "The learned policy is better
   than nothing" is not a result, so both a do-nothing-yield baseline
   and the classical rule are measured on the same seeds.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.apps.rl.drive_core import ACTION_DIM_DRIVE, OBS_DIM_DRIVE
from app.apps.rl.intersection_env import (
    IntersectionEnv,
    build_unsignalised_junction_network,
    evaluate_baseline,
)


def test_the_junction_has_no_traffic_lights() -> None:
    network = build_unsignalised_junction_network()
    assert len(network["intersections"]) == 1
    assert network["intersections"][0]["trafficLights"] == []
    # Four arms: an incoming and an outgoing road each.
    assert len(network["roads"]) == 8


def test_the_observation_and_action_spaces_match_the_core() -> None:
    env = IntersectionEnv(n_agents=3, n_npcs=1)
    assert env.observation_space.shape == (3, OBS_DIM_DRIVE)
    assert env.action_space.shape == (3, ACTION_DIM_DRIVE)
    assert env.action_space.low.min() == -1.0
    assert env.action_space.high.max() == 1.0


def test_reset_returns_finite_observations() -> None:
    env = IntersectionEnv()
    obs, info = env.reset(seed=0)
    assert obs.shape == (3, OBS_DIM_DRIVE)
    assert np.all(np.isfinite(obs))
    assert info["agents"] == 3


def test_a_step_returns_one_reward_per_driver() -> None:
    env = IntersectionEnv()
    env.reset(seed=0)
    obs, rewards, terminated, truncated, info = env.step(np.zeros((3, 2), np.float32))
    assert rewards.shape == (3,)
    assert np.all(np.isfinite(rewards))
    assert not terminated and not truncated
    assert "conflicts" in info and "collisions" in info


def test_the_reward_charges_the_blocker_for_the_wait_it_causes() -> None:
    """The cooperation gradient, measured on the reward itself."""
    # Two AGENTS: the scripted traffic (the NPCs) is not lane-locked —
    # only the learned drivers are — so the scenario has to be set up
    # between two of them.
    env = IntersectionEnv(n_agents=2, n_npcs=0)
    env.reset(seed=0)
    leader = env.core.agents[0]
    follower = env.core.agents[1]
    # The follower is 8 m BEHIND the leader on the same arm.
    #
    # The position cannot simply be written: the drivers are
    # **lane-locked** (their position IS their lane point), so the
    # scenario is set up through the route and the arc length.
    follower.route = leader.route
    follower.current_seg_idx = leader.current_seg_idx
    follower.seg_t = max(0.0, leader.seg_t - 8.0)
    # The heading too: the blocker's search is a SPATIAL cone ahead of
    # the waiting driver, and the follower's heading still pointed along
    # the arm it was born on.
    follower.heading = leader.heading
    follower.speed = 0.0
    leader.speed = 0.0

    _obs, rewards, _term, _trunc, _info = env.step(np.zeros((2, 2), np.float32))

    # The follower pays for its own wait ...
    assert follower.delay_increment > 0.0
    # ... and the leader pays for the wait it caused.
    assert leader.caused_delay_increment > 0.0
    assert rewards[0] < 0.0


def test_a_conflict_is_penalised() -> None:
    env = IntersectionEnv(n_agents=2, n_npcs=0)
    env.reset(seed=0)
    first = env.core.agents[0]
    second = env.core.agents[1]
    # Both drivers AT the junction. Their positions are lane-locked, so
    # the scenario is set up by putting them at the end of their
    # approach (the junction's box reaches 6 m).
    for agent in (first, second):
        segment = env.core.graph.segments[agent.route.segment_ids[0]]
        agent.seg_t = segment.length - 2.0
        agent.speed = 0.0

    _obs, rewards, _term, _tr, info = env.step(np.zeros((2, 2), np.float32))

    assert info["conflicts"] >= 1
    assert rewards[0] < 0.0 and rewards[1] < 0.0


def test_the_always_go_baseline_gets_through_and_crashes() -> None:
    """The do-nothing-yield baseline: fast, and it collides."""
    result = evaluate_baseline("always_go", seeds=(0, 1, 2))
    assert result["collisions"] > 0, "nobody collided — the baseline is not a baseline"
    assert result["finished"] == result["agents"] * result["seeds"]


def test_the_right_of_way_baseline_is_slower_than_always_go() -> None:
    """Yielding costs time — that is the trade the policy has to beat."""
    always = evaluate_baseline("always_go", seeds=(0, 1, 2))
    rule = evaluate_baseline("right_of_way", seeds=(0, 1, 2))
    assert rule["delay"] > always["delay"]


def test_an_unknown_baseline_is_refused() -> None:
    with pytest.raises(ValueError):
        IntersectionEnv(baseline="drive_on_the_left")


def test_the_env_does_not_import_the_contract_core() -> None:
    import pathlib

    for name in ("intersection_env.py", "drive_mappo.py"):
        source = pathlib.Path(f"app/apps/rl/{name}").read_text(encoding="utf-8")
        assert "from .sim_core" not in source
        assert "import sim_core" not in source
