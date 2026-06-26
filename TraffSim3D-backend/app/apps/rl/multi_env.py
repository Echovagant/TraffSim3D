"""Plan 045: Multi-agent Gymnasium env (parameter sharing).

Wraps N TrafficEnv instances in lockstep. All agents share the same PPO
policy network (parameter sharing — common in MARL). Per-agent
observations and actions are stacked into single tensors.
"""
from __future__ import annotations

from typing import Any

import gymnasium as gym
import numpy as np
from gymnasium import spaces

from .env import TrafficEnv
from .sim_core import OBS_DIM


class MultiTrafficEnv(gym.Env[np.ndarray, np.ndarray]):
    """Stack of N TrafficEnv running in lockstep with shared policy."""

    def __init__(self, n_agents: int = 2) -> None:
        super().__init__()
        if n_agents < 1:
            raise ValueError(f"n_agents must be >= 1, got {n_agents}")
        self.n_agents = n_agents
        self.envs = [TrafficEnv() for _ in range(n_agents)]
        # Stacked spaces — PPO expects flat shape; we flatten inside
        # the env wrapper before passing to the model if needed.
        self.observation_space = spaces.Box(
            low=-1.0, high=1.0, shape=(n_agents, OBS_DIM), dtype=np.float32,
        )
        self.action_space = spaces.Box(
            low=-1.0, high=1.0, shape=(n_agents, 2), dtype=np.float32,
        )

    def reset(
        self,
        *,
        seed: int | None = None,
        options: dict[str, Any] | None = None,
    ) -> tuple[np.ndarray, dict[str, Any]]:
        super().reset(seed=seed)
        # Each underlying env gets a different seed so they don't
        # initialize identically.
        obs_list = []
        for i, env in enumerate(self.envs):
            sub_seed = (seed + i) if seed is not None else None
            o, _ = env.reset(seed=sub_seed)
            obs_list.append(o)
        return np.stack(obs_list), {}

    def step(self, actions: np.ndarray) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        if actions.shape != (self.n_agents, 2):
            raise ValueError(
                f"actions must have shape ({self.n_agents}, 2), got {actions.shape}",
            )
        results = [env.step(actions[i].astype(np.float32))
                   for i, env in enumerate(self.envs)]
        obs = np.stack([r[0] for r in results])
        rewards = [float(r[1]) for r in results]
        terms = [r[2] for r in results]
        truncs = [r[3] for r in results]
        infos = [r[4] for r in results]
        # Step ends when ANY agent terminates or truncates.
        terminated = any(terms)
        truncated = any(truncs) and not terminated
        return (
            obs,
            float(np.mean(rewards)),
            terminated,
            truncated,
            {"per_agent": infos, "mean_reward": float(np.mean(rewards))},
        )

    def render(self) -> None:  # pragma: no cover
        pass