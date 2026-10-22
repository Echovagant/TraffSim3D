"""SimCore unit tests."""

from __future__ import annotations

import math

import numpy as np

from app.apps.rl.sim_core import (
    OBS_DIM,
    SPEED_LIMIT,
    SimCore,
)


def test_obs_dim_is_14() -> None:
    s = SimCore()
    s.reset()
    assert s._obs().shape == (OBS_DIM,)
    assert OBS_DIM == 14


def test_ego_y_in_obs() -> None:
    """obs[13] reflects ego elevation."""
    s = SimCore()
    s.reset()
    obs = s._obs()
    assert obs[13] == 0.0  # default y=0 → normalized 0
    s.ego.y = 5.0
    obs = s._obs()
    assert abs(obs[13] - 0.5) < 1e-6  # 5/10 = 0.5


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


def test_truncation_latches_and_freezes_the_world() -> None:
    """Once the time limit is hit, the episode is over.

    Before the fix, `truncated` was *recomputed* from
    `step_count >= max_steps` on every step, so the world kept simulating
    past the limit: the ego kept moving and kept accruing the alive bonus,
    and the episode's "final" state was not stable or reproducible. The flag
    is now latched, and a step taken after the limit short-circuits.
    """
    s = SimCore(max_steps=5)
    s.reset()

    # Step until the limit is reached.
    truncated = False
    for _ in range(5):
        _, _, _, truncated, _ = s.step(np.array([0.0, 0.0], dtype=np.float32))
    assert truncated is True

    # The world must now be frozen: no reward, no motion, no step advance.
    z_at_limit = s.ego.z
    steps_at_limit = s.step_count
    _, reward, _, still_truncated, _ = s.step(np.array([0.0, 0.0], dtype=np.float32))
    assert still_truncated is True
    assert reward == 0.0
    assert s.ego.z == z_at_limit
    assert s.step_count == steps_at_limit


def test_reset_clears_the_truncation_latch() -> None:
    """A new episode must not inherit the previous one's truncation."""
    s = SimCore(max_steps=3)
    s.reset()
    for _ in range(3):
        _, _, _, truncated, _ = s.step(np.array([0.0, 0.0], dtype=np.float32))
    assert truncated is True
    assert s._truncated is True

    s.reset()
    assert s._truncated is False
    assert s.step_count == 0
    # The first step of the new episode is not truncated.
    _, _, _, truncated, _ = s.step(np.array([0.0, 0.0], dtype=np.float32))
    assert truncated is False


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


# Corridor scene tests.
def test_corridor_scene_ego_drives_through_2_intersections() -> None:
    """Corridor: ego starts at z=-25, target (0, 30). After driving
    forward, ego should reach z > 25 within max_steps, terminating
    with reason 'success_corridor'.
    """
    s = SimCore(scene_kind="corridor", max_steps=300)
    s.reset()
    assert s.ego.z == -25.0
    for _ in range(300):
        _, _, terminated, _, info = s.step(np.array([0.8, 0.0], dtype=np.float32))
        if terminated:
            assert info["reason"] == "success_corridor"
            assert s.ego.z > 25.0
            return
    raise AssertionError(f"corridor did not terminate within 300 steps (z={s.ego.z:.2f})")


def test_corridor_scene_collision_still_terminates() -> None:
    """Inject ego into NPC NB path — should still terminate with reason
    'collision', regardless of scene_kind."""
    s = SimCore(scene_kind="corridor")
    s.reset()
    # NPC NB is at (0, +10). Move ego into its path.
    s.ego.x = 0.0
    s.ego.z = 9.5
    s.ego.speed = 16.67
    _, _, terminated, _, info = s.step(np.array([0.0, 0.0], dtype=np.float32))
    assert terminated
    assert info["reason"] == "collision"


def test_corridor_success_grants_bonus_reward() -> None:
    """Corridor success rewards +10 (vs cross +5)."""
    s = SimCore(scene_kind="corridor", max_steps=200)
    s.reset()
    final_reward = 0.0
    for _ in range(200):
        _, r, term, trunc, info = s.step(np.array([0.8, 0.0], dtype=np.float32))
        final_reward = r
        if term or trunc:
            break
    assert info["reason"] == "success_corridor"
    assert final_reward > 5.0, f"expected > 5 bonus, got {final_reward}"


def test_cross_scene_unchanged_after_corridor_added() -> None:
    """Default scene_kind='cross' must preserve the original behavior."""
    s = SimCore()  # default cross
    s.reset()
    # Drive forward; should reach z > 25 in ~150 steps and terminate with 'success'
    for _ in range(300):
        _, _, term, _, info = s.step(np.array([0.8, 0.0], dtype=np.float32))
        if term:
            assert info["reason"] == "success"
            return
    raise AssertionError(f"cross did not terminate (z={s.ego.z:.2f})")
