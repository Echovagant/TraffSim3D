"""Curriculum learning scheduler for progressive scene difficulty.

Manages scene progression based on agent performance. The agent must
demonstrate mastery of the current scene before advancing to the next.

Curriculum order (easy → hard):
  cross → t_junction → roundabout → corridor

Mastery criteria:
  - Average reward over last N episodes exceeds threshold
  - OR: success rate (episodes ending with 'success*') exceeds threshold
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Scene progression order: easiest to hardest
CURRICULUM_ORDER: list[str] = [
    "cross",
    "t_junction",
    "roundabout",
    "corridor",
]

# Default mastery thresholds per scene
DEFAULT_THRESHOLDS: dict[str, dict[str, float]] = {
    "cross": {"avg_reward": 3.0, "success_rate": 0.5},
    "t_junction": {"avg_reward": 3.0, "success_rate": 0.4},
    "roundabout": {"avg_reward": 2.5, "success_rate": 0.3},
    "corridor": {"avg_reward": 5.0, "success_rate": 0.4},
}

# Evaluation window: how many recent episodes to consider
EVAL_WINDOW = 20


@dataclass
class CurriculumState:
    """Tracks curriculum progress and per-scene performance."""

    current_scene_idx: int = 0
    episode_rewards: list[float] = field(default_factory=list)
    episode_successes: list[bool] = field(default_factory=list)
    scene_history: list[dict[str, float | str | int]] = field(default_factory=list)
    # Lifetime count of episodes recorded on the current scene. `episode_rewards`
    # is a sliding window capped at `eval_window`, so `len(episode_rewards)` can
    # never report how many episodes a scene actually took — this counter can.
    episodes_on_current_scene: int = 0

    @property
    def current_scene(self) -> str:
        if self.current_scene_idx < len(CURRICULUM_ORDER):
            return CURRICULUM_ORDER[self.current_scene_idx]
        return CURRICULUM_ORDER[-1]

    @property
    def is_complete(self) -> bool:
        return self.current_scene_idx >= len(CURRICULUM_ORDER)


class CurriculumScheduler:
    """Manages curriculum progression based on agent performance."""

    def __init__(
        self,
        thresholds: dict[str, dict[str, float]] | None = None,
        eval_window: int = EVAL_WINDOW,
    ) -> None:
        # `thresholds or DEFAULT_THRESHOLDS` would treat a caller-supplied
        # `{}` as "not set" and silently substitute the defaults. `is None`
        # is the actual "not set" signal.
        self.thresholds = DEFAULT_THRESHOLDS if thresholds is None else thresholds
        self.eval_window = eval_window
        self.state = CurriculumState()

    def record_episode(self, reward: float, info: dict) -> None:
        """Record episode result and check for scene advancement."""
        self.state.episode_rewards.append(reward)
        self.state.episodes_on_current_scene += 1
        # Check if episode ended with success
        reason = info.get("reason", "")
        success = reason.startswith("success")
        self.state.episode_successes.append(success)

        # Keep only recent episodes
        if len(self.state.episode_rewards) > self.eval_window:
            self.state.episode_rewards = self.state.episode_rewards[-self.eval_window :]
            self.state.episode_successes = self.state.episode_successes[-self.eval_window :]

    def should_advance(self) -> bool:
        """Check if agent has mastered current scene."""
        if self.state.is_complete:
            return False
        if len(self.state.episode_rewards) < self.eval_window:
            return False

        scene = self.state.current_scene
        thresholds = self.thresholds.get(scene, {})

        # Check average reward
        recent_rewards = self.state.episode_rewards[-self.eval_window :]
        avg_reward = sum(recent_rewards) / len(recent_rewards)
        reward_threshold = thresholds.get("avg_reward", float("inf"))

        # Check success rate
        recent_successes = self.state.episode_successes[-self.eval_window :]
        success_rate = sum(recent_successes) / len(recent_successes)
        success_threshold = thresholds.get("success_rate", 1.0)

        # Advance if either criterion is met
        return avg_reward >= reward_threshold or success_rate >= success_threshold

    def advance(self) -> str | None:
        """Advance to next scene if criteria met. Returns new scene or None."""
        if not self.should_advance():
            return None

        old_scene = self.state.current_scene
        self.state.scene_history.append(
            {
                "scene": old_scene,
                "scene_idx": self.state.current_scene_idx,
                # Lifetime count for this scene. `len(episode_rewards)` would
                # saturate at `eval_window` and under-report by exactly the
                # amount the sliding window trimmed.
                "episodes": self.state.episodes_on_current_scene,
            }
        )
        self.state.current_scene_idx += 1
        self.state.episode_rewards.clear()
        self.state.episode_successes.clear()
        self.state.episodes_on_current_scene = 0

        if self.state.is_complete:
            return None
        return self.state.current_scene

    def get_status(self) -> dict:
        """Return current curriculum status for logging/UI."""
        recent_rewards = self.state.episode_rewards[-self.eval_window :]
        recent_successes = self.state.episode_successes[-self.eval_window :]

        return {
            "current_scene": self.state.current_scene,
            "scene_idx": self.state.current_scene_idx,
            "total_scenes": len(CURRICULUM_ORDER),
            "is_complete": self.state.is_complete,
            "episodes_on_scene": len(self.state.episode_rewards),
            "episodes_on_current_scene": self.state.episodes_on_current_scene,
            "avg_reward": sum(recent_rewards) / len(recent_rewards) if recent_rewards else 0.0,
            "success_rate": (
                sum(recent_successes) / len(recent_successes) if recent_successes else 0.0
            ),
            "scene_history": self.state.scene_history,
        }
