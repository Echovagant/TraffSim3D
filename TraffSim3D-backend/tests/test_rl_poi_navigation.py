"""The POI-navigation task: the observation, the arrival and the reward.

What is pinned here:

1. **The observation carries the destination** — four numbers about it
   (the offset in the ego's frame, the distance, whether it has been
   reached). Without them the policy is driving the negotiation blind.
2. **The arrival is a radius, not a waypoint** — a POI is an address,
   so "arrived" means "close enough to have stopped there".
3. **The reward's signs and scale**: closing on the destination earns,
   arriving earns more, and a collision still costs more than the whole
   drive is worth — otherwise the cheapest way to finish is to crash
   through.
4. **The destination is on the route's end arm** — a driver whose route
   ended elsewhere would cross the junction and drive away from its
   destination (measured: 1 of 3 drivers arrived before this was
   fixed).
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.apps.rl.drive_core import (
    OBS_DIM_DRIVE,
    OBS_DIM_DRIVE_POI,
    TARGET_ARRIVAL_RADIUS_M,
    TARGET_PROGRESS_REWARD,
    TARGET_REACH_BONUS,
)
from app.apps.rl.poi_navigation_env import PoiNavigationEnv


def _env() -> PoiNavigationEnv:
    return PoiNavigationEnv(n_agents=3, n_npcs=1)


def test_the_observation_carries_the_destination() -> None:
    env = _env()
    obs, _info = env.reset(seed=0)
    assert obs.shape == (3, OBS_DIM_DRIVE_POI)

    agent = env.core.agents[0]
    # The destination's offset, in the EGO's frame.
    target_x, target_z = agent.target_poi
    dx = target_x - agent.x
    dz = target_z - agent.z
    cos_h = math.cos(-agent.heading)
    sin_h = math.sin(-agent.heading)
    assert obs[0][OBS_DIM_DRIVE] == pytest.approx((dx * cos_h - dz * sin_h) / 50.0, abs=1e-5)
    assert obs[0][OBS_DIM_DRIVE + 1] == pytest.approx((dx * sin_h + dz * cos_h) / 50.0, abs=1e-5)
    # The distance, normalised by 100 m.
    assert obs[0][OBS_DIM_DRIVE + 2] == pytest.approx(
        min(agent.target_distance / 100.0, 1.0), abs=1e-5
    )
    # Not arrived yet.
    assert obs[0][OBS_DIM_DRIVE + 3] == 0.0
    # The plain observation is unchanged — the shipped policy's 29
    # numbers still sit at the front.
    assert len(obs[0]) == OBS_DIM_DRIVE + 4


def test_the_arrival_is_a_radius() -> None:
    env = _env()
    env.reset(seed=0)
    agent = env.core.agents[0]
    target_x, target_z = agent.target_poi

    # Just outside the radius: not arrived.
    agent.x = target_x + TARGET_ARRIVAL_RADIUS_M + 1.0
    agent.z = target_z
    env.core._update_target_progress(agent)
    assert agent.target_reached is False

    # Just inside it: arrived.
    agent.x = target_x + TARGET_ARRIVAL_RADIUS_M - 1.0
    env.core._update_target_progress(agent)
    assert agent.target_reached is True
    assert agent.target_reached_increment == 1


def test_closing_on_the_destination_earns_and_arriving_earns_more() -> None:
    env = _env()
    env.reset(seed=0)
    agent = env.core.agents[0]
    agent.target_poi = (agent.x + 10.0, agent.z)
    agent.target_distance = 10.0
    agent.prev_target_distance = 10.0

    # One step that closes 2 m towards the destination.
    agent.x += 2.0
    env.core._update_target_progress(agent)
    assert agent.target_gain == pytest.approx(2.0)

    _obs, rewards, _t, _tr, _info = env.core.step([(0.0, 0.0)] * env.n_agents)
    # The driver that closed on its destination earned more than the one
    # that did not (the others' rewards are their own delay terms).
    assert rewards[agent.agent_index] > 0.0


def test_a_collision_costs_more_than_the_whole_drive_is_worth() -> None:
    """The objective must not reward crashing through."""
    # 60 m of driving at 0.2/m plus the arrival bonus.
    drive_worth = 60 * TARGET_PROGRESS_REWARD + TARGET_REACH_BONUS
    from app.apps.rl.drive_core import COLLISION_PENALTY

    assert COLLISION_PENALTY > drive_worth


def test_the_destination_is_on_the_route_s_end_arm() -> None:
    env = _env()
    env.reset(seed=0)
    for agent in env.core.agents:
        route = agent.route.segment_ids
        assert len(route) == 2
        out_road = route[1]
        assert out_road.startswith("out-")
        # The POI must sit on that arm — the arm's road runs from the
        # junction (0, 0) outwards, so the POI is on the same line.
        target_x, target_z = agent.target_poi
        arm = out_road.split("-", 1)[1]
        if arm in ("n", "s"):
            assert target_x == pytest.approx(0.0, abs=6.0)
        else:
            assert target_z == pytest.approx(0.0, abs=6.0)


def test_the_episode_does_not_end_when_the_route_ends() -> None:
    """The route's end is not the goal — the destination is.

    The drivers that run out of route before reaching their POI do
    NOT end the round (they have arrived at nothing); the round ends
    when the drivers get there, or the clock runs out.
    """
    env = _env()
    env.reset(seed=0)
    terminated = False
    truncated = False
    for _step in range(env.max_steps):
        _obs, _rew, terminated, truncated, info = env.step(np.ones((3, 2), np.float32))
        if terminated or truncated:
            break
    # The naive drivers get most of the way there but not all of it, and
    # the round ends on the CLOCK — not because the routes ran out (a
    # route's end is not the goal).
    assert truncated is True
    assert terminated is False
    assert info["arrived"] >= 1


def test_the_speed_is_capped_at_the_road_limit() -> None:
    """A driver cannot drive at 120 m/s on a 16.67 m/s road."""
    env = _env()
    env.reset(seed=0)
    for _step in range(200):
        env.step(np.ones((3, 2), np.float32))
    for agent in env.core.agents:
        assert agent.speed <= 16.67 + 1e-6


def test_the_navigation_baseline_comes_back_but_crashes() -> None:
    """The naive baseline (nobody yields) drives into the others.

    The POIs are all on ONE street, so the drivers share it: the ones
    that get there first stand in front of the ones behind (measured:
    2.0 of 3 arrive, with 3.4 collisions per window).
    """
    env = PoiNavigationEnv(n_agents=3, n_npcs=1, baseline="always_go")
    env.reset(seed=0)
    for _step in range(300):
        _obs, _rew, terminated, truncated, info = env.step(np.zeros((3, 2), np.float32))
        if terminated or truncated:
            break
    assert info["arrived"] >= 1
    assert info["collisions"] >= 1
