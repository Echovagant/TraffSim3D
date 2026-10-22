"""The traffic obeys the traffic light.

The NPCs used to drive in straight lines at a constant speed and to
teleport back when they left the world — they never looked at the light,
so a signal agent trained against that world had no causal link between
its action and the traffic. These tests pin the responsive traffic:

* a vehicle brakes to a stop at the stop line when its axis is red;
* the queue count rises while it waits and drains when the axis turns
  green;
* a following vehicle stops *behind* its leader — without that, no queue
  would ever form;
* the default path (no responsive traffic) is untouched: it is the basis
  of the committed cross-language contract goldens.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.apps.rl.sim_core import (
    MIN_GAP,
    NPC_SPEED,
    STOP_LINE_DISTANCE,
    SimCore,
    Vehicle,
    approach_axis,
    approach_distance,
)


def _core(
    npcs: list[Vehicle],
    *,
    ns_green: bool = False,
    ew_green: bool = True,
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
) -> None:
    """Advance the sim, optionally forcing the light's phase.

    The phase clock is reset before every step so the fixed cycle cannot
    flip the light in the middle of a test.
    """
    for _ in range(steps):
        if ns_green is not None:
            core.light.ns_green = ns_green
        if ew_green is not None:
            core.light.ew_green = ew_green
        core.light.cycle_timer = 0.0
        core.step(np.zeros(2, dtype=np.float32))


def test_the_approach_axis_follows_the_heading() -> None:
    """The axis is derived from the heading (the NPC drives through the
    intersection centre)."""
    assert approach_axis(math.pi / 2) == "ns"
    assert approach_axis(-math.pi / 2) == "ns"
    assert approach_axis(0.0) == "ew"
    assert approach_axis(math.pi) == "ew"


def test_a_vehicle_stops_at_the_stop_line_when_its_axis_is_red() -> None:
    """The NS axis is red: the northbound vehicle brakes and comes to a
    stop 8 m before the intersection centre."""
    core = _core([Vehicle(x=0.0, z=-20.0, heading=math.pi / 2, speed=NPC_SPEED)])
    _step(core, 100)

    npc = core.npcs[0]
    assert npc.speed == pytest.approx(0.0, abs=1e-9), "the vehicle must come to a full stop"
    assert approach_distance(npc) == pytest.approx(-STOP_LINE_DISTANCE, abs=1e-6)
    assert npc.z == pytest.approx(-STOP_LINE_DISTANCE, abs=1e-6)


def test_the_queue_count_rises_while_the_axis_is_red() -> None:
    """Every vehicle waiting on the axis counts towards the queue."""
    core = _core(
        [
            Vehicle(x=0.0, z=-20.0, heading=math.pi / 2, speed=NPC_SPEED),
            Vehicle(x=0.0, z=-30.0, heading=math.pi / 2, speed=NPC_SPEED),
        ]
    )
    _step(core, 60)

    assert core.queue_length("ns") == 2
    assert core.queue_length("ew") == 0
    assert core.queue_lengths() == {"ns": 2, "ew": 0}


def test_the_queue_drains_when_the_axis_turns_green() -> None:
    """The green releases the waiting vehicles and the queue empties."""
    core = _core([Vehicle(x=0.0, z=-20.0, heading=math.pi / 2, speed=NPC_SPEED)])
    _step(core, 60)
    assert core.queue_length("ns") == 1

    _step(core, 40, ns_green=True, ew_green=False)

    assert core.queue_length("ns") == 0
    assert (
        approach_distance(core.npcs[0]) > -STOP_LINE_DISTANCE
    ), "it must have entered the junction"
    assert core.npcs[0].speed > 0.0


def test_a_following_vehicle_stops_behind_its_leader() -> None:
    """Without car-following every vehicle would pile up *on* the stop
    line and no queue would ever form."""
    core = _core(
        [
            Vehicle(x=0.0, z=-20.0, heading=math.pi / 2, speed=NPC_SPEED),
            Vehicle(x=0.0, z=-30.0, heading=math.pi / 2, speed=NPC_SPEED),
        ]
    )
    _step(core, 100)

    leader = approach_distance(core.npcs[0])
    follower = approach_distance(core.npcs[1])
    assert leader == pytest.approx(-STOP_LINE_DISTANCE, abs=1e-6), "the leader stops at the line"
    assert follower == pytest.approx(leader - MIN_GAP, abs=1e-6), "the follower keeps the gap"
    assert core.queue_length("ns") == 2


def test_vehicles_on_different_lanes_do_not_follow_each_other() -> None:
    """Two vehicles on the same axis but in different lanes (different
    lateral offsets) are not a queue: each stops at its own stop line."""
    core = _core(
        [
            Vehicle(x=0.0, z=-20.0, heading=math.pi / 2, speed=NPC_SPEED),
            Vehicle(x=3.5, z=-20.0, heading=math.pi / 2, speed=NPC_SPEED),
        ]
    )
    _step(core, 100)

    first = approach_distance(core.npcs[0])
    second = approach_distance(core.npcs[1])
    assert first == pytest.approx(-STOP_LINE_DISTANCE, abs=1e-6)
    assert second == pytest.approx(-STOP_LINE_DISTANCE, abs=1e-6)


def test_the_queue_length_counts_only_stopped_vehicles_before_the_stop_line() -> None:
    """A rolling vehicle is not queued yet, and a vehicle that has
    entered the junction is not queued any more."""
    rolling = Vehicle(x=0.0, z=-20.0, heading=math.pi / 2, speed=NPC_SPEED)
    core = _core([rolling])

    assert core.queue_length("ns") == 0, "a rolling vehicle is not waiting yet"
    rolling.speed = 0.0
    assert core.queue_length("ns") == 1, "a stopped vehicle before the line is queued"
    rolling.z = 0.0  # inside the intersection
    assert core.queue_length("ns") == 0, "a vehicle past the stop line is not queued"


def test_stopped_at_records_when_the_wait_began() -> None:
    """`stopped_at` is the stamp of the current wait, and it is cleared
    once the vehicle moves on again."""
    core = _core([Vehicle(x=0.0, z=-20.0, heading=math.pi / 2, speed=NPC_SPEED)])
    assert core.npcs[0].stopped_at is None

    _step(core, 40)
    npc = core.npcs[0]
    assert npc.stopped_at is not None
    assert npc.stopped_at <= core.sim_time
    assert core.waiting_time("ns") > 0.0

    stamp = npc.stopped_at
    _step(core, 20)
    assert core.npcs[0].stopped_at == stamp, "the wait continues, the stamp stays"

    _step(core, 20, ns_green=True, ew_green=False)
    assert core.npcs[0].stopped_at is None, "the vehicle was released"


def test_a_vehicle_that_crossed_the_intersection_respawns() -> None:
    """The respawn behaviour of the default path is kept: a vehicle that
    got through comes back on the other side of the world."""
    core = _core(
        [Vehicle(x=0.0, z=-20.0, heading=math.pi / 2, speed=NPC_SPEED)],
        ns_green=True,
        ew_green=False,
    )
    _step(core, 80)

    npc = core.npcs[0]
    assert npc.z < -25.0, f"the vehicle should have respawned, z={npc.z}"
    assert npc.stopped_at is None


def test_the_default_path_ignores_the_light() -> None:
    """Without `responsive_traffic` the NPCs drive straight through the
    stop line, at a constant speed.

    This is the guard for the contract: the default path is the basis of
    the committed cross-language goldens and must stay bit-identical.
    """
    core = SimCore()  # `responsive_traffic` defaults to False
    core.reset()
    core.npcs = [Vehicle(x=0.0, z=-20.0, heading=math.pi / 2, speed=NPC_SPEED)]
    core.ego.x = 60.0
    core.ego.z = -60.0
    core.ego.speed = 0.0

    _step(core, 30, ns_green=False, ew_green=True)

    npc = core.npcs[0]
    assert npc.speed == pytest.approx(NPC_SPEED), "the NPC never slows down"
    assert npc.z == pytest.approx(-20.0 + NPC_SPEED * 30 * 0.1, abs=1e-6)
    assert core.queue_length("ns") == 0
