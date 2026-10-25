"""The gates of the **3 x 3** network level.

The 2 x 2 level's gates live in `test_rl_network_signal_env.py`; this
file is the 3 x 3 counterpart, and it pins the four things the level
added on top of the 2 x 2:

1. the **topology** - nine junctions, twelve segments, and the arm
   pattern that follows from them (a corner has two internal arms and
   two boundary arms, an edge junction has three and one, the centre has
   four and none - the centre is the junction that only ever sees its
   upstream neighbours);
2. the **demand calibration** - the 3 x 3 grid has twelve boundary arms
   against the 2 x 2 grid's eight, so the same per-lane rate injects
   1.5 x the traffic, and the observation's ``MAX_QUEUE`` (a
   cross-language constant of 10) clips;
3. the **turn bias** - the split of the turns between the left and the
   right side, which has to be the browser's split;
4. the **spillback** - a queue at the downstream junction has to reach
   back into the upstream junction instead of the traffic piling up on
   the link.

And the two things the level has to be able to do at all:

5. it reads the **browser's scene JSON** - the same shape the browser
   sends, so one scene can be run by both engines;
6. the **reward** is the network total delay, reproducible step for step.

How the timeline is measured
============================

The same clock as the 2 x 2 level: the light state is recorded
**before** each step, so entry ``i`` is the state at the sim time
``i * DT``. On the sim's own clock the numbers are exact: 30.000 s of
green, 6.000 s of clearance, a 72.000 s period.
"""

from __future__ import annotations

import pytest

from app.apps.rl.network_signal_env import (
    OPPOSITE,
    RIGHT_TURN,
    RIGHT_TURN_SHARE,
    TURN_BIAS,
    TURN_PROBABILITY,
    NetworkSignalEnv,
    build_grid_network_dict,
)
from app.apps.rl.signal_env import MAX_QUEUE
from app.apps.rl.sim_core import DT, SIGNAL_ACTION_NAMES

NO_OP = SIGNAL_ACTION_NAMES.index("no_op")

#: The timeline the contract pins (the browser's grid runs the same).
EXPECTED_CLEARANCE_SECS = 6.0
EXPECTED_PERIOD_SECS = 72.0
TOLERANCE_SECS = 0.05


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def _timeline(env: NetworkSignalEnv, seconds: float) -> dict[str, list[tuple[bool, bool]]]:
    """The light state of every junction, step by step."""
    rows: dict[str, list[tuple[bool, bool]]] = {jid: [] for jid in env._junction_ids}
    steps = int(seconds / DT)
    for _ in range(steps):
        for junction_id in env._junction_ids:
            light = env._cores[junction_id].light
            rows[junction_id].append((light.ns_green, light.ew_green))
        env.step([NO_OP] * env.n_junctions)
    return rows


def _spans(rows: list[tuple[bool, bool]], predicate) -> list[tuple[float, float]]:
    spans: list[tuple[float, float]] = []
    start: int | None = None
    for index, row in enumerate(rows):
        if predicate(row) and start is None:
            start = index
        elif not predicate(row) and start is not None:
            spans.append((start * DT, index * DT))
            start = None
    return spans


def _green_starts(rows: list[tuple[bool, bool]], axis: int) -> list[float]:
    starts: list[float] = []
    previous = rows[0][axis]
    for index, row in enumerate(rows):
        green = row[axis]
        if green and not previous:
            starts.append(index * DT)
        previous = green
    return starts


