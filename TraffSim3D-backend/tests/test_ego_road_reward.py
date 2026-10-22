"""The mileage is only earned **on the road**.

The sim latched "the ego left the road" so that the **success** needed the ego
to have *stayed* on the road - but the mileage was still paid wherever the
ego drove, so a policy could farm the progress by leaving the road.

The hole was measured on the signalled scene: the trained policy
drove off the road after the green, forfeited the +5 success bonus and
still collected the whole mileage - which is why its edge over the
strongest constant throttle existed only at the 200-step horizon (and
why a hand-written compliant driver beat it at every horizon).

The hole is closed with the rule the success already used: the progress
is zeroed for the rest of the episode once the ego has left the road, so
the rule reads in one sentence - **the ego has to stay on the road to
earn anything.**
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.apps.rl.sim_core import PROGRESS_WEIGHT, ROAD_HALF_WIDTH, TIME_COST, SimCore, Vehicle


def _drive(core: SimCore, action: tuple[float, float], steps: int) -> tuple[float, float]:
    """Drive `core`; return (accumulated reward, accumulated progress)."""
    total = 0.0
    progress = 0.0
    for _ in range(steps):
        _, reward, terminated, truncated, info = core.step(
            np.array([action[0], action[1]], dtype=np.float32)
        )
        total += float(reward)
        progress += float(info.get("progress", 0.0))
        if terminated or truncated:
            break
    return total, progress


def test_an_ego_that_never_leaves_the_road_earns_its_mileage() -> None:
    """The control: on the road, the mileage is paid as before.

    30 steps, so the episode neither succeeds (the goal line is at
    z = +25) nor truncates - the reward is then exactly the mileage
    minus the time cost.
    """
    core = SimCore(scene_kind="cross", max_steps=200)
    core.reset()

    total, progress = _drive(core, (1.0, 0.0), 30)

    assert core._off_road is False
    assert progress > 0.0, "the on-road run earned no mileage at all"
    assert total == pytest.approx(PROGRESS_WEIGHT * progress - TIME_COST * 30, abs=1e-9)


def test_an_off_road_ego_earns_no_mileage() -> None:
    """Off the road, the mileage is not paid - only the time cost is."""
    core = SimCore(scene_kind="cross", max_steps=200)
    core.reset()
    core.ego = Vehicle(x=6.0, z=-25.0, heading=math.pi / 2, speed=0.0)

    total, progress = _drive(core, (1.0, 0.0), 60)

    assert core._off_road is True
    assert progress == 0.0, f"the off-road run earned {progress:.3f} m of mileage"
    assert total == pytest.approx(-TIME_COST * 60, abs=1e-9)


def test_leaving_the_road_costs_the_rest_of_the_mileage() -> None:
    """The latch is permanent: the mileage stops for the whole episode.

    An ego that drives on the road for a while and then leaves it keeps
    the mileage it already earned, and earns nothing afterwards.
    """
    core = SimCore(scene_kind="cross", max_steps=200)
    core.reset()

    on_road, progress_on_road = _drive(core, (1.0, 0.0), 20)
    assert core._off_road is False
    assert progress_on_road > 0.0

    # Now step sideways off the road and keep driving north.
    core.ego.x = 6.0
    core.ego.heading = math.pi / 2
    off_road, progress_off_road = _drive(core, (1.0, 0.0), 20)

    assert core._off_road is True
    assert (
        progress_off_road == 0.0
    ), f"the off-road stretch earned {progress_off_road:.3f} m of mileage"
    assert off_road == pytest.approx(-TIME_COST * 20, abs=1e-9)


def test_the_off_road_run_scores_strictly_less_than_the_on_road_one() -> None:
    """The comparison the gate is made of, on the reward's own terms."""
    on_road = SimCore(scene_kind="cross", max_steps=200)
    on_road.reset()
    on_road_return, _ = _drive(on_road, (1.0, 0.0), 60)

    off_road = SimCore(scene_kind="cross", max_steps=200)
    off_road.reset()
    off_road.ego = Vehicle(x=6.0, z=-25.0, heading=math.pi / 2, speed=0.0)
    off_road_return, _ = _drive(off_road, (1.0, 0.0), 60)

    assert off_road_return < on_road_return, (
        f"the off-road run ({off_road_return:.3f}) must score worse than the "
        f"on-road one ({on_road_return:.3f})"
    )


def test_a_new_episode_clears_the_latch() -> None:
    """The rule is per-episode, like every other piece of episode state."""
    core = SimCore(scene_kind="cross", max_steps=200)
    core.reset()
    core.ego = Vehicle(x=6.0, z=-25.0, heading=math.pi / 2, speed=0.0)
    _drive(core, (1.0, 0.0), 5)
    assert core._off_road is True

    core.reset()
    assert core._off_road is False

    total, progress = _drive(core, (1.0, 0.0), 20)
    assert progress > 0.0
    assert total > 0.0


def test_the_road_half_width_is_the_boundary() -> None:
    """The rule uses the same width the success uses."""
    assert ROAD_HALF_WIDTH == 3.5

    inside = SimCore(scene_kind="cross", max_steps=200)
    inside.reset()
    inside.ego = Vehicle(x=3.4, z=-25.0, heading=math.pi / 2, speed=0.0)
    _, progress_inside = _drive(inside, (1.0, 0.0), 5)
    assert inside._off_road is False
    assert progress_inside > 0.0

    outside = SimCore(scene_kind="cross", max_steps=200)
    outside.reset()
    outside.ego = Vehicle(x=3.6, z=-25.0, heading=math.pi / 2, speed=0.0)
    _, progress_outside = _drive(outside, (1.0, 0.0), 5)
    assert outside._off_road is True
    assert progress_outside == 0.0
