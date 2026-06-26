"""Plan 044: Gymnasium env contract tests."""
from __future__ import annotations

import numpy as np

from app.apps.rl.env import TrafficEnv
from app.apps.rl.sim_core import OBS_DIM


def test_observation_space_shape_is_13() -> None:
    env = TrafficEnv()
    assert env.observation_space.shape == (OBS_DIM,)


def test_action_space_shape_is_2() -> None:
    env = TrafficEnv()
    assert env.action_space.shape == (2,)


def test_reset_returns_obs_and_info() -> None:
    env = TrafficEnv()
    result = env.reset()
    assert len(result) == 2
    obs, info = result
    assert obs.shape == (OBS_DIM,)
    assert isinstance(info, dict)


def test_step_returns_5tuple() -> None:
    env = TrafficEnv()
    env.reset()
    result = env.step(np.array([0.5, 0.0], dtype=np.float32))
    assert len(result) == 5
    obs, reward, terminated, truncated, info = result
    assert obs.shape == (OBS_DIM,)
    assert isinstance(reward, float)
    assert isinstance(terminated, bool)
    assert isinstance(truncated, bool)
    assert isinstance(info, dict)


def test_out_of_bounds_action_does_not_crash() -> None:
    env = TrafficEnv()
    env.reset()
    # Out-of-range action should be clamped internally, not raise.
    env.step(np.array([5.0, 5.0], dtype=np.float32))


def test_repeated_random_actions_eventually_terminates() -> None:
    """1000 random steps should eventually terminate or truncate."""
    env = TrafficEnv(max_steps=200)
    env.reset(seed=42)
    done = False
    for _ in range(1000):
        action = env.action_space.sample()
        _, _, terminated, truncated, _ = env.step(action)
        if terminated or truncated:
            done = True
            break
    assert done