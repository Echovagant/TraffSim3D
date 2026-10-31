"""The progress / finish rewards — the standstill-equilibrium fix.

What is pinned here:

1. **The reward structure**: progress earns, finishing earns, waiting
   costs, and the collision/conflict penalties are unchanged.
2. **The opt-in boundary**: the single-junction scenario keeps its
   measured reward (the shipped policy's numbers were taken with it);
   only the grid enables the incentives.
3. **The calibration**: a full route's progress (2.0) plus the finish
   bonus (5.0) cannot be hacked by rushing through conflicts, and the
   collision penalty still dominates everything.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.apps.rl.drive_core import (
    COLLISION_PENALTY,
    CONFLICT_PENALTY,
    FINISH_BONUS,
    PROGRESS_REWARD,
    DriveCore,
)
from app.apps.rl.grid_drive_env import GridDriveEnv
from app.apps.rl.network_graph import build_network_graph
from tests.test_rl_drive_core import _network


def _core(progress_reward: bool) -> DriveCore:
    graph = build_network_graph(_network())
    return DriveCore(
        graph,
        n_agents=1,
        n_npcs=0,
        max_steps=400,
        progress_reward=progress_reward,
    )


def test_progress_earns_and_waiting_does_not() -> None:
    core = _core(progress_reward=True)
    core.reset(np.random.default_rng(0))
    agent = core.agents[0]

    # A step of driving: progress gains, no waiting.
    agent.speed = 10.0
    before = agent.route_progress
    _obs, rewards, _t, _tr, _info = core.step([(1.0, 0.0)])
    gain = agent.route_progress - before
    assert gain > 0.0
    assert rewards[0] == pytest.approx(PROGRESS_REWARD * gain, abs=1e-5)

    # A step of standing still: the delay only.
    agent.speed = 0.0
    _obs, rewards, _t, _tr, _info = core.step([(0.0, 0.0)])
    assert rewards[0] == pytest.approx(-agent.delay_increment, abs=1e-5)
    assert rewards[0] < 0.0


def test_finishing_earns_the_bonus() -> None:
    core = _core(progress_reward=True)
    core.reset(np.random.default_rng(0))
    agent = core.agents[0]
    # Teleport to the end of the route — the POSE with it (the route
    # advance re-projects seg_t onto the position, so moving seg_t alone
    # would snap straight back).
    last_id = agent.route.segment_ids[-1]
    last = core.graph.segments[last_id]
    agent.current_seg_idx = len(agent.route.segment_ids) - 1
    agent.seg_t = last.length - 0.01
    heading = core._segment_heading(last, agent.seg_t)
    agent.x, agent.z = core._lane_point(last, agent.seg_t, heading)
    agent.heading = heading

    _obs, rewards, _t, _tr, _info = core.step([(1.0, 0.0)])

    assert agent.finished
    assert agent.finished_increment == 1
    # The finish bonus plus the last sliver of progress.
    assert rewards[0] >= FINISH_BONUS


def test_without_the_flag_the_reward_stays_the_measured_v1_one() -> None:
    """The single-junction scenario's numbers were taken WITHOUT the
    progress / finish incentives — the opt-in keeps them valid."""
    core = _core(progress_reward=False)
    core.reset(np.random.default_rng(0))
    agent = core.agents[0]
    last_id = agent.route.segment_ids[-1]
    last = core.graph.segments[last_id]
    agent.current_seg_idx = len(agent.route.segment_ids) - 1
    agent.seg_t = last.length - 0.01
    heading = core._segment_heading(last, agent.seg_t)
    agent.x, agent.z = core._lane_point(last, agent.seg_t, heading)
    agent.heading = heading

    _obs, rewards, _t, _tr, _info = core.step([(1.0, 0.0)])

    assert agent.finished
    # No finish bonus: the reward is only the (zero) delay and conflicts.
    assert rewards[0] == pytest.approx(0.0, abs=1e-5)


def test_the_calibration_keeps_collisions_dominant() -> None:
    """Rushing through a junction cannot be the cheap way out.

    The full route's progress (2.0) plus the finish bonus (5.0) must be
    worth less than the collisions a rushed crossing collects.
    """
    # Two conflict events (a grid route crosses two junctions) and one
    # collision: the penalties must exceed the incentives.
    assert 2 * CONFLICT_PENALTY + COLLISION_PENALTY > PROGRESS_REWARD + FINISH_BONUS
    # And the progress term must be big enough to break a standstill
    # equilibrium: a second of driving earns within an order of
    # magnitude of the second of waiting it skips.
    assert PROGRESS_REWARD > 0.5
    assert PROGRESS_REWARD < COLLISION_PENALTY / 5


def test_the_grid_env_enables_the_incentives() -> None:
    env = GridDriveEnv(n_agents=2, n_npcs=0)
    assert env.core.progress_reward is True
