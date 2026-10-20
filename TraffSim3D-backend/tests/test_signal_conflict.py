"""Plan 074 T8: the intersection conflict (the traffic layer).

One physical rule: **a vehicle may not enter the intersection while a
vehicle of the other axis occupies it** — it stops at the stop line and
waits there, behind the queue.

It is a *traffic* rule, exactly like the browser's `applyCrossRoadYield`
("first to arrive has priority"), and it lives in the responsive traffic
model — NOT in the light model, which is the cross-language contract's
sensitive area and whose default behaviour must stay bit-identical.

The browser's counterpart (`TraffSim3D-frontend/src/application/services/
tick.ts`) pairs vehicles by *road* and uses the intersection box:
`enteredIntersectionAt` is stamped while the vehicle is inside the box
and cleared when it leaves. The Python rule mirrors that exactly:

* the occupancy test is the intersection box — a vehicle is inside it when
  `|x| < INTERSECTION_RADIUS` **and** `|z| < INTERSECTION_RADIUS`;
* the conflict is *cross-axis* — two vehicles of the same axis run in
  different lanes of the same road and pass each other, so they are
  handled by the car-following rule, not by this one.

These tests pin:

* the rule itself (a cross-axis vehicle waits at the stop line and is
  released when the junction clears);
* that the same-axis traffic is not affected by it;
* that the blocking relation holds (the cross-axis queue grows while the
  junction is occupied and drains once it is clear);
* that the default path — the basis of the committed contract goldens —
  does not see the rule at all;
* the reward gate of Plan 074 §3 T8.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.apps.rl.signal_env import SignalEnv
from app.apps.rl.sim_core import (
    INTERSECTION_RADIUS,
    NPC_SPEED,
    SIGNAL_ACTION_NAMES,
    STOP_LINE_DISTANCE,
    SimCore,
    Vehicle,
    approach_axis,
    approach_distance,
)

# The action index is the position in `SIGNAL_ACTION_NAMES` — the order
# is part of the cross-language contract.
ACTION_INDEX = {name: index for index, name in enumerate(SIGNAL_ACTION_NAMES)}


def _core(
    npcs: list[Vehicle],
    *,
    ns_green: bool = True,
    ew_green: bool = False,
) -> SimCore:
    """A cross-scene core with the given NPCs and a fixed light phase."""
    core = SimCore(responsive_traffic=True)
    core.reset()
    core.npcs = npcs
    # Park the ego far outside the traffic: it would otherwise be hit by
    # an NPC (which ends the episode) and the traffic behaviour under
    # test would not be observable at all.
    core.ego.x = 60.0
    core.ego.z = -60.0
    core.ego.speed = 0.0
    core.light.ns_green = ns_green
    core.light.ew_green = ew_green
    return core


def _step(
    core: SimCore,
    steps: int = 1,
    *,
    ns_green: bool | None = None,
    ew_green: bool | None = None,
    pin: tuple[int, float, float] | None = None,
) -> None:
    """Advance the sim, optionally forcing the light's phase.

    The phase clock is reset before every step so the fixed cycle cannot
    flip the light in the middle of a test. `pin` freezes a vehicle at a
    position — it is the fixture for "the junction stays occupied".
    """
    for _ in range(steps):
        if ns_green is not None:
            core.light.ns_green = ns_green
        if ew_green is not None:
            core.light.ew_green = ew_green
        if pin is not None:
            index, x, z = pin
            core.npcs[index].x = x
            core.npcs[index].z = z
        core.light.cycle_timer = 0.0
        core.step(np.zeros(2, dtype=np.float32))


def _run(schedule: list[int], steps: int = 600) -> float:
    """Run a fixed action schedule from the default initial state."""
    env = SignalEnv(max_steps=steps)
    env.reset(seed=0)
    total = 0.0
    for index in schedule:
        _, reward, terminated, truncated, _ = env.step(index)
        total += reward
        if terminated or truncated:
            break
    return total


# --------------------------------------------------------------------------
# The rule itself
# --------------------------------------------------------------------------


def test_a_cross_axis_vehicle_stops_at_the_stop_line_while_the_junction_is_occupied() -> None:
    """The junction is occupied by an NS vehicle; the EW axis has the
    green, but its vehicle must wait at the stop line.

    This is the rule T8 adds: the green alone does not release a vehicle
    into a junction that the other axis is still using.
    """
    core = _core(
        [
            # NS, inside the junction box (just past the stop line).
            Vehicle(x=0.0, z=-7.0, heading=math.pi / 2, speed=0.0),
            # EW, one metre before its stop line.
            Vehicle(x=-9.0, z=0.0, heading=0.0, speed=NPC_SPEED),
        ],
        ns_green=False,
        ew_green=True,
    )
    # 25 steps = 2.5 s: the NS vehicle is still inside the box (it
    # accelerates from 0 and needs ~2.9 s to clear it).
    _step(core, 25)

    ew = core.npcs[1]
    assert approach_distance(ew) == pytest.approx(
        -STOP_LINE_DISTANCE, abs=1e-6
    ), "the EW vehicle must wait at the stop line"
    assert ew.speed == pytest.approx(0.0, abs=1e-9), "it must come to a full stop"
    # The junction is indeed still occupied.
    assert sorted(core._occupied_axes()) == ["ns"]


def test_the_cross_axis_vehicle_is_released_once_the_junction_is_clear() -> None:
    """The other half of the rule: the vehicle is released as soon as
    the junction is clear — the conflict is not a permanent block."""
    core = _core(
        [
            Vehicle(x=0.0, z=-7.0, heading=math.pi / 2, speed=0.0),
            Vehicle(x=-9.0, z=0.0, heading=0.0, speed=NPC_SPEED),
        ],
        ns_green=False,
        ew_green=True,
    )
    _step(core, 25)
    assert approach_distance(core.npcs[1]) == pytest.approx(-STOP_LINE_DISTANCE, abs=1e-6)

    # Clear the junction: the NS vehicle is moved out of the box.
    core.npcs[0].z = 20.0
    _step(core, 40)

    ew = core.npcs[1]
    assert approach_distance(ew) > -STOP_LINE_DISTANCE, "it must have entered the junction"
    assert ew.speed > 0.0


def test_a_vehicle_of_the_same_axis_is_not_blocked_by_the_conflict() -> None:
    """The conflict is a *cross-axis* rule, like the browser's
    `applyCrossRoadYield` (which pairs vehicles by road).

    Two vehicles of the same axis run in different lanes of the same road
    and pass each other — the car-following rule handles them, the
    conflict must not step in.
    """
    core = _core(
        [
            Vehicle(x=0.0, z=-7.0, heading=math.pi / 2, speed=0.0),
            Vehicle(x=0.0, z=-12.0, heading=math.pi / 2, speed=0.0),
        ],
        ns_green=True,
        ew_green=False,
    )
    _step(core, 25)

    follower = core.npcs[1]
    assert (
        approach_distance(follower) > -STOP_LINE_DISTANCE
    ), "the follower of the same axis must follow the leader into the junction"
    assert core.npcs[0].x == pytest.approx(0.0)


def test_the_occupancy_test_is_the_intersection_box() -> None:
    """A vehicle is *in* the junction when `|x| < INTERSECTION_RADIUS` and
    `|z| < INTERSECTION_RADIUS` — the same box the ego's own red-light
    rule uses, and the same one the browser's `enteredIntersectionAt`
    stamps."""
    core = _core([Vehicle(x=0.0, z=0.0, heading=math.pi / 2, speed=0.0)])
    assert core._occupied_axes() == {"ns"}

    # Just outside the box on the z side -> not in the junction.
    core.npcs[0].z = INTERSECTION_RADIUS + 0.01
    assert core._occupied_axes() == set()

    # Just outside on the x side -> not in the junction either.
    core.npcs[0].z = 0.0
    core.npcs[0].x = INTERSECTION_RADIUS + 0.01
    assert core._occupied_axes() == set()

    # The axis of the occupant is what is reported.
    core.npcs[0].x = 0.0
    core.npcs[0].heading = 0.0
    assert core._occupied_axes() == {"ew"}
    assert approach_axis(0.0) == "ew"


# --------------------------------------------------------------------------
# The blocking relation
# --------------------------------------------------------------------------


def test_the_cross_axis_queue_grows_while_the_junction_is_occupied() -> None:
    """Serving one axis continuously: the other axis' vehicles cannot
    enter while the junction is occupied, so their queue grows.

    The junction is held occupied by a pinned EW vehicle, so the only
    reason the NS vehicle cannot enter is the conflict rule itself.
    """
    core = _core(
        [
            # EW, pinned in the junction box for the whole test.
            Vehicle(x=0.0, z=0.0, heading=0.0, speed=0.0),
            # NS, approaching with the green.
            Vehicle(x=0.0, z=-20.0, heading=math.pi / 2, speed=NPC_SPEED),
        ],
        ns_green=True,
        ew_green=False,
    )
    _step(core, 60, pin=(0, 0.0, 0.0))

    assert core.queue_length("ns") == 1, "the NS vehicle must queue up"
    assert approach_distance(core.npcs[1]) == pytest.approx(-STOP_LINE_DISTANCE, abs=1e-6)
    assert core.queue_length("ew") == 0


def test_the_cross_axis_queue_drains_once_the_junction_is_clear() -> None:
    """... and the queue drains as soon as the junction is free again:
    the blocking relation is a block, not a deadlock."""
    core = _core(
        [
            Vehicle(x=0.0, z=0.0, heading=0.0, speed=0.0),
            Vehicle(x=0.0, z=-20.0, heading=math.pi / 2, speed=NPC_SPEED),
        ],
        ns_green=True,
        ew_green=False,
    )
    _step(core, 60, pin=(0, 0.0, 0.0))
    assert core.queue_length("ns") == 1

    # The junction clears: the EW vehicle drives on.
    core.npcs[0].x = 20.0
    _step(core, 40)

    assert core.queue_length("ns") == 0, "the NS vehicle must be released"
    assert approach_distance(core.npcs[1]) > -STOP_LINE_DISTANCE


def test_the_conflict_rule_is_off_by_default() -> None:
    """The responsive traffic (and with it the conflict) is opt-in: the
    default path is the basis of the committed cross-language goldens
    and must stay bit-identical."""
    assert SimCore().responsive_traffic is False
    assert SignalEnv().core.responsive_traffic is True


def test_the_default_path_ignores_the_conflict_rule() -> None:
    """Without the responsive traffic the NPCs drive straight through the
    junction at a constant speed — the conflict must not leak into the
    contract's default path."""
    core = SimCore()  # `responsive_traffic` defaults to False
    core.reset()
    core.npcs = [
        Vehicle(x=0.0, z=0.0, heading=0.0, speed=NPC_SPEED),  # EW, in the box
        Vehicle(x=-20.0, z=0.0, heading=0.0, speed=NPC_SPEED),  # EW, behind it
    ]
    core.ego.x = 60.0
    core.ego.z = -60.0
    core.ego.speed = 0.0

    _step(core, 30, ns_green=True, ew_green=False)

    follower = core.npcs[1]
    assert follower.speed == pytest.approx(NPC_SPEED), "the NPC never slows down"
    assert follower.x == pytest.approx(-20.0 + NPC_SPEED * 30 * 0.1, abs=1e-6)


