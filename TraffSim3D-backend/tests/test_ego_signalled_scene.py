"""Plan 076 T13: the signalled scene — the ego's traffic-light compliance.

Plan 076 T12 measured that the ego **never faces a red light** in the four
training scenes: the light's phase clock advances every step, but the 30 s
cycle puts the first phase change on step 300 — beyond every ego episode
(`tests/test_ego_step_lower_bound.py` pins that). A scripted controller was
therefore never punished for ignoring the light, and the headline gate
("beat scripted pursuit + the best constant throttle") was **unreachable**:
the baseline sat exactly on the physical step lower bound.

T13 adds `cross_signalled`: the ego's axis starts **red** and turns green on
step 121, inside the episode and inside the ego's approach. These are the
regression gates for that scene:

1. a red light keeps the ego **before the stop line** — it may not enter
   the intersection;
2. the green lets it start and drive through;
3. running the red is still punished (-5) — the existing rule does not
   regress;
4. a stopped ego is **never** hit by the cross traffic — the scene is
   winnable (this is the measured geometry the scene layout is built on);
5. the strongest constant throttle is **not** on the physical bound any
   more — that is the whole point of the scene (the bound itself is
   pinned in `tests/test_ego_step_lower_bound.py`);
6. an **unknown** scene name is an error, not a silent fall-through to
   the `cross` scene.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.apps.rl import ego_eval
from app.apps.rl.env import TrafficEnv
from app.apps.rl.sim_core import (
    INTERSECTION_RADIUS,
    SCENE_GOAL_Z,
    STOP_LINE_DISTANCE,
    TIME_COST,
    SimCore,
)

SCENE = "cross_signalled"
#: The step the scene's light turns green on (12 s at the 10 Hz clock).
GREEN_STEP = 121
#: The z of the stop line: the edge of the intersection box.
STOP_Z = -STOP_LINE_DISTANCE


def _drive(core: SimCore, action: tuple[float, float], steps: int) -> float:
    """Step `core` and return the accumulated reward."""
    total = 0.0
    for _ in range(steps):
        _, reward, terminated, truncated, _ = core.step(
            np.array([action[0], action[1]], dtype=np.float32)
        )
        total += float(reward)
        if terminated or truncated:
            break
    return total


def _wait_for_green(core: SimCore) -> None:
    """Hold the ego still until its own axis is green."""
    while not core.light.ns_green:
        core.step(np.array([0.0, 0.0], dtype=np.float32))


# --------------------------------------------------------------------------
# 1. The red light keeps the ego before the stop line
# --------------------------------------------------------------------------


def test_the_scene_starts_with_a_red_light_on_the_ego_axis() -> None:
    """The ego's axis is red at the first step — that is the scene."""
    core = SimCore(scene_kind=SCENE, max_steps=200)
    core.reset()

    assert core.light.ns_green is False
    assert core.light.ew_green is True
    assert core.ego.z < STOP_Z


def test_a_stopped_ego_never_enters_the_intersection() -> None:
    """Holding still through the red keeps the ego outside the box.

    The rule the scene exercises is the red-light rule itself: the ego may
    not be **inside** the intersection while its own axis is red. The stop
    line is the edge of that box.
    """
    core = SimCore(scene_kind=SCENE, max_steps=200)
    core.reset()

    _drive(core, (0.0, 0.0), 200)

    assert core.ego.z <= STOP_Z, f"the ego reached z={core.ego.z}, past the stop line at {STOP_Z}"
    assert core._terminated_reason != "red_light"
    assert core._terminated_reason != "collision"


def test_a_creeping_ego_that_keeps_going_is_stopped_by_the_red_light() -> None:
    """A driver that does not look at the light is stopped at the line.

    The ego enters the intersection on step 34 and the run is punished:
    the episode ends with `red_light`.
    """
    core = SimCore(scene_kind=SCENE, max_steps=200)
    core.reset()

    _drive(core, (1.0, 0.0), 200)

    assert core._terminated_reason == "red_light"
    assert core.ego.z > STOP_Z, "the ego never reached the intersection"


# --------------------------------------------------------------------------
# 2. The green lets it start and drive through
# --------------------------------------------------------------------------


def test_the_green_lets_the_ego_start_and_reach_the_goal() -> None:
    """A driver that waits for the green drives the whole route.

    This is the behaviour the gate is about: the same route, the same
    physics, the only difference is that the driver looked at the light.
    """
    core = SimCore(scene_kind=SCENE, max_steps=200)
    core.reset()

    _wait_for_green(core)
    assert core.light.ns_green

    total = _drive(core, (1.0, 0.0), 200)

    assert core._terminated_reason == "success"
    assert core.ego.z > SCENE_GOAL_Z[SCENE]
    assert total > 0.0, f"the successful run scored {total:.3f}"


def test_waiting_for_the_green_beats_running_the_red() -> None:
    """The two behaviours, measured on the same scene.

    This is the gate's core claim, measured on the *reference* policies
    (not on a trained one): the scripted driver that looks at the light
    scores strictly more than the one that does not.
    """
    compliant = SimCore(scene_kind=SCENE, max_steps=200)
    compliant.reset()
    _wait_for_green(compliant)
    compliant_return = _drive(compliant, (1.0, 0.0), 200)

    reckless = SimCore(scene_kind=SCENE, max_steps=200)
    reckless.reset()
    reckless_return = _drive(reckless, (1.0, 0.0), 200)

    assert compliant_return > reckless_return, (
        f"waiting for the green ({compliant_return:.3f}) must beat running "
        f"the red ({reckless_return:.3f})"
    )