#: A two-junction network in the **browser's** shape - the shape
#: ``serializeNetwork`` writes and the shape ``build_network_graph``
#: reads: roads with ``waypoints`` / ``laneCount`` / ``speedLimit``,
#: intersections with ``connectedRoads`` / ``trafficLights`` /
#: ``intersectionRadius``.
BROWSER_SCENE: dict = {
    "roads": [
        {
            "id": "w-0-0-h",
            "startNode": {"x": 0.0, "y": 0.0, "z": 0.0},
            "endNode": {"x": 120.0, "y": 0.0, "z": 0.0},
            "waypoints": [{"x": 0.0, "y": 0.0, "z": 0.0}, {"x": 120.0, "y": 0.0, "z": 0.0}],
            "laneCount": 4,
            "speedLimit": 16.67,
            "level": 0,
        }
    ],
    "intersections": [
        {
            "id": "j-0-0",
            "position": {"x": 0.0, "y": 0.0, "z": 0.0},
            "connectedRoads": ["w-0-0-h"],
            "trafficLights": [
                {
                    "id": "j-0-0-light-ns",
                    "position": {"x": 0.0, "y": 0.0, "z": 0.0},
                    "phase": "green",
                    "phaseRemaining": 30.0,
                    "cycleSeconds": 72.0,
                    "axis": "ns",
                    "controlledLane": 0,
                },
                {
                    "id": "j-0-0-light-ew",
                    "position": {"x": 0.0, "y": 0.0, "z": 0.0},
                    "phase": "red",
                    "phaseRemaining": 30.0,
                    "cycleSeconds": 72.0,
                    "axis": "ew",
                    "controlledLane": 0,
                },
            ],
            "intersectionRadius": 11.5,
        },
        {
            "id": "j-0-1",
            "position": {"x": 120.0, "y": 0.0, "z": 0.0},
            "connectedRoads": ["w-0-0-h"],
            "trafficLights": [
                {
                    "id": "j-0-1-light-ns",
                    "position": {"x": 120.0, "y": 0.0, "z": 0.0},
                    "phase": "green",
                    "phaseRemaining": 30.0,
                    "cycleSeconds": 72.0,
                    "axis": "ns",
                    "controlledLane": 0,
                },
                {
                    "id": "j-0-1-light-ew",
                    "position": {"x": 120.0, "y": 0.0, "z": 0.0},
                    "phase": "red",
                    "phaseRemaining": 30.0,
                    "cycleSeconds": 72.0,
                    "axis": "ew",
                    "controlledLane": 0,
                },
            ],
            "intersectionRadius": 11.5,
        },
    ],
    "vehicles": [],
    "spawnPoints": [],
}


# --------------------------------------------------------------------------
# Gate 1: the topology
# --------------------------------------------------------------------------


def test_the_grid_has_nine_junctions_and_twelve_segments() -> None:
    """The 3 x 3 grid: nine junctions, twelve segments."""
    network = build_grid_network_dict(3, 3)
    assert len(network["intersections"]) == 9
    assert len(network["roads"]) == 12

    env = NetworkSignalEnv(network)
    assert env.n_junctions == 9


def test_the_arms_follow_the_neighbours() -> None:
    """The arm pattern is derived from the neighbours, not written down.

    A corner has two internal arms and two boundary arms, an edge
    junction has three internal arms and one boundary arm, and the
    centre has four internal arms and **no** boundary arm - the centre
    is the junction that only ever sees its upstream neighbours, and
    that is why it is the first to go over saturation.
    """
    env = NetworkSignalEnv(build_grid_network_dict(3, 3))
    corners = ("j-0-0", "j-0-2", "j-2-0", "j-2-2")
    edges = ("j-0-1", "j-1-0", "j-1-2", "j-2-1")
    for spec in env._junctions:
        internal = [arm for arm in spec.arms if arm.neighbour_id is not None]
        external = [arm for arm in spec.arms if arm.neighbour_id is None]
        assert len(spec.arms) == 4, f"{spec.id} has {len(spec.arms)} arms"
        if spec.id in corners:
            assert (len(internal), len(external)) == (2, 2), spec.id
        elif spec.id in edges:
            assert (len(internal), len(external)) == (3, 1), spec.id
        else:
            assert spec.id == "j-1-1"
            assert (len(internal), len(external)) == (4, 0), spec.id
        # Every arm has the browser's lane count (four lanes per segment
        # = two forward + two backward, so two lanes per arm).
        for arm in spec.arms:
            assert arm.lanes == 2, f"{spec.id}/{arm.direction} has {arm.lanes} lanes"


# --------------------------------------------------------------------------
# Gate 2: the timeline
# --------------------------------------------------------------------------


