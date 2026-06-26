"""Plan 044: SimCore unit tests."""
from __future__ import annotations

import math

import numpy as np

from app.apps.rl.sim_core import (
    OBS_DIM,
    SPEED_LIMIT,
    SimCore,
)


def test_obs_dim_is_13() -> None:
    s = SimCore()
    s.reset()
    assert s._obs().shape == (OBS_DIM,)


def test_ego_starts_at_south_heading_north() -> None:
    s = SimCore()
    s.reset()
    assert s.ego.x == 0.0
    assert s.ego.z == -25.0
    assert abs(s.ego.heading - math.pi / 2) < 1e-6


def test_step_advances_time_and_position() -> None:
    s = SimCore()
    s.reset()
    prev_step = s.step_count
    prev_z = s.ego.z
    s.step(np.array([0.5, 0.0], dtype=np.float32))
    assert s.step_count == prev_step + 1
    assert s.ego.z > prev_z  # moved north


def test_collision_terminates() -> None:
    s = SimCore()
    s.reset()
    # Move ego into NPC #1's path (at (0, 15))
    s.ego.x = 0.0
    s.ego.z = 14.5
    s.ego.speed = SPEED_LIMIT
    _, _, terminated, _, info = s.step(np.array([0.0, 0.0], dtype=np.float32))
    assert terminated
    assert info["reason"] == "collision"


def test_max_steps_truncates() -> None:
    s = SimCore(max_steps=5)
    s.reset()
    for _ in range(7):
        _, _, _, truncated, _ = s.step(np.array([0.0, 0.0], dtype=np.float32))
    assert truncated


def test_pure_pursuit_drives_north() -> None:
    """Running 30 steps with mild forward accel moves ego significantly north."""
    s = SimCore()
    s.reset()
    initial_z = s.ego.z
    for _ in range(30):
        s.step(np.array([0.5, 0.0], dtype=np.float32))
    # Should have moved at least 1m north (Pure Pursuit keeps it heading ~π/2)
    assert s.ego.z > initial_z + 1.0


def test_action_out_of_range_clamped() -> None:
    """Action values > 1 should not crash the sim."""
    s = SimCore()
    s.reset()
    # Should not raise
    s.step(np.array([10.0, 10.0], dtype=np.float32))