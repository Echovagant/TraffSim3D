"""The gates of the **5 x 5** network level.

The 2 x 2 level's gates live in `test_rl_network_signal_env.py`, the 3 x 3
level's in `test_rl_network_signal_env_3x3.py`; this file is the 5 x 5
counterpart, and it pins the four things the **browser's** grid needs the
model to have:

1. the **topology** - twenty-five junctions, forty segments, and the arm
   pattern that follows from them (a corner has two internal arms and two
   boundary arms, an edge junction three and one, an interior junction
   four and none);
2. the **demand calibration** - the 5 x 5 grid has twenty boundary arms
   (forty lanes) against the 3 x 3 grid's twelve (twenty-four lanes), so
   the same per-lane rate injects far more traffic, and the observation's
   ``MAX_QUEUE`` (a cross-language constant of 10) clips. The calibrated
   demand has to peak at **eight** - the same peak the browser's grid
   shows with its 67 vehicles - and clip nothing;
3. the **timeline** - the contract's timeline at every one of the
   twenty-five junctions: 30 s of green, 6 s in which neither axis is
   green, a 72 s period;
4. the **scene shape** - the dict the env builds is the same dict the
   browser sends, so one scene runs in both engines.

How the timeline is measured
============================

The same clock as the other levels: the light state is recorded
**before** each step, so entry ``i`` is the state at the sim time
``i * DT``. On the sim's own clock the numbers are exact: 30.000 s of
green, 6.000 s of clearance, a 72.000 s period.
"""

from __future__ import annotations

import pytest