def test_every_junction_clears_for_six_seconds_and_repeats_every_seventy_two() -> None:
    """The nine junctions run the contract's timeline, to the step."""
    env = NetworkSignalEnv(max_steps=int(200.0 / DT))
    env.reset(seed=0)
    rows = _timeline(env, 200.0)

    assert len(env._junction_ids) == 9
    for junction_id in env._junction_ids:
        gaps = [b - a for a, b in _spans(rows[junction_id], lambda r: not r[0] and not r[1])]
        assert len(gaps) >= 4, f"{junction_id} has only {len(gaps)} clearances in 200 s"
        for gap in gaps:
            assert (
                abs(gap - EXPECTED_CLEARANCE_SECS) <= TOLERANCE_SECS
            ), f"{junction_id}: a clearance lasted {gap:.3f} s"
        for axis in (0, 1):
            starts = _green_starts(rows[junction_id], axis)
            assert len(starts) >= 2, f"{junction_id} axis {axis}: {starts}"
            for a, b in zip(starts, starts[1:], strict=False):
                assert (
                    abs((b - a) - EXPECTED_PERIOD_SECS) <= TOLERANCE_SECS
                ), f"{junction_id} axis {axis}: the period was {b - a:.3f} s"


# --------------------------------------------------------------------------
# Gate 3: the traffic travels and turns
# --------------------------------------------------------------------------


def test_the_traffic_is_conserved_at_every_step() -> None:
    """``sent == arrived + in transit`` holds at every step."""
    env = NetworkSignalEnv(max_steps=int(120.0 / DT))
    env.reset(seed=0)
    for _ in range(int(120.0 / DT)):
        env.step([NO_OP] * env.n_junctions)
        for pair in env.conservation_report()["pairs"]:
            assert pair["sent"] == pair["arrived"] + pair["in_transit"], pair


def test_the_vehicles_run_between_several_junctions() -> None:
    """The turning is on, and the traffic really travels.

    The distribution the level has to get right: how many junctions one
    vehicle passes through. With the turning off, a vehicle runs a
    straight chain (at most two internal segments on this grid); with
    the turning on, vehicles turn, and some of them circulate.
    """
    straight = NetworkSignalEnv(max_steps=int(200.0 / DT), turn_probability=0.0)
    straight.reset(seed=0)
    for _ in range(int(200.0 / DT)):
        straight.step([NO_OP] * straight.n_junctions)
    straight_report = straight.vehicle_report()
    assert straight_report["vehicles_with_a_turn"] == 0
    assert max(straight_report["junctions_crossed"]) <= 3

    env = NetworkSignalEnv(max_steps=int(200.0 / DT))
    env.reset(seed=0)
    for _ in range(int(200.0 / DT)):
        env.step([NO_OP] * env.n_junctions)
    report = env.vehicle_report()

    # The vehicles turn - a quarter of the movements, as the browser does.
    assert report["vehicles_with_a_turn"] > 0
    # And they run between several junctions.
    multi = sum(n for k, n in report["junctions_crossed"].items() if k >= 2)
    assert multi > 0, report
    # The turns are a quarter of the crossings.
    crossings = sum(k * n for k, n in report["junctions_crossed"].items())
    assert 0.15 * crossings < report["turns"] < 0.35 * crossings, report


def test_the_turn_split_is_the_browsers_split() -> None:
    """The default bias is the browser's: 0.25 of the movements turn,
    and 0.6 of the turns are right turns."""
    assert TURN_PROBABILITY == 0.25
    assert RIGHT_TURN_SHARE == 0.6
    assert TURN_BIAS["right"] == pytest.approx(0.6)
    assert TURN_BIAS["left"] == pytest.approx(0.4)

    env = NetworkSignalEnv(max_steps=10)
    assert env.turn_bias["right"] == pytest.approx(0.6)
    assert env.turn_bias["left"] == pytest.approx(0.4)

    # An explicit bias replaces it, and the left/right split of the
    # turns follows the bias: over many draws the right turn wins about
    # as often as the bias says.
    biased = NetworkSignalEnv(max_steps=10, turn_bias={"right": 1.0, "left": 0.0})
    assert biased.turn_bias["right"] == 1.0
    biased.reset(seed=0)
    rights = 0
    turns = 0
    for junction_id in biased._junction_ids:
        for incoming in ("n", "s", "e", "w"):
            for _ in range(200):
                exit_direction = biased._exit_direction(junction_id, incoming)
                if exit_direction == OPPOSITE[incoming]:
                    continue
                turns += 1
                if exit_direction == RIGHT_TURN[incoming]:
                    rights += 1
    assert turns > 0
    assert rights == turns, "the bias of 1.0 on the right turn still produced a left turn"


