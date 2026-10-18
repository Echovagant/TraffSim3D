"""Plan 045: MultiTrafficEnv contract tests."""

from __future__ import annotations

import numpy as np
import pytest

from app.apps.rl.multi_env import MultiTrafficEnv
from app.apps.rl.sim_core import OBS_DIM


def test_observation_space_shape_is_n_agents_obs_dim() -> None:
    for n in (1, 2, 4):
        env = MultiTrafficEnv(n_agents=n)
        assert env.observation_space.shape == (n, OBS_DIM)


def test_action_space_shape_is_n_agents_2() -> None:
    for n in (1, 2, 4):
        env = MultiTrafficEnv(n_agents=n)
        assert env.action_space.shape == (n, 2)


def test_reset_returns_stacked_obs() -> None:
    env = MultiTrafficEnv(n_agents=3)
    obs, info = env.reset(seed=42)
    assert obs.shape == (3, OBS_DIM)
    assert isinstance(info, dict)


def test_step_returns_5tuple_with_mean_reward() -> None:
    env = MultiTrafficEnv(n_agents=2)
    env.reset(seed=42)
    actions = np.array([[0.5, 0.0], [-0.3, 0.1]], dtype=np.float32)
    result = env.step(actions)
    assert len(result) == 5
    obs, reward, terminated, truncated, info = result
    assert obs.shape == (2, OBS_DIM)
    assert isinstance(reward, float)
    assert isinstance(terminated, bool)
    assert isinstance(truncated, bool)
    assert "per_agent" in info
    assert len(info["per_agent"]) == 2


def test_step_rejects_wrong_action_shape() -> None:
    env = MultiTrafficEnv(n_agents=2)
    env.reset(seed=42)
    with pytest.raises(ValueError, match="actions must have shape"):
        env.step(np.zeros((3, 2), dtype=np.float32))


def test_n_agents_one_is_valid() -> None:
    env = MultiTrafficEnv(n_agents=1)
    obs, _ = env.reset(seed=42)
    assert obs.shape == (1, OBS_DIM)


def test_zero_or_negative_n_agents_raises() -> None:
    with pytest.raises(ValueError):
        MultiTrafficEnv(n_agents=0)


def test_step_terminates_when_any_agent_crashes() -> None:
    """If any underlying env terminates, the multi-env reports terminated."""
    env = MultiTrafficEnv(n_agents=2)
    env.reset(seed=42)
    # Inject a crash in envs[0]
    env.envs[0].core.ego.x = 0.0
    env.envs[0].core.ego.z = 14.5  # NPC #1 path
    env.envs[0].core.ego.speed = 16.67
    actions = np.zeros((2, 2), dtype=np.float32)
    _, _, terminated, _, _ = env.step(actions)
    assert terminated is True
