"""Curriculum learning environment wrapper.

Wraps TrafficEnv and dynamically switches scene_kind based on agent
performance. Integrates with CurriculumScheduler for progression logic.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from .curriculum import CurriculumScheduler
from .env import TrafficEnv


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
            thresholds=thresholds,
            eval_window=eval_window,
        )
        self._prev_episode_reward = 0.0
        self._prev_episode_info: dict[str, Any] = {}
        # Plan 067: whether the current episode has already reported "done".
        # `SimCore` re-reports `terminated=True` on every step after a terminal
        # state (and `truncated=True` after the time limit), so a level
        # trigger would record one episode per extra step.
        self._episode_ended = False

    def step(
        self,
        action: np.ndarray,
    ) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        obs, reward, terminated, truncated, info = super().step(action)

        # Accumulate reward for current episode
        self._prev_episode_reward += reward
        self._prev_episode_info = info

        # Check for episode end and curriculum advancement.
        #
        # Plan 067: trigger on the *edge* — the first step that reports done —
        # not on every subsequent step. `SimCore` keeps re-reporting
        # `terminated=True` after a terminal state, and (before Plan 067) also
        # re-reported `truncated=True` on every step past the time limit. A
        # level trigger therefore recorded one episode per extra step, and
        # each of those could advance the curriculum again — a single episode
        # could walk the whole curriculum.
        done = terminated or truncated
        if done and not self._episode_ended:
            self.scheduler.record_episode(
                self._prev_episode_reward,
                self._prev_episode_info,
            )
            new_scene = self.scheduler.advance()
            if new_scene is not None:
                # Switch to next scene
                self.core.scene_kind = new_scene
                info["curriculum_advanced"] = True
                info["new_scene"] = new_scene
            elif self.scheduler.state.is_complete:
                # `advance()` returns None for two different reasons: the
                # criteria were not met, or the curriculum just finished. Only
                # the latter is a milestone, and a training loop that watches
                # for `curriculum_advanced` would otherwise never learn that
                # the agent graduated. Emit a distinct key rather than
                # overloading `curriculum_advanced`, which would wrongly claim
                # a scene switch that never happened.
                info["curriculum_complete"] = True
            self._prev_episode_reward = 0.0
            self._prev_episode_info = {}
        self._episode_ended = done

        return obs, reward, terminated, truncated, info

    def reset(
        self,
        *,
        seed: int | None = None,
        options: dict[str, Any] | None = None,
    ) -> tuple[np.ndarray, dict[str, Any]]:
        # Ensure we're on the current curriculum scene
        self.core.scene_kind = self.scheduler.state.current_scene
        # Plan 067: a new episode starts, so the next "done" is an edge again.
        self._episode_ended = False
        obs, info = super().reset(seed=seed, options=options)
        info["curriculum_scene"] = self.scheduler.state.current_scene
        return obs, info

    def get_curriculum_status(self) -> dict[str, Any]:
        """Return current curriculum status for logging/UI."""
        return self.scheduler.get_status()
