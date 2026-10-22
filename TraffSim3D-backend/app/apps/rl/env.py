"""Gymnasium env wrapping SimCore."""

from __future__ import annotations

from typing import Any

import gymnasium as gym
import numpy as np
from gymnasium import spaces

from .sim_core import MAX_STEPS_DEFAULT, OBS_DIM, SimCore


class TrafficEnv(gym.Env[np.ndarray, np.ndarray]):
    """Single-agent traffic env — drive the ego vehicle through a 4-way
    intersection while respecting the traffic light and avoiding NPCs.

    `scene_kind='corridor'` switches to a 2-intersection
    corridor topology for multi-intersection training.

    `light_cycle_seconds` overrides the **signalled** scene's
    light cycle for training (the light curriculum in `train.py`). `None`
    (the default) is the scene's own cycle — the value the cross-language
    contract pins.
    """

    metadata = {"render_modes": []}

    observation_space = spaces.Box(low=-1.0, high=1.0, shape=(OBS_DIM,), dtype=np.float32)
    action_space = spaces.Box(low=-1.0, high=1.0, shape=(2,), dtype=np.float32)

    def __init__(
        self,
        max_steps: int = MAX_STEPS_DEFAULT,
        scene_kind: str = "cross",  # 'cross' | 'corridor'
        light_cycle_seconds: float | None = None,
    ) -> None:
        super().__init__()
        self.core = SimCore(
            max_steps=max_steps,
            scene_kind=scene_kind,
            light_cycle_seconds=light_cycle_seconds,
        )

    def reset(
        self,
        *,
        seed: int | None = None,
        options: dict[str, Any] | None = None,
    ) -> tuple[np.ndarray, dict[str, Any]]:
        super().reset(seed=seed)
        return self.core.reset(seed=seed), {}

    def step(self, action: np.ndarray) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        return self.core.step(action.astype(np.float32))

    def render(self) -> None:  # pragma: no cover
        pass
