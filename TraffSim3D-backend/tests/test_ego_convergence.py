"""Plan 076 T11: the training sim's ego must steer **towards** its target.

This is the regression test for the defect Plan 076 T11 fixed.

The Pure Pursuit steering law

    steer = atan2(2 · wheelbase · sin(alpha), lookahead)

is only correct for the textbook alpha — the angle **from the vehicle's
heading to the target direction**, i.e. `alpha = target_angle - heading`.
The sim computed `alpha = heading - target_angle`, so `sin(alpha)` had the
opposite sign and the ego steered **away** from its target.

Why it survived for years: every scene and every contract vector put the ego
on a straight line to its target, so `alpha ≈ 0`, `steer ≡ 0`, and the sign
was invisible. The contract could not see it either — both sides implemented
the same wrong sign, so they matched bit for bit.

Measured before the fix (120 steps, full throttle, target 25.7 m away):
the distance to the target grew to **150.9 m**. After the fix it shrinks to
**5.8 m**.
"""

from __future__ import annotations

import math

import numpy as np

from app.apps.rl.sim_core import MAX_STEER, SimCore

#: The `cross` scene's Pure Pursuit target: the intersection centre.
TARGET = (0.0, 0.0)

#: A start pose **off** the target line, so the Pure Pursuit angle is
#: non-zero and the sign of the steer decides everything.
OFFSET_START = {"x": 6.0, "z": -25.0, "heading": math.pi / 2}


def _episode(start: dict[str, float], scene: str, steps: int) -> SimCore:
    core = SimCore(scene_kind=scene, max_steps=steps + 1)
    core.reset()
    core.ego.x = start["x"]
    core.ego.z = start["z"]
    core.ego.heading = start["heading"]
    core.ego.speed = 0.0
    return core


def _distances(start: dict[str, float], steps: int = 120) -> list[float]:
    """The distance to the target after every step."""
    core = _episode(start, "roundabout", steps)
    distances: list[float] = []
    for _ in range(steps):
        core.step(np.array([1.0, 0.0], dtype=np.float32))
        distances.append(math.hypot(core.ego.x - TARGET[0], core.ego.z - TARGET[1]))
        if core._terminated or core._truncated:
            break
    return distances


def test_the_ego_converges_on_an_offset_target() -> None:
    """The distance to the target must shrink, not grow.

    With the inverted alpha the ego drove away from the target and the
    distance grew to 150.9 m (from 25.7 m) — the training environment was
    teaching the ego to steer the wrong way.
    """
    distances = _distances(OFFSET_START)
    assert distances, "the episode ran no step"
    assert distances[-1] < distances[0], (
        f"the ego did not approach its target: the distance went "
        f"{distances[0]:.3f} -> {distances[-1]:.3f} m"
    )
    # And it really arrives: the target is 25.7 m away at the start.
    assert (
        distances[-1] < 0.5 * distances[0]
    ), f"the ego only got halfway: {distances[0]:.3f} -> {distances[-1]:.3f} m"


def test_the_steer_points_towards_the_target() -> None:
    """The sign of the steer itself, not just the outcome.

    With the ego due north and the target to its **west** (a larger
    `targetAngle` in the (x, z) plane), the alpha is positive and the steer
    must be positive too — the heading has to move towards the target's
    angle. With the inverted sign the heading moved the other way.
    """
    core = _episode({"x": 20.0, "z": -25.0, "heading": math.pi / 2}, "cross", 1)
    target_angle = math.atan2(TARGET[1] - core.ego.z, TARGET[0] - core.ego.x)
    assert target_angle > core.ego.heading, "the target should be to the vehicle's left"

    before = core.ego.heading
    core.step(np.array([1.0, 0.0], dtype=np.float32))
    assert (
        core.ego.heading > before
    ), f"the heading moved away from the target: {before} -> {core.ego.heading}"
    # The steer is an angle, applied over one timestep.
    steer = (core.ego.heading - before) / 0.1
    assert steer <= MAX_STEER + 1e-9, "the steer must respect the clamp"


def test_the_heading_settles_on_the_target_direction() -> None:
    """At some point of the manoeuvre the vehicle **points** at the target.

    A Pure Pursuit tracks a point, it does not stop at it: the ego converges
    on the target, overshoots it and then swings back to chase it again.
    So the property to assert is not "it ends up pointing at the target" but
    "the heading error against the target direction becomes small" — that is
    what "tracking" means.
    """
    core = _episode(OFFSET_START, "roundabout", 120)
    best = math.pi
    for _ in range(120):
        core.step(np.array([1.0, 0.0], dtype=np.float32))
        to_target = math.atan2(TARGET[1] - core.ego.z, TARGET[0] - core.ego.x)
        error = abs((core.ego.heading - to_target + math.pi) % (2 * math.pi) - math.pi)
        best = min(best, error)
        if core._terminated or core._truncated:
            break
    assert best < 0.2, (
        f"the vehicle never pointed at the target: the closest heading error " f"was {best:.3f} rad"
    )
