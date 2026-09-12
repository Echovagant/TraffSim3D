"""Curriculum learning environment wrapper.

Wraps TrafficEnv and dynamically switches scene_kind based on agent
performance. Integrates with CurriculumScheduler for progression logic.
"""
from __future__ import annotations

from typing import Any

import numpy as np
from gymnasium import spaces

from .curriculum import CurriculumScheduler
from .env import TrafficEnv
from .sim_core import OBS_DIM


class CurriculumEnv(TrafficEnv):
    """Gymnasium env that progresses through scene curriculum.

    Starts with the easiest scene (cross). When the agent demonstrates
    mastery (avg reward or success rate threshold), automatically switches
    to the next scene in the curriculum.
    """

    def __init__(
        self,
        max_steps: int = 200,
        thresholds: dict[str, dict[str, float]] | None = None,
        eval_window: int = 20,
    ) -> None:
        # Initialize with first scene in curriculum
        super().__init__(max_steps=max_steps, scene_kind="cross")
        self.scheduler = CurriculumScheduler(
            thresholds=thresholds, eval_window=eval_window,
        )
        self._prev_episode_reward = 0.0
        self._prev_episode_info: dict[str, Any] = {}

    def step(
        self, action: np.ndarray,
    ) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        obs, reward, terminated, truncated, info = super().step(action)

        # Accumulate reward for current episode
        self._prev_episode_reward += reward
        self._prev_episode_info = info

        # Check for episode end and curriculum advancement
        if terminated or truncated:
            self.scheduler.record_episode(
                self._prev_episode_reward, self._prev_episode_info,
            )
            new_scene = self.scheduler.advance()
            if new_scene is not None:
                # Switch to next scene
                self.core.scene_kind = new_scene
                info["curriculum_advanced"] = True
                info["new_scene"] = new_scene
            self._prev_episode_reward = 0.0
            self._prev_episode_info = {}

        return obs, reward, terminated, truncated, info

    def reset(
        self,
        *,
        seed: int | None = None,
        options: dict[str, Any] | None = None,
    ) -> tuple[np.ndarray, dict[str, Any]]:
        # Ensure we're on the current curriculum scene
        self.core.scene_kind = self.scheduler.state.current_scene
        obs, info = super().reset(seed=seed, options=options)
        info["curriculum_scene"] = self.scheduler.state.current_scene
        return obs, info

    def get_curriculum_status(self) -> dict[str, Any]:
        """Return current curriculum status for logging/UI."""
        return self.scheduler.get_status()