# --------------------------------------------------------------------------
# Gate 4: the demand calibration
# --------------------------------------------------------------------------


def test_the_demand_scale_defaults_to_the_condition() -> None:
    """``demand_scale`` of 1.0 is the condition's own demand."""
    env = NetworkSignalEnv(max_steps=int(60.0 / DT))
    assert env.demand_scale == 1.0
    env.reset(seed=0)
    for _ in range(int(60.0 / DT)):
        env.step([NO_OP] * env.n_junctions)
    report = env.conservation_report()

    # The number of external arms times their lanes times the headway.
    lanes = sum(
        arm.lanes for spec in env._junctions for arm in spec.arms if arm.neighbour_id is None
    )
    assert report["external_by_axis"]["ns"] + report["external_by_axis"]["ew"] > 0
    assert lanes == 24, lanes


def test_the_calibrated_demand_keeps_the_observation_inside_its_range() -> None:
    """At the calibrated demand the observation never clips.

    ``MAX_QUEUE`` is a cross-language constant (10) and it may not
    change, so the demand is what has to be calibrated: at 1.0 a third
    of the junction-axis observations are clipped and the peak queue is
    22; at 0.35 the peak is 8 and nothing clips.
    """
    env = NetworkSignalEnv(max_steps=int(200.0 / DT), demand_scale=0.35)
    env.reset(seed=0)
    steps = int(200.0 / DT)
    for _ in range(steps):
        obs, _reward, _terminated, _truncated, info = env.step([NO_OP] * env.n_junctions)
        for index in range(env.n_junctions):
            assert obs[index, 0] < 1.0, f"{env._junction_ids[index]} ns is clipped"
            assert obs[index, 1] < 1.0, f"{env._junction_ids[index]} ew is clipped"
            assert info["queue_ns"][index] <= MAX_QUEUE
            assert info["queue_ew"][index] <= MAX_QUEUE


# --------------------------------------------------------------------------
# Gate 5: the spillback
# --------------------------------------------------------------------------


def test_the_spillback_reaches_back_into_the_upstream_junction() -> None:
    """A jammed downstream junction holds the upstream vehicle.

    The scenario: the west arm of the downstream junction is full, and
    the upstream junction has a vehicle whose exit is that arm. The
    vehicle must **wait** - it may not cross, and the downstream's
    queue must not silently swallow it.
    """
    threshold = 4
    env = NetworkSignalEnv(
        BROWSER_SCENE,
        max_steps=int(300.0 / DT),
        turn_probability=0.0,
        external_demand=False,
        spillback_queue_threshold=threshold,
    )
    env.reset(seed=0)

    downstream = env._arms["j-0-1"]["w"]
    upstream = env._arms["j-0-0"]["w"]
    for index in range(threshold):
        downstream.lanes[index % len(downstream.lanes)].vehicles.append(env._new_vehicle())
    waiting = env._new_vehicle()
    upstream.lanes[0].vehicles.append(waiting)

    blocked_steps = 0
    for _ in range(int(120.0 / DT)):
        # Keep the downstream jammed.
        while sum(lane.queue for lane in downstream.lanes) < threshold:
            downstream.lanes[0].vehicles.append(env._new_vehicle())
        env.step([NO_OP] * env.n_junctions)
        if waiting.junctions == 0:
            blocked_steps += 1
        else:  # pragma: no cover - the vehicle must not get through
            pytest.fail("the vehicle crossed while the downstream junction was jammed")

    assert blocked_steps > 0
    # It waited with the green on - that is the frames it lost.
    assert waiting.spillback_waits > 0
    assert env._spillback_events > 0

    # Let the downstream clear: the vehicle goes through.
    for lane in downstream.lanes:
        lane.vehicles.clear()
    for _ in range(int(120.0 / DT)):
        env.step([NO_OP] * env.n_junctions)
        if waiting.junctions > 0:
            break
    assert waiting.junctions == 1, "the vehicle never got through after the jam cleared"
    assert waiting.route[0][0] == "j-0-0"


