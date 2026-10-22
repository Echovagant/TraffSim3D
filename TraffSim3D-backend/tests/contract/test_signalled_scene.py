"""The signalled scene — the contract gates that make it real.

The finding was that the ego **never faces a red light** in the
four training scenes: the light's phase clock advances every step, but the
30 s cycle puts the first phase change on step 300 — beyond every ego
episode. A scripted controller therefore never pays the -5 red-light
penalty, and "the AI beats the scripted baseline" was **unreachable**
(the baseline sits exactly on the physical step lower bound).

The signalled scene gives the ego a decision: `cross_signalled`, whose
own axis starts **red** and turns green on step 121, inside the episode.
Two contract vectors cover it:

1. `cross_signalled_light_phase` — a parked ego, 300 steps: the golden's
   sampled light bits show the phase changing (red until the sample on
   step 130, green until the sample on step 250, red again). That makes
   the scene's **light schedule** observable for the first time.
2. `cross_signalled_red_light` — a full-throttle ego: it enters the
   intersection on step 34, while its own axis is still red, and both
   sides call it a red-light run.

Every gate here is a **mutation**: the rule is broken at runtime on the
Python side and the contract's own comparison has to go red. A vector that
cannot detect the broken rule would be decoration, not a gate.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from app.apps.rl import sim_core
from app.apps.rl.sim_core import SimCore

try:
    # pytest's default ("prepend") import mode puts this directory on
    # `sys.path`, so the sibling module is importable by its bare name.
    from test_cross_lang_consistency import (
        _LIBM_NOISE_FLOOR,
        _assert_agrees,
        _ensure_python_snapshot,
        _golden_path,
        _vector,
    )
except ImportError:  # pragma: no cover - alternative import mode
    from tests.contract.test_cross_lang_consistency import (
        _LIBM_NOISE_FLOOR,
        _assert_agrees,
        _ensure_python_snapshot,
        _golden_path,
        _vector,
    )

CONTRACT_DIR = Path(__file__).parent
VECTOR_PATH = CONTRACT_DIR / "test_vector.json"

#: The vector that observes the scene's phase timeline.
PHASE_VECTOR = "cross_signalled_light_phase"
#: The vector that runs the red light.
RED_LIGHT_VECTOR = "cross_signalled_red_light"
#: The vector that drives the ego all the way across the intersection
#: (with the light overridden to green), i.e. the one that exercises the
#: scene's Pure Pursuit **target**.
CROSSING_VECTOR = "cross_signalled_full_crossing"


def _sample_every() -> int:
    data = json.loads(VECTOR_PATH.read_text(encoding="utf-8"))
    return int(data.get("sample_every", 5))


def _golden(name: str) -> dict:
    return json.loads(_golden_path(name).read_text(encoding="utf-8"))


def _light_changes(golden: dict) -> list[int]:
    """The sample steps at which the golden's light bits change."""
    changes: list[int] = []
    previous: tuple[bool, bool] | None = None
    for sample in golden["samples"]:
        bits = (sample["light"]["nsGreen"], sample["light"]["ewGreen"])
        if previous is not None and bits != previous:
            changes.append(sample["step"])
        previous = bits
    return changes


def _zero_action() -> np.ndarray:
    return np.asarray([0.0, 0.0], dtype=np.float32)


# --------------------------------------------------------------------------
# The scene's light schedule
# --------------------------------------------------------------------------


def test_the_scene_starts_on_the_red() -> None:
    """The ego's axis starts red - that is the whole point of the scene.

    The four scenes above start green and stay green for the whole
    episode, which is why the ego never faced a red light in them.
    """
    core = SimCore(scene_kind="cross_signalled")
    core.reset()

    assert core.light.ns_green is False
    assert core.light.ew_green is True
    assert core.light.cycle_duration == sim_core.CROSS_SIGNALLED_CYCLE_SECONDS


def test_the_phase_change_lands_inside_the_episode() -> None:
    """The phase change must land inside the episode, not beyond it.

    This is what the signalled scene exists for: the default 30 s cycle swaps
    on step 300, which no ego episode ever reaches.
    """
    core = SimCore(scene_kind="cross_signalled", max_steps=300)
    core.reset()

    swap_step: int | None = None
    for step in range(1, 301):
        core.step(_zero_action())
        if core.light.ns_green:
            swap_step = step
            break

    assert swap_step is not None, "the light never turned green"
    assert swap_step < 300, (
        f"the phase change lands on step {swap_step} - beyond the episode, "
        "so the ego would never face a red light again"
    )
    # The measured value: 12 s at 10 Hz. It is 121 and not 120 because the
    # phase clock accumulates `DT` 121 times and the sum (11.999999999999998
    # after 120 additions) only reaches the 12 s cycle on the 121st step.
    assert swap_step == 121


def test_the_phase_timeline_is_visible_in_the_golden() -> None:
    """The golden records the phase changes, so the contract can see them.

    The sample stride is 10, so a change on step 120 is first *seen* on
    the sample of step 130, and the second change (step 240) on the sample
    of step 250.
    """
    golden = _golden(PHASE_VECTOR)
    assert _light_changes(golden) == [130, 250], (
        "the phase timeline is not observable in the golden - the light "
        "schedule is a blind spot again"
    )


