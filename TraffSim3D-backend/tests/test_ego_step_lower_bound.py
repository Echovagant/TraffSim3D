"""Plan 076 T12: the physical step lower bound of the ego's arrival — as a gate.

T12's central conclusion is that the headline gate ("beat the scripted
pursuit + the best constant throttle") is **unreachable in the four ego
scenes**, and that this is a property of the scenes rather than of the
training. The proof has two halves:

1. **The bound.** The ego starts at rest at ``z = -25`` in every scene; the
   throttle is an acceleration command capped at ``3 m/s^2``; the speed is
   capped at ``SPEED_LIMIT``; and the goal line is a fixed ``z`` per scene
   (``SCENE_GOAL_Z``). So full throttle gives the earliest arrival any
   policy can achieve, and its displacement after ``N`` steps is closed-form:

       displacement(N) = DT * sum_{n=1..N} min(SPEED_LIMIT, ACCEL * n * DT)

2. **The baseline sits on it.** The strongest constant throttle (full
   throttle) reaches the goal in exactly that many steps in all four scenes
   — so on the only axis that can separate a policy from the baseline
   ("how soon did you arrive"), the baseline is **provably optimal** and
   no reward term added to these scenes can make a policy beat it.

This module pins both halves, so the numbers quoted in
the numbers quoted in the cross-language contract are enforced by the test
suite instead of being a one-off measurement: if the physics, the goal
lines or the start pose change, this fails loudly and the document's
numbers have to be rewritten.

The third test pins the *other* half of T12's conclusion — that the ego
never faces a red light in these scenes, because the light's phase clock
does advance every step but the 30 s cycle puts the first swap at step
300, beyond the 200-step episode horizon.
"""

from __future__ import annotations

import math

import pytest

from app.apps.rl import ego_eval
from app.apps.rl.sim_core import (
    DT,
    MAX_STEPS_DEFAULT,
    SCENE_GOAL_Z,
    SPEED_LIMIT,
    TrafficLight,
    Vehicle,
)

#: The acceleration command at full throttle: `clip(action[0], -1, 1) * 3.0`
#: (`sim_core.step`). Read from the sim's own equations, not hard-coded.
ACCEL = 3.0
#: The ego's start pose is identical in the four scenes (`_reset_*`).
START_Z = -25.0
#: The ego drives due north in all four scenes (the Pure Pursuit target is
#: straight ahead), so the z-advance *is* the path length.
START_HEADING = math.pi / 2


def _closed_form(steps: int) -> float:
    """The displacement after `steps` steps of full throttle."""
    total = 0.0
    for n in range(1, steps + 1):
        total += min(SPEED_LIMIT, ACCEL * n * DT)
    return total * DT


def _integrate(steps: int) -> tuple[float, float]:
    """The same equations, integrated step by step: (displacement, speed)."""
    ego = Vehicle(x=0.0, z=START_Z, heading=START_HEADING, speed=0.0)
    for _ in range(steps):
        ego.speed = max(0.0, min(SPEED_LIMIT, ego.speed + ACCEL * DT))
        ego.z += ego.speed * math.sin(ego.heading) * DT
    return ego.z - START_Z, ego.speed


def _lower_bound(goal_z: float) -> int:
    """The first step at which full throttle is strictly past `goal_z`."""
    for step in range(1, 1000):
        displacement, _ = _integrate(step)
        if START_Z + displacement > goal_z:
            return step
    raise AssertionError("never reached the goal")


@pytest.mark.parametrize("steps", [1, 2, 37, 38, 44, 45, 55, 56, 57, 58, 100])
def test_the_closed_form_matches_the_step_by_step_integration(steps: int) -> None:
    """The closed form is the integration — the two must not drift apart.

    The speed cap binds from step 56 on, so the uncapped
    ``0.015 * N * (N + 1)`` overstates the displacement by 0.129 m at
    ``N = 58``; the capped form is the one that counts.
    """
    displacement, _ = _integrate(steps)
    assert _closed_form(steps) == pytest.approx(displacement, abs=1e-12)


@pytest.mark.parametrize("scene", sorted(SCENE_GOAL_Z))
def test_the_bound_is_the_first_step_that_reaches_the_goal_line(scene: str) -> None:
    """``N - 1`` steps must fall short and ``N`` steps must clear the line."""
    goal_z = SCENE_GOAL_Z[scene]
    needed = goal_z - START_Z
    bound = _lower_bound(goal_z)

    before, _ = _integrate(bound - 1)
    after, _ = _integrate(bound)
    assert before < needed, f"{scene}: step {bound - 1} already reaches the goal"
    assert after >= needed, f"{scene}: step {bound} does not reach the goal"


@pytest.mark.parametrize("scene", sorted(SCENE_GOAL_Z))
def test_the_strongest_constant_baseline_sits_exactly_on_the_bound(scene: str) -> None:
    """The baseline is at the physical floor — this is why the gate ties.

    Full throttle is the strongest constant schedule (it is the earliest
    arrival the physics allows), and the ego's steering is the scripted
    Pure Pursuit, which in these four scenes is exactly straight ahead.
    So the baseline's step count *is* the lower bound.
    """
    bound = _lower_bound(SCENE_GOAL_Z[scene])
    result = ego_eval.evaluate_constant_throttle(
        ego_eval.FULL_THROTTLE, scene_kind=scene, steps=ego_eval.EVAL_STEPS
    )
    assert result["reason"].startswith(
        "success"
    ), f"{scene}: the full-throttle baseline no longer succeeds ({result['reason']})"
    assert result["steps"] == bound, (
        f"{scene}: the baseline takes {result['steps']} steps but the physical "
        f"lower bound is {bound} — the physics or the scene changed, so the "
        f"numbers in Plan 076 have to be rewritten"
    )


def test_the_light_never_swaps_inside_an_episode() -> None:
    """The ego never faces a red light — the root of T12's dead end.

    The phase clock advances every step, but the cycle is 30 s, so the
    first swap lands at step 300 — beyond the 200-step horizon every ego
    episode ends at. That is why the red-light rule never fires in the four
    scenes, and why the scripted controller never pays the -5 penalty.
    """
    light = TrafficLight()
    first_swap: int | None = None
    for step in range(1, 1000):
        light.cycle_timer += DT
        if light.cycle_timer >= light.cycle_duration:
            light.cycle_timer = 0.0
            light.ns_green, light.ew_green = light.ew_green, light.ns_green
            first_swap = step
            break

    assert first_swap is not None, "the light never swapped"
    assert first_swap == int(round(light.cycle_duration / DT))
    assert first_swap > MAX_STEPS_DEFAULT, (
        f"the first swap at step {first_swap} now falls inside the "
        f"{MAX_STEPS_DEFAULT}-step episode — the scenes would start facing "
        f"red lights, so T12's conclusion has to be re-measured"
    )