from app.apps.rl.network_signal_env import (
    GRID_5X5_COLS,
    GRID_5X5_DEMAND_SCALE,
    GRID_5X5_ROWS,
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

#: The peak the browser's 5 x 5 grid shows with its 67 vehicles - the
#: number the training side has to match, so that the same policy reads
#: the same queue range in both engines.
BROWSER_PEAK_QUEUE = 8


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def _env(**kwargs) -> NetworkSignalEnv:
    """A 5 x 5 env at the calibrated demand."""
    network = build_grid_network_dict(GRID_5X5_ROWS, GRID_5X5_COLS)
    kwargs.setdefault("demand_scale", GRID_5X5_DEMAND_SCALE)
    return NetworkSignalEnv(network, **kwargs)


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


# --------------------------------------------------------------------------
# Gate 1: the topology
# --------------------------------------------------------------------------


def test_the_grid_has_twenty_five_junctions_and_forty_segments() -> None:
    """The browser's grid, in the numbers."""
    network = build_grid_network_dict(GRID_5X5_ROWS, GRID_5X5_COLS)
    assert len(network["intersections"]) == 25
    assert len(network["roads"]) == 40

    env = _env(max_steps=10)
    assert env.n_junctions == 25
    assert env.observation_space.shape == (25, 6)


def test_the_arm_pattern_follows_the_grid() -> None:
    """A corner has two boundary arms, an edge one, an interior none.

    The interior junctions are the ones the model has to get right: they
    only ever see their upstream neighbours, so they carry the sum of four
    approaches and they are the first to saturate.
    """
    env = _env(max_steps=10)
    boundary_arms = 0
    interior_junctions = 0
    edge_junctions = 0
    corner_junctions = 0

    for spec in env._junctions:
        internal = [arm for arm in spec.arms if arm.neighbour_id is not None]
        boundary = [arm for arm in spec.arms if arm.neighbour_id is None]
        boundary_arms += len(boundary)
        assert len(spec.arms) == 4, f"{spec.id} has {len(spec.arms)} arms"
        if len(boundary) == 2:
            corner_junctions += 1
            assert len(internal) == 2, spec.id
        elif len(boundary) == 1:
            edge_junctions += 1
            assert len(internal) == 3, spec.id
        else:
            interior_junctions += 1
            assert len(internal) == 4, spec.id

    assert corner_junctions == 4
    assert edge_junctions == 12
    assert interior_junctions == 9
    # 4 x 2 + 12 x 1 - twenty boundary arms, forty lanes at two each.
    assert boundary_arms == 20
    lanes = sum(
        arm.lanes for spec in env._junctions for arm in spec.arms if arm.neighbour_id is None
    )
    assert lanes == 40


# --------------------------------------------------------------------------
# Gate 2: the demand calibration
# --------------------------------------------------------------------------


def test_the_calibrated_demand_peaks_at_eight_and_never_clips() -> None:
    """The peak is the browser's peak, and nothing is clipped.

    ``MAX_QUEUE`` is a cross-language constant (10) and it may not
    change, so the demand is what has to be calibrated. Measured over
    400 s and five seeds, the demand of 0.20 peaks at 8 on every seed
    and clips nothing; 0.24 already clips.

    The window matters and is part of the gate: over 200 s the peak is
    7, over 400 s it is 8 - the queue needs the time to build. The
    browser's 90 s measurement of the same grid peaks at 8 as well, so
    the two engines' numbers are read at their own windows.
    """
    env = _env(max_steps=int(400.0 / DT))
    env.reset(seed=0)
    peak = 0
    for _ in range(int(400.0 / DT)):
        obs, _reward, _terminated, _truncated, info = env.step([NO_OP] * env.n_junctions)
        for index in range(env.n_junctions):
            assert obs[index, 0] < 1.0, f"{env._junction_ids[index]} ns is clipped"
            assert obs[index, 1] < 1.0, f"{env._junction_ids[index]} ew is clipped"
            assert info["queue_ns"][index] <= MAX_QUEUE
            assert info["queue_ew"][index] <= MAX_QUEUE
            peak = max(peak, int(info["queue_ns"][index]), int(info["queue_ew"][index]))
    assert peak == BROWSER_PEAK_QUEUE, f"the peak was {peak}"


def test_the_calibrated_demand_is_the_documented_one() -> None:
    """The constant is the one the level's notes report."""
    assert GRID_5X5_DEMAND_SCALE == 0.20


def test_a_higher_demand_clips_the_observation() -> None:
    """The calibration is not decorative: more demand really clips.

    Without this, the test above could pass because the queue never grew
    at all - and then the "peak 8" would say nothing.
    """
    env = _env(max_steps=int(200.0 / DT), demand_scale=0.32)
    env.reset(seed=0)
    clipped = 0
    for _ in range(int(200.0 / DT)):
        obs, _reward, _terminated, _truncated, _info = env.step([NO_OP] * env.n_junctions)
        clipped += int((obs[:, 0] >= 1.0).sum() + (obs[:, 1] >= 1.0).sum())
    assert clipped > 0, "the higher demand never clipped - the calibration proves nothing"


# --------------------------------------------------------------------------
# Gate 3: the timeline
# --------------------------------------------------------------------------


def test_every_junction_clears_for_six_seconds_and_repeats_every_seventy_two() -> None:
    """The twenty-five junctions run the contract's timeline, to the step."""
    env = _env(max_steps=int(200.0 / DT))
    env.reset(seed=0)
    rows = _timeline(env, 200.0)

    assert len(env._junction_ids) == 25
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
# Gate 4: the traffic
# --------------------------------------------------------------------------


def test_the_traffic_is_conserved_at_every_step() -> None:
    """``sent == arrived + in transit`` holds at every step."""
    env = _env(max_steps=int(120.0 / DT))
    env.reset(seed=0)
    for _ in range(int(120.0 / DT)):
        env.step([NO_OP] * env.n_junctions)
        for pair in env.conservation_report()["pairs"]:
            assert pair["sent"] == pair["arrived"] + pair["in_transit"], pair


def test_the_traffic_reaches_every_junction() -> None:
    """All twenty-five junctions see traffic, and it crosses the map.

    The browser's grid has 25 junctions and all of them are entered; an
    interior junction that never sees a vehicle would mean the routing
    never crosses the middle of the map. The corner junctions are the
    last to see one - over the first 120 s two of them are still empty.
    """
    env = _env(max_steps=int(400.0 / DT))
    env.reset(seed=0)
    for _ in range(int(400.0 / DT)):
        env.step([NO_OP] * env.n_junctions)

    received = env._received
    empty = [junction_id for junction_id, count in received.items() if count == 0]
    assert not empty, f"no traffic at {empty}"

    report = env.vehicle_report()
    assert max(report["junctions_crossed"]) >= 5, report["junctions_crossed"]
    assert report["vehicles_with_a_turn"] > 0, "no vehicle ever turned"


# --------------------------------------------------------------------------
# Gate 5: the reward
# --------------------------------------------------------------------------


def test_the_reward_is_reproducible_step_for_step() -> None:
    """Two runs of the same seed produce the same reward sequence."""
    rewards = []
    for _ in range(2):
        env = _env(max_steps=int(60.0 / DT))
        env.reset(seed=7)
        run = []
        for _ in range(int(60.0 / DT)):
            _obs, reward, _terminated, _truncated, _info = env.step([NO_OP] * env.n_junctions)
            run.append(reward)
        rewards.append(run)
    assert rewards[0] == rewards[1]


def test_the_reward_is_the_negative_network_delay() -> None:
    """The reward is the network total delay, scaled by one."""
    env = _env(max_steps=int(30.0 / DT))
    env.reset(seed=0)
    total = 0.0
    for _ in range(int(30.0 / DT)):
        _obs, reward, _terminated, _truncated, info = env.step([NO_OP] * env.n_junctions)
        total += reward
    assert total == pytest.approx(-env._total_delay)
    assert info["total_queue"] >= 0


# --------------------------------------------------------------------------
# Gate 6: the scene shape
# --------------------------------------------------------------------------


def test_the_scene_is_the_browser_shape() -> None:
    """The dict the env builds is the dict the browser sends.

    The browser's ``serializeNetwork`` writes a road with ``id`` /
    ``startNode`` / ``endNode`` / ``waypoints`` / ``laneCount`` /
    ``speedLimit`` / ``level`` and an intersection with ``id`` /
    ``position`` / ``connectedRoads`` / ``trafficLights`` /
    ``intersectionRadius``. The env builds the same fields, so one scene
    runs in both engines with no translation in between.
    """
    network = build_grid_network_dict(GRID_5X5_ROWS, GRID_5X5_COLS)
    road_fields = set(network["roads"][0].keys())
    assert road_fields == {
        "id",
        "startNode",
        "endNode",
        "waypoints",
        "laneCount",
        "speedLimit",
        "level",
    }
    intersection_fields = set(network["intersections"][0].keys())
    assert intersection_fields == {
        "id",
        "position",
        "connectedRoads",
        "trafficLights",
        "intersectionRadius",
    }
    # Every road carries its level, and the grid is flat.
    assert all(road["level"] == 0 for road in network["roads"])
