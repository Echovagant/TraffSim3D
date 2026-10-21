"""Unit tests for the curriculum scheduler and the curriculum env wrapper.

Covers `app/apps/rl/curriculum.py` (progression state machine) and
`app/apps/rl/curriculum_env.py` (TrafficEnv wrapper that feeds episodes to the
scheduler). Every threshold / order assertion below is taken from the source
tables `CURRICULUM_ORDER` and `DEFAULT_THRESHOLDS`, not guessed.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.apps.rl.curriculum import (
    CURRICULUM_ORDER,
    DEFAULT_THRESHOLDS,
    EVAL_WINDOW,
    CurriculumScheduler,
    CurriculumState,
)
from app.apps.rl.curriculum_env import CurriculumEnv
from app.apps.rl.sim_core import OBS_DIM

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

# Per-step stubbed physics: (reward, terminated, truncated, reason)
Step = tuple[float, bool, bool, str]


def _record(
    scheduler: CurriculumScheduler,
    reward: float,
    reason: str,
    times: int = 1,
) -> None:
    """Record `times` episodes with identical reward/reason."""
    for _ in range(times):
        scheduler.record_episode(reward, {"reason": reason})


def _master(scheduler: CurriculumScheduler, reward: float) -> str | None:
    """Fill the eval window with episodes that clear the avg_reward bar."""
    _record(scheduler, reward, "success", scheduler.eval_window)
    return scheduler.advance()


class _StubCore:
    """Scripted stand-in for `SimCore`.

    Replaces only the *physics* collaborator so that `CurriculumEnv.step` /
    `CurriculumEnv.reset` still execute their real curriculum logic
    (accumulation, `record_episode`, `advance`, scene switching) against a
    deterministic episode script. It is not a mock of either module under test.
    """

    def __init__(self, episodes: list[list[Step]], scene_kind: str = "cross") -> None:
        self.scene_kind = scene_kind
        self.reset_count = 0
        self.last_seed: int | None = None
        self.last_action_dtype: np.dtype | None = None
        self._script = list(episodes)
        self._episode: list[Step] = []
        self._cursor = 0

    def reset(self, seed: int | None = None) -> np.ndarray:
        # Popping here makes a stray step() without reset() an IndexError.
        self._episode = self._script.pop(0)
        self._cursor = 0
        self.reset_count += 1
        self.last_seed = seed
        return np.zeros(OBS_DIM, dtype=np.float32)

    def step(self, action: np.ndarray) -> tuple[np.ndarray, float, bool, bool, dict]:
        reward, terminated, truncated, reason = self._episode[self._cursor]
        self._cursor += 1
        self.last_action_dtype = action.dtype
        info = {"reason": reason, "progress": reward}
        return np.zeros(OBS_DIM, dtype=np.float32), float(reward), terminated, truncated, info


def _stubbed(episodes: list[list[Step]], **kwargs) -> CurriculumEnv:
    """A real CurriculumEnv whose physics core is replaced by `_StubCore`."""
    env = CurriculumEnv(**kwargs)
    env.core = _StubCore(episodes)
    return env


# ---------------------------------------------------------------------------
# module-level tables
# ---------------------------------------------------------------------------


def test_curriculum_order_is_cross_tjunction_roundabout_corridor() -> None:
    assert CURRICULUM_ORDER == ["cross", "t_junction", "roundabout", "corridor"]


def test_default_thresholds_table_is_exact() -> None:
    assert DEFAULT_THRESHOLDS == {
        "cross": {"avg_reward": 3.0, "success_rate": 0.5},
        "t_junction": {"avg_reward": 3.0, "success_rate": 0.4},
        "roundabout": {"avg_reward": 2.5, "success_rate": 0.3},
        "corridor": {"avg_reward": 5.0, "success_rate": 0.4},
    }


def test_eval_window_default_is_20() -> None:
    assert EVAL_WINDOW == 20


# ---------------------------------------------------------------------------
# CurriculumState
# ---------------------------------------------------------------------------


def test_fresh_state_starts_at_first_scene_with_empty_buffers() -> None:
    state = CurriculumState()
    assert state.current_scene_idx == 0
    assert state.current_scene == "cross"
    assert state.is_complete is False
    assert state.episode_rewards == []
    assert state.episode_successes == []
    assert state.scene_history == []


def test_current_scene_walks_the_documented_order() -> None:
    for idx, expected in enumerate(CURRICULUM_ORDER):
        state = CurriculumState(current_scene_idx=idx)
        assert state.current_scene == expected
        assert state.is_complete is False


def test_current_scene_clamps_to_last_entry_once_index_passes_the_end() -> None:
    state = CurriculumState(current_scene_idx=len(CURRICULUM_ORDER))
    assert state.current_scene == "corridor"
    assert state.is_complete is True


def test_current_scene_clamps_for_far_out_of_range_index() -> None:
    state = CurriculumState(current_scene_idx=99)
    assert state.current_scene == CURRICULUM_ORDER[-1] == "corridor"
    assert state.is_complete is True


# ---------------------------------------------------------------------------
# CurriculumScheduler.__init__
# ---------------------------------------------------------------------------


def test_scheduler_defaults_to_module_table_and_window() -> None:
    sched = CurriculumScheduler()
    assert sched.thresholds is DEFAULT_THRESHOLDS
    assert sched.eval_window == EVAL_WINDOW == 20
    assert sched.state.current_scene == "cross"
    assert sched.state.episode_rewards == []


def test_scheduler_accepts_custom_thresholds_and_window() -> None:
    custom = {"cross": {"avg_reward": 9.5, "success_rate": 0.9}}
    sched = CurriculumScheduler(thresholds=custom, eval_window=4)
    assert sched.thresholds is custom
    assert sched.eval_window == 4


def test_scheduler_honours_an_explicitly_empty_threshold_dict() -> None:
    """`{}` is a caller-supplied table, not "unset".

    This used to assert the opposite: `thresholds or DEFAULT_THRESHOLDS`
    silently substituted the defaults for `{}`. Fixed 2026-10-18 — an
    explicitly empty table now means "no scene has a threshold", which makes
    `should_advance` fall back to its `inf` / `1.0` defaults per scene rather
    than quietly inheriting someone else's tuning.
    """
    sched = CurriculumScheduler(thresholds={})
    assert sched.thresholds == {}
    assert sched.thresholds is not DEFAULT_THRESHOLDS


def test_scheduler_uses_defaults_when_thresholds_is_none() -> None:
    """`None` is the actual "not set" signal."""
    sched = CurriculumScheduler(thresholds=None)
    assert sched.thresholds is DEFAULT_THRESHOLDS


def test_scheduler_keeps_threshold_dict_by_reference() -> None:
    """Caller-owned table is not copied; later mutation is visible."""
    custom = {"cross": {"avg_reward": 1.0, "success_rate": 0.1}}
    sched = CurriculumScheduler(thresholds=custom)
    custom["cross"]["avg_reward"] = 7.0
    assert sched.thresholds["cross"]["avg_reward"] == 7.0


# ---------------------------------------------------------------------------
# record_episode
# ---------------------------------------------------------------------------


def test_record_episode_appends_reward_and_flags_success() -> None:
    sched = CurriculumScheduler(eval_window=5)
    sched.record_episode(4.0, {"reason": "success"})
    assert sched.state.episode_rewards == [4.0]
    assert sched.state.episode_successes == [True]


def test_record_episode_treats_scene_suffixed_success_reasons_as_success() -> None:
    sched = CurriculumScheduler(eval_window=5)
    for reason in ("success_corridor", "success_t_junction", "success_roundabout"):
        sched.record_episode(1.0, {"reason": reason})
    assert sched.state.episode_successes == [True, True, True]


def test_record_episode_treats_failure_reasons_as_not_success() -> None:
    sched = CurriculumScheduler(eval_window=5)
    sched.record_episode(1.0, {"reason": "collision"})
    sched.record_episode(1.0, {"reason": "red_light"})
    assert sched.state.episode_successes == [False, False]


def test_record_episode_treats_missing_and_empty_reason_as_not_success() -> None:
    sched = CurriculumScheduler(eval_window=5)
    sched.record_episode(1.0, {})
    sched.record_episode(1.0, {"reason": ""})
    sched.record_episode(1.0, {"progress": 0.4})
    assert sched.state.episode_successes == [False, False, False]


def test_record_episode_below_window_does_not_trim() -> None:
    sched = CurriculumScheduler(eval_window=5)
    for i in range(3):
        sched.record_episode(float(i), {"reason": "success" if i else "collision"})
    assert sched.state.episode_rewards == [0.0, 1.0, 2.0]
    assert sched.state.episode_successes == [False, True, True]
    assert len(sched.state.episode_rewards) == 3


def test_record_episode_at_exact_window_keeps_every_episode() -> None:
    sched = CurriculumScheduler(eval_window=5)
    for i in range(5):
        sched.record_episode(float(i), {"reason": "collision"})
    assert sched.state.episode_rewards == [0.0, 1.0, 2.0, 3.0, 4.0]
    assert len(sched.state.episode_successes) == 5


def test_record_episode_past_window_keeps_only_the_last_n() -> None:
    sched = CurriculumScheduler(eval_window=5)
    for i in range(7):
        sched.record_episode(float(i), {"reason": "collision"})
    assert sched.state.episode_rewards == [2.0, 3.0, 4.0, 5.0, 6.0]
    assert len(sched.state.episode_successes) == 5


def test_record_episode_trim_keeps_success_flags_aligned_with_rewards() -> None:
    sched = CurriculumScheduler(eval_window=3)
    sched.record_episode(100.0, {"reason": "success"})
    sched.record_episode(200.0, {"reason": "success"})
    sched.record_episode(300.0, {"reason": "success"})
    sched.record_episode(1.0, {"reason": "collision"})
    sched.record_episode(2.0, {"reason": "collision"})
    sched.record_episode(3.0, {"reason": "success"})
    assert sched.state.episode_rewards == [1.0, 2.0, 3.0]
    assert sched.state.episode_successes == [False, False, True]


def test_record_episode_window_of_one_keeps_only_the_latest() -> None:
    sched = CurriculumScheduler(eval_window=1)
    sched.record_episode(9.0, {"reason": "success"})
    sched.record_episode(4.0, {"reason": "collision"})
    assert sched.state.episode_rewards == [4.0]
    assert sched.state.episode_successes == [False]


# ---------------------------------------------------------------------------
# should_advance
# ---------------------------------------------------------------------------


def test_should_advance_false_while_eval_window_is_not_full() -> None:
    sched = CurriculumScheduler(eval_window=4)
    _record(sched, 10.0, "success", 3)
    assert len(sched.state.episode_rewards) == 3
    assert sched.should_advance() is False


def test_should_advance_false_when_curriculum_is_complete() -> None:
    sched = CurriculumScheduler()
    sched.state.current_scene_idx = len(CURRICULUM_ORDER)
    _record(sched, 99.0, "success", EVAL_WINDOW)
    assert sched.should_advance() is False


def test_should_advance_true_when_avg_reward_reaches_exact_threshold() -> None:
    """cross bar is 3.0 and the comparison is `>=`, so 20x3.0 must advance."""
    sched = CurriculumScheduler()
    _record(sched, 3.0, "collision", EVAL_WINDOW)
    assert sum(sched.state.episode_rewards) / EVAL_WINDOW == 3.0
    assert sched.should_advance() is True


def test_should_advance_false_when_avg_reward_is_just_below_threshold() -> None:
    sched = CurriculumScheduler()
    _record(sched, 2.9, "collision", EVAL_WINDOW)
    assert sched.should_advance() is False


def test_should_advance_true_when_success_rate_reaches_exact_threshold() -> None:
    """cross bar is 0.5; 10/20 successes must advance with zero reward."""
    sched = CurriculumScheduler()
    for i in range(EVAL_WINDOW):
        sched.record_episode(0.0, {"reason": "success" if i < 10 else "collision"})
    assert sum(sched.state.episode_successes) / EVAL_WINDOW == 0.5
    assert sched.should_advance() is True


def test_should_advance_false_when_success_rate_is_just_below_threshold() -> None:
    sched = CurriculumScheduler()
    for i in range(EVAL_WINDOW):
        sched.record_episode(0.0, {"reason": "success" if i < 9 else "collision"})
    assert sum(sched.state.episode_successes) / EVAL_WINDOW == 0.45
    assert sched.should_advance() is False


def test_should_advance_uses_or_between_the_two_criteria() -> None:
    """Reward bar met while success rate is 0.0 must still advance."""
    sched = CurriculumScheduler()
    _record(sched, 8.0, "collision", EVAL_WINDOW)
    assert sum(sched.state.episode_successes) / EVAL_WINDOW == 0.0
    assert sched.should_advance() is True


def test_should_advance_false_when_both_criteria_are_missed() -> None:
    sched = CurriculumScheduler()
    _record(sched, 0.0, "collision", EVAL_WINDOW)
    assert sched.should_advance() is False


def test_should_advance_applies_the_current_scene_threshold() -> None:
    """Same 3.0 average: passes t_junction (3.0) but fails corridor (5.0)."""
    sched = CurriculumScheduler(eval_window=4)
    sched.state.current_scene_idx = 1
    _record(sched, 3.0, "collision", 4)
    assert sched.should_advance() is True

    sched.state.current_scene_idx = 3
    sched.state.episode_rewards.clear()
    sched.state.episode_successes.clear()
    _record(sched, 3.0, "collision", 4)
    assert sched.state.current_scene == "corridor"
    assert sched.should_advance() is False


def test_should_advance_unknown_scene_requires_perfect_success_rate() -> None:
    """Missing scene entry -> avg bar inf, success bar 1.0."""
    partial = {"cross": {"avg_reward": 3.0, "success_rate": 0.5}}
    sched = CurriculumScheduler(thresholds=partial, eval_window=4)
    sched.state.current_scene_idx = 1  # t_junction, absent from `partial`
    _record(sched, 999.0, "collision", 4)
    assert sched.should_advance() is False

    sched.state.episode_rewards.clear()
    sched.state.episode_successes.clear()
    _record(sched, 999.0, "success", 4)
    assert sched.should_advance() is True


def test_should_advance_only_considers_the_most_recent_window() -> None:
    sched = CurriculumScheduler(eval_window=4)
    _record(sched, 10.0, "collision", 3)
    assert sched.should_advance() is False  # 3/4 episodes so far
    _record(sched, 0.0, "collision", 1)
    assert sched.should_advance() is True  # window avg 7.5
    _record(sched, 0.0, "collision", 1)
    assert sched.should_advance() is True  # window avg 5.0
    _record(sched, 0.0, "collision", 1)
    assert sched.should_advance() is False  # window avg 2.5, oldest 10.0 evicted
    assert sched.state.episode_rewards == [10.0, 0.0, 0.0, 0.0]
    _record(sched, 0.0, "collision", 1)
    assert sched.state.episode_rewards == [0.0, 0.0, 0.0, 0.0]
    assert sched.should_advance() is False


# ---------------------------------------------------------------------------
# advance
# ---------------------------------------------------------------------------


def test_advance_returns_none_when_criteria_not_met() -> None:
    sched = CurriculumScheduler()
    _record(sched, 0.1, "collision", EVAL_WINDOW)
    assert sched.advance() is None
    assert sched.state.current_scene_idx == 0
    assert sched.state.scene_history == []
    assert len(sched.state.episode_rewards) == EVAL_WINDOW


def test_advance_returns_next_scene_and_records_history() -> None:
    sched = CurriculumScheduler()
    assert _master(sched, 3.0) == "t_junction"
    assert sched.state.current_scene_idx == 1
    assert sched.state.current_scene == "t_junction"
    assert sched.state.scene_history == [
        {"scene": "cross", "scene_idx": 0, "episodes": EVAL_WINDOW}
    ]


def test_advance_clears_both_buffers() -> None:
    sched = CurriculumScheduler()
    _record(sched, 4.0, "success", EVAL_WINDOW)
    assert len(sched.state.episode_rewards) == EVAL_WINDOW
    sched.advance()
    assert sched.state.episode_rewards == []
    assert sched.state.episode_successes == []


def test_advance_from_corridor_marks_complete_and_returns_none() -> None:
    sched = CurriculumScheduler()
    sched.state.current_scene_idx = 3
    _record(sched, 6.0, "collision", EVAL_WINDOW)  # corridor bar is 5.0
    assert sched.advance() is None
    assert sched.state.current_scene_idx == 4
    assert sched.state.is_complete is True
    assert sched.state.current_scene == "corridor"  # clamped, not IndexError
    assert sched.state.scene_history == [
        {"scene": "corridor", "scene_idx": 3, "episodes": EVAL_WINDOW}
    ]
    assert sched.state.episode_rewards == []


def test_advance_walks_the_whole_curriculum_in_order() -> None:
    sched = CurriculumScheduler()
    returned = [
        _master(sched, 3.0),  # cross (bar 3.0)
        _master(sched, 3.0),  # t_junction (bar 3.0)
        _master(sched, 2.5),  # roundabout (bar 2.5)
        _master(sched, 5.0),  # corridor (bar 5.0)
    ]
    assert returned == ["t_junction", "roundabout", "corridor", None]
    assert [h["scene"] for h in sched.state.scene_history] == CURRICULUM_ORDER
    assert sched.state.is_complete is True
    assert sched.should_advance() is False


def test_advance_accepts_high_reward_even_with_zero_success_rate() -> None:
    sched = CurriculumScheduler()
    _record(sched, 5.5, "red_light", EVAL_WINDOW)
    assert sum(sched.state.episode_successes) == 0
    assert sched.advance() == "t_junction"


# ---------------------------------------------------------------------------
# get_status
# ---------------------------------------------------------------------------


def test_get_status_on_fresh_scheduler_reports_zeroed_metrics() -> None:
    assert CurriculumScheduler().get_status() == {
        "current_scene": "cross",
        "scene_idx": 0,
        "total_scenes": 4,
        "is_complete": False,
        "episodes_on_scene": 0,
        "episodes_on_current_scene": 0,
        "avg_reward": 0.0,
        "success_rate": 0.0,
        "scene_history": [],
    }


def test_get_status_reports_window_averages() -> None:
    sched = CurriculumScheduler(eval_window=2)
    sched.record_episode(10.0, {"reason": "success"})
    sched.record_episode(1.0, {"reason": "collision"})
    status = sched.get_status()
    assert status["episodes_on_scene"] == 2
    assert status["avg_reward"] == 5.5
    assert status["success_rate"] == 0.5
    assert status["current_scene"] == "cross"


def test_get_status_shares_the_scene_history_object() -> None:
    sched = CurriculumScheduler()
    _master(sched, 3.0)
    status = sched.get_status()
    assert status["scene_history"] is sched.state.scene_history
    assert status["scene_idx"] == 1
    assert status["current_scene"] == "t_junction"


def test_get_status_reports_completed_curriculum() -> None:
    sched = CurriculumScheduler()
    sched.state.current_scene_idx = len(CURRICULUM_ORDER)
    status = sched.get_status()
    assert status["is_complete"] is True
    assert status["scene_idx"] == 4
    assert status["total_scenes"] == len(CURRICULUM_ORDER)
    assert status["current_scene"] == "corridor"


# ---------------------------------------------------------------------------
# CurriculumEnv
# ---------------------------------------------------------------------------


def test_env_initialises_on_first_curriculum_scene() -> None:
    env = CurriculumEnv(max_steps=5, eval_window=3)
    assert env.core.scene_kind == "cross"
    assert env.core.max_steps == 5
    assert env.scheduler.state.current_scene_idx == 0
    assert env.scheduler.eval_window == 3
    assert env._prev_episode_reward == 0.0
    assert env._prev_episode_info == {}


def test_env_threads_custom_thresholds_into_scheduler() -> None:
    custom = {"cross": {"avg_reward": 0.1, "success_rate": 0.1}}
    env = CurriculumEnv(thresholds=custom)
    assert env.scheduler.thresholds is custom


def test_get_curriculum_status_mirrors_the_scheduler() -> None:
    env = CurriculumEnv()
    status = env.get_curriculum_status()
    assert status == env.scheduler.get_status()
    assert status["current_scene"] == "cross"
    assert status["scene_idx"] == 0
    assert status["total_scenes"] == 4
    assert status["is_complete"] is False
    assert status["episodes_on_scene"] == 0


def test_reset_rebuilds_core_and_reports_the_curriculum_scene() -> None:
    env = _stubbed([[(0.0, False, False, "")]])
    obs, info = env.reset(seed=7)
    assert obs.shape == (OBS_DIM,)
    assert info["curriculum_scene"] == "cross"
    assert env.core.reset_count == 1
    assert env.core.last_seed == 7


def test_reset_syncs_core_scene_to_the_current_curriculum_scene() -> None:
    env = _stubbed([[(0.0, False, False, "")]])
    env.scheduler.state.current_scene_idx = 1
    _, info = env.reset()
    assert env.core.scene_kind == "t_junction"
    assert info["curriculum_scene"] == "t_junction"


def test_step_accumulates_reward_over_substeps_and_casts_action() -> None:
    env = _stubbed([[(1.5, False, False, ""), (2.25, False, False, "")]])
    env.reset()
    env.step(np.array([1.0, 0.0]))  # float64 in
    env.step(np.array([1.0, 0.0]))
    assert env.core.last_action_dtype == np.float32
    assert env._prev_episode_reward == 3.75
    assert env.scheduler.state.episode_rewards == []


def test_step_does_not_record_an_episode_before_the_episode_ends() -> None:
    env = _stubbed([[(5.0, False, False, "")]])
    env.reset()
    env.step(np.array([1.0, 0.0]))
    assert env.scheduler.state.episode_rewards == []
    assert env.get_curriculum_status()["episodes_on_scene"] == 0


def test_step_advances_scene_and_annotates_info_on_termination() -> None:
    env = _stubbed(
        [[(5.0, True, False, "success")], [(5.0, True, False, "success")]],
        eval_window=2,
    )
    env.reset()
    _, _, terminated, _, info = env.step(np.array([1.0, 0.0]))
    assert terminated is True
    assert "curriculum_advanced" not in info  # only 1 of 2 window episodes
    assert env.core.scene_kind == "cross"

    env.reset()
    obs, _, _, _, info = env.step(np.array([1.0, 0.0]))
    assert obs.shape == (OBS_DIM,)
    assert info["curriculum_advanced"] is True
    assert info["new_scene"] == "t_junction"
    assert env.core.scene_kind == "t_junction"
    assert env.scheduler.state.current_scene_idx == 1
    assert env.scheduler.state.scene_history == [{"scene": "cross", "scene_idx": 0, "episodes": 2}]
    assert env._prev_episode_reward == 0.0
    assert env._prev_episode_info == {}


def test_step_records_episode_on_truncation_too() -> None:
    env = _stubbed([[(1.25, False, True, "")]])
    env.reset()
    _, _, terminated, truncated, info = env.step(np.array([1.0, 0.0]))
    assert (terminated, truncated) == (False, True)
    assert "curriculum_advanced" not in info
    assert env.scheduler.state.episode_rewards == [1.25]
    assert env.scheduler.state.episode_successes == [False]
    assert env._prev_episode_reward == 0.0


def test_step_uses_only_the_final_step_info_for_the_success_flag() -> None:
    env = _stubbed([[(1.0, False, False, "success"), (1.0, True, False, "collision")]])
    env.reset()
    env.step(np.array([1.0, 0.0]))
    env.step(np.array([1.0, 0.0]))
    assert env.scheduler.state.episode_rewards == [2.0]
    assert env.scheduler.state.episode_successes == [False]


def test_step_does_not_switch_scene_when_thresholds_are_missed() -> None:
    env = _stubbed([[(0.1, False, True, "")], [(0.1, False, True, "collision")]])
    env.reset()
    env.step(np.array([1.0, 0.0]))
    env.reset()
    _, _, _, _, info = env.step(np.array([1.0, 0.0]))
    assert "curriculum_advanced" not in info
    assert "new_scene" not in info
    assert env.core.scene_kind == "cross"
    assert env.scheduler.state.current_scene_idx == 0
    assert env.get_curriculum_status()["episodes_on_scene"] == 2
    assert env.get_curriculum_status()["avg_reward"] == 0.1


def test_finishing_the_curriculum_leaves_the_last_scene_in_place() -> None:
    """`advance()` returns None once complete, so no `new_scene` is emitted."""
    episodes = [[(6.0, False, True, "collision")]]
    env = _stubbed(episodes * 4, eval_window=1)
    env.scheduler.state.current_scene_idx = 3  # jump to the last scene
    env.reset()
    _, _, _, _, info = env.step(np.array([1.0, 0.0]))
    assert env.scheduler.state.is_complete is True
    assert env.scheduler.state.current_scene == "corridor"
    assert "curriculum_advanced" not in info
    assert "new_scene" not in info
    assert env.core.scene_kind == "corridor"  # never switched away from corridor
    assert [h["scene"] for h in env.scheduler.state.scene_history] == ["corridor"]


def test_finishing_the_curriculum_emits_a_distinct_completion_signal() -> None:
    """`advance()` returns None for "not yet" and for "just graduated" alike.

    Before 2026-10-18 the two were indistinguishable from `info`, so a training
    loop watching for `curriculum_advanced` never learned the agent graduated.
    """
    episodes = [[(6.0, False, True, "collision")]]
    env = _stubbed(episodes * 4, eval_window=1)
    env.scheduler.state.current_scene_idx = 3
    env.reset()
    _, _, _, _, info = env.step(np.array([1.0, 0.0]))
    assert env.scheduler.state.is_complete is True
    assert info.get("curriculum_complete") is True
    # Must NOT masquerade as a scene switch — none happened.
    assert "curriculum_advanced" not in info
    assert "new_scene" not in info


def test_missed_thresholds_do_not_emit_the_completion_signal() -> None:
    """The new key must mean "graduated", not merely "advance() returned None"."""
    # `reset()` pops one episode list from the script and each list here is a
    # single truncated step, so one reset + one step is one episode.
    env = _stubbed([[(0.1, False, True, "collision")]] * 3, eval_window=2)
    env.reset()
    _, _, _, _, info = env.step(np.array([1.0, 0.0]))
    assert env.scheduler.state.is_complete is False
    assert "curriculum_complete" not in info
    assert "curriculum_advanced" not in info


def test_scene_history_reports_lifetime_episodes_not_the_window_size() -> None:
    """`len(episode_rewards)` saturates at eval_window; the lifetime count does not.

    Before 2026-10-18 `scene_history[...]["episodes"]` recorded
    `len(episode_rewards)`, which is capped at `eval_window` — so a scene that
    took 7 episodes to master with a window of 3 reported "3".
    """
    sched = CurriculumScheduler(eval_window=3)
    # 7 mediocre episodes then 3 good ones → advances on the 10th.
    for _ in range(7):
        sched.record_episode(0.0, {"reason": "collision"})
    for _ in range(3):
        sched.record_episode(9.0, {"reason": "success_goal"})

    assert sched.should_advance() is True
    sched.advance()
    history = sched.state.scene_history
    assert len(history) == 1
    assert history[0]["scene"] == "cross"
    assert history[0]["episodes"] == 10  # lifetime, not min(10, eval_window=3)


def test_episodes_counter_resets_when_the_scene_changes() -> None:
    sched = CurriculumScheduler(eval_window=1)
    sched.record_episode(9.0, {"reason": "success_goal"})
    sched.advance()
    assert sched.state.episodes_on_current_scene == 0
    assert sched.get_status()["episodes_on_current_scene"] == 0
    sched.record_episode(1.0, {"reason": "collision"})
    assert sched.get_status()["episodes_on_current_scene"] == 1
    # The windowed metric is still independent of the lifetime one.
    assert sched.get_status()["episodes_on_scene"] == 1


def test_env_advances_against_the_real_sim_core() -> None:
    """End-to-end with the genuine SimCore: 2 truncated episodes, bar 0.15."""
    env = CurriculumEnv(
        max_steps=5,
        eval_window=2,
        thresholds={"cross": {"avg_reward": 0.15, "success_rate": 1.0}},
    )
    episode_totals: list[float] = []
    for _ in range(2):
        env.reset(seed=42)
        total = 0.0
        for i in range(5):
            _, reward, terminated, truncated, _ = env.step(np.array([1.0, 0.0], dtype=np.float32))
            total += reward
            assert terminated is False
            # SimCore only sets truncated on the step that reaches max_steps
            assert truncated is (i == 4)
        episode_totals.append(total)

    # Plan 076 T12: the reward is PROGRESS_WEIGHT * progress - TIME_COST, so
    # a step pays its progress (0.03, 0.06, 0.09, 0.12, 0.15 m) and is
    # charged 0.05 for the time it took:
    # -0.02+0.01+0.04+0.07+0.10 per truncated episode -> 0.20, which clears
    # the 0.15 bar.
    assert episode_totals == [pytest.approx(0.20), pytest.approx(0.20)]
    assert env.scheduler.state.episode_rewards == []  # cleared by advance()
    assert env.scheduler.state.scene_history == [{"scene": "cross", "scene_idx": 0, "episodes": 2}]
    assert env.scheduler.state.current_scene == "t_junction"
    assert env.core.scene_kind == "t_junction"
    assert env._prev_episode_reward == 0.0
    # truncated episodes carry reason "" -> no success credit
    assert env.get_curriculum_status()["success_rate"] == 0.0


def test_extra_steps_after_the_time_limit_do_not_record_extra_episodes() -> None:
    """The truncation flag must be an *edge*, not a level.

    `sim_core` recomputed `truncated` from `step_count >= max_steps` on every
    step, so once the limit was reached **every** following step also reported
    `truncated=True`. `CurriculumEnv.step` records an episode whenever
    `terminated or truncated`, so a caller that did not reset promptly (which
    Gymnasium forbids but does not prevent) recorded one episode per extra
    step — and each of those could advance the curriculum again.
    """
    env = CurriculumEnv(max_steps=3, eval_window=1)
    env.reset()

    # Run well past the 3-step limit without resetting.
    for _ in range(6):
        env.step(np.array([0.0, 0.0], dtype=np.float32))

    # Exactly ONE episode must have been recorded, not six.
    assert env.scheduler.state.episodes_on_current_scene == 1


def test_extra_steps_after_termination_do_not_record_extra_episodes() -> None:
    """Same edge-vs-level problem for the terminated flag.

    `sim_core` has always re-reported `terminated=True` on every step after a
    terminal state (it early-returns `(obs, 0.0, True, False, ...)`), so this
    was never specific to truncation.
    """
    env = CurriculumEnv(max_steps=500, eval_window=1)
    env.reset()

    # Drive until the episode actually ends on its own.
    ended = False
    for _ in range(400):
        _, _, terminated, truncated, _ = env.step(np.array([1.0, 0.0], dtype=np.float32))
        if terminated or truncated:
            ended = True
            break
    assert ended, "the episode should have terminated within 400 steps"

    # Keep stepping without resetting.
    for _ in range(5):
        env.step(np.array([1.0, 0.0], dtype=np.float32))

    # The observable here is the number of *advancements*, not the episode
    # counter: `advance()` resets `episodes_on_current_scene` to 0, so that
    # counter cannot show how many episodes were recorded. `scene_history`
    # can — one entry per advancement, each carrying the lifetime episode
    # count for the scene it left behind.
    #
    # Before the fix the extra steps re-reported `terminated=True`, so each
    # one recorded another episode and advanced again: one episode walked the
    # whole curriculum (4 history entries, current_scene_idx=4).
    history = env.scheduler.state.scene_history
    assert len(history) == 1, f"expected exactly one advancement, got {history}"
    assert history[0]["episodes"] == 1, f"expected one recorded episode, got {history}"