def test_a_different_cycle_length_changes_the_golden(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Mutation gate: the cycle length is observable on both sides.

    A 10 s cycle instead of the 12 s one moves the phase changes to steps
    101 and 201, which the sampled light bits show (on the samples of
    steps 110 and 210).
    """
    v = _vector(PHASE_VECTOR)
    ts = _golden(PHASE_VECTOR)

    monkeypatch.setattr(sim_core, "CROSS_SIGNALLED_CYCLE_SECONDS", 10.0)
    mutated = _ensure_python_snapshot(v, sample_every=_sample_every())

    assert _light_changes(mutated) == [110, 210], (
        "the mutated cycle does not move the phase timeline - the vector "
        "does not observe the schedule"
    )
    with pytest.raises(AssertionError):
        _assert_agrees(v, mutated, ts, _LIBM_NOISE_FLOOR)


def test_a_green_start_changes_the_golden(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Mutation gate: the scene's *starting phase* is observable too.

    If the scene started green (as the other four do), the ego would
    never face a red light and the scene would be pointless - so the
    contract has to notice.
    """
    v = _vector(PHASE_VECTOR)
    ts = _golden(PHASE_VECTOR)

    original_reset = SimCore._reset_cross_signalled

    def green_start(self: SimCore) -> object:
        original_reset(self)
        self.light.ns_green = True
        self.light.ew_green = False
        return self._obs()

    monkeypatch.setattr(SimCore, "_reset_cross_signalled", green_start)
    mutated = _ensure_python_snapshot(v, sample_every=_sample_every())

    assert mutated["samples"][0]["light"] != ts["samples"][0]["light"]
    with pytest.raises(AssertionError):
        _assert_agrees(v, mutated, ts, _LIBM_NOISE_FLOOR)


# --------------------------------------------------------------------------
# The red-light rule, in the new scene
# --------------------------------------------------------------------------


def test_running_the_red_light_is_punished() -> None:
    """The vector terminates on a red-light run, on both sides."""
    golden = _golden(RED_LIGHT_VECTOR)
    assert golden["final_state"]["reason"] == "red_light"
    assert golden["final_state"]["terminated"] is True
    # It really entered the intersection (that is what the rule needs).
    assert abs(golden["final_state"]["final_z"]) < sim_core.INTERSECTION_RADIUS


def test_without_the_red_light_rule_the_vector_would_not_terminate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Mutation gate: the red-light rule is what ends that episode.

    With the rule disabled the ego drives on through the intersection
    and the episode ends differently - so the vector really pins it.
    """
    v = _vector(RED_LIGHT_VECTOR)
    ts = _golden(RED_LIGHT_VECTOR)

    monkeypatch.setattr(SimCore, "_check_red_light_run", lambda self: False)
    mutated = _ensure_python_snapshot(v, sample_every=_sample_every())

    assert (
        mutated["final_state"]["reason"] != "red_light"
    ), "the vector no longer discriminates the red-light rule"
    with pytest.raises(AssertionError):
        _assert_agrees(v, mutated, ts, _LIBM_NOISE_FLOOR)


def test_the_two_sides_agree_on_the_red_light_run() -> None:
    """The red-light vector's trajectory is compared like any other."""
    v = _vector(RED_LIGHT_VECTOR)
    py = _ensure_python_snapshot(v, sample_every=_sample_every())
    ts = _golden(RED_LIGHT_VECTOR)
    _assert_agrees(v, py, ts, _LIBM_NOISE_FLOOR)


# --------------------------------------------------------------------------
# The scene's Pure Pursuit target
# --------------------------------------------------------------------------


def test_the_crossing_vector_drives_past_the_intersection() -> None:
    """The vector has to exercise the part of the route the target drives.

    The signalled scene's Pure Pursuit target is the **goal
    line**, not the intersection centre (a point the ego passes on the way
    - after which the scripted pursuit pulls the ego back and its heading
    drops). The other two vectors stop before that point, so only this one
    can see the target.
    """
    golden = _golden(CROSSING_VECTOR)

    assert golden["final_state"]["reason"] == "success"
    assert golden["final_state"]["final_z"] > 20.0, (
        "the vector does not reach the far side of the intersection - it "
        "cannot observe the pursuit target"
    )
    # It crosses the intersection centre (z = 0) on the way.
    assert any(sample["z"] < 0.0 < golden["final_state"]["final_z"] for sample in golden["samples"])


def test_the_pursuit_target_is_observable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Mutation gate: the signalled scene's pursuit target is observable.

    Putting the target back to the intersection centre (0, 0) - the
    `cross` scene's target - pulls the ego back after the crossing and
    changes the trajectory, so the contract has to notice.
    """
    v = _vector(CROSSING_VECTOR)
    ts = _golden(CROSSING_VECTOR)

    monkeypatch.setattr(SimCore, "pursuit_target", lambda self: (0.0, 0.0))
    mutated = _ensure_python_snapshot(v, sample_every=_sample_every())

    assert mutated["samples"] != ts["samples"], (
        "the mutated pursuit target did not change the trajectory - the "
        "vector does not observe the target"
    )
    with pytest.raises(AssertionError):
        _assert_agrees(v, mutated, ts, _LIBM_NOISE_FLOOR)


def test_the_signalled_scene_pursues_its_goal_line() -> None:
    """The target is the goal line - a point that stays ahead of the ego."""
    core = SimCore(scene_kind="cross_signalled")
    core.reset()

    target = core.pursuit_target()
    assert target == (0.0, sim_core.SCENE_GOAL_Z["cross_signalled"])
    assert target[1] > sim_core.SCENE_GOAL_Z["cross_signalled"] * 0.9