def test_the_spillback_is_off_by_default() -> None:
    """The default has no spillback: the travel time is free-flow."""
    env = NetworkSignalEnv(max_steps=10)
    assert env.spillback_queue_threshold is None
    env.reset(seed=0)
    assert env._is_spilled_back("j-0-0", "e") is False


# --------------------------------------------------------------------------
# Gate 6: the browser's scene JSON
# --------------------------------------------------------------------------


def test_the_browsers_scene_json_runs_as_it_is() -> None:
    """One scene, two engines: the browser's JSON is the input.

    The shape is the one ``serializeNetwork`` writes - the roads carry
    ``waypoints`` / ``laneCount`` / ``speedLimit`` / ``level`` and the
    intersections carry ``connectedRoads`` / ``trafficLights`` /
    ``intersectionRadius``. The backend reads it without translation.
    """
    env = NetworkSignalEnv(BROWSER_SCENE, max_steps=int(60.0 / DT))
    env.reset(seed=0)
    assert env.n_junctions == 2

    # The road between the two junctions is an internal arm on both
    # sides; the other three arms of each junction are the boundary.
    for junction_id in ("j-0-0", "j-0-1"):
        spec = next(s for s in env._junctions if s.id == junction_id)
        internal = [arm for arm in spec.arms if arm.neighbour_id is not None]
        external = [arm for arm in spec.arms if arm.neighbour_id is None]
        assert len(internal) == 1
        assert len(external) == 3

    for _ in range(int(60.0 / DT)):
        env.step([NO_OP] * env.n_junctions)

    report = env.conservation_report()
    assert report["pairs"], "no vehicle ever crossed the link"
    for pair in report["pairs"]:
        assert pair["sent"] == pair["arrived"] + pair["in_transit"]


# --------------------------------------------------------------------------
# Gate 7: the reward
# --------------------------------------------------------------------------


def test_the_reward_is_reproducible_and_is_the_network_total_delay() -> None:
    """The same seed, the same reward sequence, bit for bit."""
    runs = []
    for _ in range(2):
        env = NetworkSignalEnv(max_steps=int(120.0 / DT))
        env.reset(seed=7)
        rewards = []
        total = 0.0
        for _ in range(int(120.0 / DT)):
            _obs, reward, _terminated, _truncated, info = env.step([NO_OP] * env.n_junctions)
            rewards.append(reward)
            total = info["total_delay"]
        runs.append((rewards, total))

    assert runs[0][0] == runs[1][0]
    # The reward is the negative of the network total delay.
    assert sum(runs[0][0]) == pytest.approx(-runs[0][1])


def test_the_reward_scale_only_rescales_the_reward() -> None:
    """The scale multiplies the reward; the delay stays the contract's."""
    raw = NetworkSignalEnv(max_steps=int(120.0 / DT))
    raw.reset(seed=0)
    scaled = NetworkSignalEnv(max_steps=int(120.0 / DT), reward_scale=1.0 / 9)
    scaled.reset(seed=0)

    raw_total = 0.0
    scaled_total = 0.0
    for _ in range(int(120.0 / DT)):
        _obs, reward, _t, _tr, info = raw.step([NO_OP] * raw.n_junctions)
        raw_total += reward
        _obs, reward, _t, _tr, info = scaled.step([NO_OP] * scaled.n_junctions)
        scaled_total += reward
        # The raw delay is the contract's: the network total delay, and
        # it does not move with the scale.
        assert info["total_delay"] == pytest.approx(-raw_total)

    assert scaled_total == pytest.approx(raw_total / 9)
    # The raw delay is the contract's: the network total delay.
    assert raw_total < 0.0