# --------------------------------------------------------------------------
# The reward gate (Plan 074 §3 T8)
# --------------------------------------------------------------------------


def test_the_flicker_still_beats_starving_one_axis() -> None:
    """The part of the gate that does hold: the flicker is still better
    than starving the cross axis — the cross-axis delay is priced."""
    flicker = _run([ACTION_INDEX["shorten_red"]] * 600)
    starve = _run([ACTION_INDEX["extend_green"]] * 600)

    assert (
        flicker > starve
    ), f"the flicker must beat starving one axis (flicker={flicker}, starve={starve})"


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Plan 074 §3 T8's reward gate is NOT met yet — this is the "
        "measured gap, not a passing gate. The intersection conflict "
        "only bites when the junction happens to be occupied at the very "
        "moment of a phase change, and the training scenario is "
        "undersaturated (2 vehicles per axis, one every ~9 s, the "
        "junction occupied ~24% of the time), so in the 600-step "
        "protocol the conflict fires 0 times. Measured (600 steps, seed "
        "0): alternating -109.2, flicker -97.2, starve-one-axis -117.2 "
        "— the flicker still beats the alternating schedule. What is "
        "still missing is an explicit per-switch clearance time: the "
        "browser charges a 3 s yellow + all-red per change, while the "
        "Python light model swaps instantaneously. Adding it to the "
        "LIGHT model is forbidden (the cross-language contract's "
        "sensitive area) — it is the follow-up T8 leaves open."
    ),
)
def test_the_reward_gate_alternating_beats_the_flicker() -> None:
    """Plan 074 §3 T8's core gate: with the intersection conflict in
    place, the **alternating** schedule must beat the **flicker**
    (switch as often as legally possible), and the flicker must beat
    starving one axis.

    It does not hold yet — see the xfail reason above and the T8
    report. The assertion is the plan's gate verbatim: it must not be
    weakened to make the suite green.
    """
    alternating = _run([ACTION_INDEX["no_op"]] * 600)
    flicker = _run([ACTION_INDEX["shorten_red"]] * 600)
    starve = _run([ACTION_INDEX["extend_green"]] * 600)

    assert alternating > flicker, (
        f"the alternating schedule must beat the flicker "
        f"(alternating={alternating}, flicker={flicker})"
    )
    assert flicker > starve, (
        f"the flicker must beat starving one axis " f"(flicker={flicker}, starve={starve})"
    )


def test_the_measured_reward_ordering_under_the_conflict_rule() -> None:
    """Pin the *measured* numbers of the three schedules under the
    conflict rule, so any drift is caught.

    They are the numbers Plan 074 §2 D5 / §3 T7 measured before T8 and
    T8 did not move them: the conflict fires so rarely in this scenario
    that the reward is unchanged to the last decimal.
    """
    alternating = _run([ACTION_INDEX["no_op"]] * 600)
    flicker = _run([ACTION_INDEX["shorten_red"]] * 600)
    starve = _run([ACTION_INDEX["extend_green"]] * 600)

    assert alternating == pytest.approx(-109.2, abs=0.05)
    assert flicker == pytest.approx(-97.2, abs=0.05)
    assert starve == pytest.approx(-117.2, abs=0.05)