# --------------------------------------------------------------------------
# 3. The red-light rule itself does not regress
# --------------------------------------------------------------------------


def test_the_red_light_penalty_is_still_five() -> None:
    """The -5 penalty is unchanged - T13 adds a scene, not a new rule.

    The terminating step's reward is exactly the progress it made, minus
    the time it cost, minus the 5-point penalty.
    """
    core = SimCore(scene_kind=SCENE, max_steps=200)
    core.reset()

    rewards: list[float] = []
    for _ in range(200):
        _, reward, terminated, truncated, _ = core.step(np.array([1.0, 0.0], dtype=np.float32))
        rewards.append(float(reward))
        if terminated or truncated:
            break

    progress = core.ego.z - (-25.0)
    expected = progress - TIME_COST * len(rewards) - 5.0
    assert sum(rewards) == pytest.approx(expected, abs=1e-9), (
        f"the red-light run scored {sum(rewards):.3f}, expected {expected:.3f} "
        "(the progress, minus the time cost, minus the 5-point penalty)"
    )


def test_the_other_scenes_still_start_green() -> None:
    """T13 adds a scene; it does not change the four existing ones."""
    for scene in ("cross", "corridor", "t_junction"):
        core = SimCore(scene_kind=scene, max_steps=200)
        core.reset()
        assert core.light.ns_green is True, f"{scene} no longer starts green"
        assert core.light.cycle_duration == 30.0, (
            f"{scene}'s light cycle changed - T12's conclusion (the first "
            "swap on step 300, beyond every episode) has to be re-measured"
        )


# --------------------------------------------------------------------------
# 4. The stopped ego is never hit by the cross traffic
# --------------------------------------------------------------------------


def test_a_stopped_ego_is_never_hit_by_the_cross_traffic() -> None:
    """The scene is winnable: nothing runs into the waiting ego.

    This is the **measured** geometry the scene's NPC layout is built on:
    the default traffic model's out-of-bounds rule mirrors an NPC's x
    (`x -> -0.8 x`), which converges onto the ego's own centreline within
    two respawns — so a north-south NPC would rear-end the ego while it
    waits. The scene therefore carries only the east-west cross traffic,
    which never comes within 5.2 m of an ego stopped at the stop line.
    """
    core = SimCore(scene_kind=SCENE, max_steps=300)
    core.reset()

    closest = min(
        (float(np.hypot(npc.x - core.ego.x, npc.z - core.ego.z)) for npc in core.npcs),
        default=float("inf"),
    )
    _drive(core, (0.0, 0.0), 300)

    assert (
        core._terminated_reason != "collision"
    ), "the waiting ego was hit - the scene's NPC layout is wrong"
    assert closest >= 2.0, f"an NPC starts {closest:.2f} m from the ego"


# --------------------------------------------------------------------------
# 5. The strongest constant throttle is no longer on the physical bound
# --------------------------------------------------------------------------


def test_the_strongest_constant_baseline_is_not_on_the_bound_here() -> None:
    """The opposite of the four scenes: the baseline **fails** here.

    The four scenes' baseline sits exactly on the physical step lower
    bound, which is why the gate was unreachable there (Plan 076 T12). In
    this scene the full-throttle baseline runs the red light instead, so
    the baseline is provably **not** optimal — a driver that looks at the
    light can beat it.
    """
    result = ego_eval.evaluate_constant_throttle(
        ego_eval.FULL_THROTTLE, scene_kind=SCENE, steps=ego_eval.EVAL_STEPS
    )

    assert result["reason"] == "red_light"
    assert result["steps"] < ego_eval.EVAL_STEPS


def test_the_scene_goal_line_is_the_cross_scenes() -> None:
    """The two scenes differ in the light schedule, not in the route."""
    assert SCENE_GOAL_Z[SCENE] == SCENE_GOAL_Z["cross"]
    assert INTERSECTION_RADIUS == 8.0


# --------------------------------------------------------------------------
# 6. An unknown scene name is an error, never a silent fall-through
# --------------------------------------------------------------------------


def test_an_unknown_scene_name_raises_instead_of_running_the_cross_scene() -> None:
    """Plan 076 T13: a typo must not measure a different scene.

    `SimCore.reset()` used to fall through to the `cross` scene for any
    scene name it did not recognise. A caller that asked for a scene that
    does not exist therefore measured the **cross** scene — and its
    numbers looked perfectly plausible (52.100 over 58 steps with a
    `success` termination), so the mistake was invisible in the report.
    """
    core = SimCore(scene_kind="cross_signalled_typo", max_steps=200)
    with pytest.raises(ValueError, match="unknown scene_kind"):
        core.reset()


def test_an_unknown_scene_name_raises_through_the_env_too() -> None:
    """The same guard, one layer up: the Gymnasium env must not lie either."""
    env = TrafficEnv(max_steps=200, scene_kind="not_a_scene")
    with pytest.raises(ValueError, match="unknown scene_kind"):
        env.reset(seed=0)


@pytest.mark.parametrize("scene", sorted(SCENE_GOAL_Z))
def test_every_known_scene_name_still_resets(scene: str) -> None:
    """The guard must not break the five real scenes."""
    core = SimCore(scene_kind=scene, max_steps=200)
    obs = core.reset()
    assert obs.shape == (14,)
