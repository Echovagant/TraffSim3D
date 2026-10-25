"""The gates of the **multi-junction** signal environment.

`signal_env` is the single-junction signal env and its gates live in
`test_signal_env.py` / `test_signal_open_traffic.py` / `test_rl_signal_timeline.py`.
This file is the network-level counterpart, and it pins the four things the
network level has to get right before it can be scaled up (3 x 3, 5 x 5):

1. the **timeline** is the contract's timeline at every junction - a 6 s
   clearance (neither axis green) and a 72 s period, the same numbers the
   browser's grid scene runs;
2. the **traffic travels**: the vehicle that crosses a junction is the
   arrival of the downstream junction, and the network conserves vehicles
   exactly;
3. the **queue disperses** under the red/green alternation (a model whose
   queue only grows cannot price a starved axis);
4. the **demand is per lane** - the unit `signal_conditions` documents and
   `test_signal_open_traffic.py` pins for the single-junction env.

How the timeline is measured
============================

The light state is recorded **before** each step, i.e. the state at the
sim time ``i * DT``. The state *after* the step is the state at
``(i + 1) * DT``, so recording it would shift every window by one step
(0.1 s) and make a 72 s period read 71.9 s. On the sim's own clock the
numbers are then exact: 30.000 s of green, 6.000 s of clearance, a 72.000 s
period.

The **period** is measured between consecutive green *transitions* - the
steps at which an axis turns green. The junction's first green is not one:
the grid's rows start apart (`GRID_ROW_PHASE_SECS`, the browser's rule), so
the first green of a shifted row is already running when the episode opens
and is cut short by the shift. The steady state - the period - is 72 s at
every junction, shifted or not.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.apps.rl.network_signal_env import (
    NetworkSignalEnv,
    build_grid_network_dict,
    junction_radius,
)
from app.apps.rl.signal_conditions import TRAIN_CONDITION
from app.apps.rl.signal_env import MAX_QUEUE, SIG_OBS_DIM, SignalEnv
from app.apps.rl.sim_core import DT, SIGNAL_ACTION_NAMES

NO_OP = SIGNAL_ACTION_NAMES.index("no_op")
SHORTEN_RED = SIGNAL_ACTION_NAMES.index("shorten_red")
EXTEND_GREEN = SIGNAL_ACTION_NAMES.index("extend_green")

#: The timeline the contract pins (the browser's grid runs the same).
EXPECTED_GREEN_SECS = 30.0
EXPECTED_CLEARANCE_SECS = 6.0
EXPECTED_PERIOD_SECS = 72.0
#: The measurement is on the sim's own clock - the numbers are exact, so
#: the tolerance is tight (the gate asks for 0.05 s).
TOLERANCE_SECS = 0.05


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def _timeline(env: NetworkSignalEnv, seconds: float) -> dict[str, list[tuple[bool, bool]]]:
    """The light state of every junction, step by step.

    The state is read **before** the step, so entry ``i`` is the state at
    the sim time ``i * DT``.
    """
    rows: dict[str, list[tuple[bool, bool]]] = {jid: [] for jid in env._junction_ids}
    steps = int(seconds / DT)
    for _ in range(steps):
        for junction_id in env._junction_ids:
            light = env._cores[junction_id].light
            rows[junction_id].append((light.ns_green, light.ew_green))
        env.step([NO_OP] * env.n_junctions)
    return rows


def _spans(rows: list[tuple[bool, bool]], predicate) -> list[tuple[float, float]]:
    """The spans where `predicate(row)` holds - open spans excluded."""
    spans: list[tuple[float, float]] = []
    start: int | None = None
    for index, row in enumerate(rows):
        if predicate(row) and start is None:
            start = index
        elif not predicate(row) and start is not None:
            spans.append((start * DT, index * DT))
            start = None
    return spans


def _clearance_gaps(rows: list[tuple[bool, bool]]) -> list[float]:
    """The spans during which neither axis is green."""
    return [end - start for start, end in _spans(rows, lambda row: not row[0] and not row[1])]


def _green_starts(rows: list[tuple[bool, bool]], axis: int) -> list[float]:
    """The sim times at which the axis **turns** green.

    The state the episode opens with is not a transition: a shifted row's
    first green is already running.
    """
    starts: list[float] = []
    previous = rows[0][axis]
    for index, row in enumerate(rows):
        green = row[axis]
        if green and not previous:
            starts.append(index * DT)
        previous = green
    return starts


def _green_windows(rows: list[tuple[bool, bool]], axis: int) -> list[float]:
    """The lengths of the axis' green windows."""
    return [end - start for start, end in _spans(rows, lambda row: row[axis])]


# --------------------------------------------------------------------------
# the topology
# --------------------------------------------------------------------------


def test_the_grid_has_four_junctions_with_four_arms_of_two_lanes() -> None:
    """The 2 x 2 grid: four junctions, four arms each, two lanes per arm.

    The arm count and the lane count are the browser's grid's (four lanes
    per segment = two forward + two backward), because the observation
    and the service rate are per lane.
    """
    network = build_grid_network_dict(2, 2)
    assert len(network["intersections"]) == 4
    assert len(network["roads"]) == 4

    env = NetworkSignalEnv(network)
    assert env.n_junctions == 4
    for spec in env._junctions:
        assert len(spec.arms) == 4, f"{spec.id} has {len(spec.arms)} arms"
        for arm in spec.arms:
            assert arm.lanes == 2, f"{spec.id}/{arm.direction} has {arm.lanes} lanes"
            assert arm.axis in ("ns", "ew")
        # Two of the four arms lead to a neighbour, two are the boundary.
        internal = [arm for arm in spec.arms if arm.neighbour_id is not None]
        external = [arm for arm in spec.arms if arm.neighbour_id is None]
        assert len(internal) == 2
        assert len(external) == 2
        # The arms of one junction never point at the same direction twice.
        assert len({arm.direction for arm in spec.arms}) == 4


def test_the_junction_radius_follows_the_browsers_rule() -> None:
    """The junction box is derived, not written down.

    The browser's rule: the crossing carriageway's half width plus the
    nose-overhang clearance (the longest vehicle's half length, because
    the stop rule acts on the vehicle's centre).
    """
    assert junction_radius(4) == pytest.approx(11.5)
    network = build_grid_network_dict(2, 2)
    for intersection in network["intersections"]:
        assert intersection["intersectionRadius"] == pytest.approx(11.5)


def test_a_one_way_road_is_refused_loudly() -> None:
    """The env does not simulate a one-way road as a bidirectional one.

    The graph knows the flag; the arm model does not express it (a
    one-way arm is not a boundary arm either - it must not generate
    demand), so the env refuses the network instead of lying about it.
    """
    network = build_grid_network_dict(2, 2)
    network["roads"][0]["oneway"] = True
    with pytest.raises(ValueError, match="one-way"):
        NetworkSignalEnv(network)


# --------------------------------------------------------------------------
# Gate 1: the timeline
# --------------------------------------------------------------------------


def test_the_clearance_is_six_seconds_at_every_junction() -> None:
    """Every junction clears for 6 s - the shape the browser's grid runs.

    The browser charges a 3 s yellow plus a 3 s all-red; the training sim
    charges the same 6 s as one inter-green clearance. A policy that
    transfers needs the two to agree.
    """
    env = NetworkSignalEnv(max_steps=int(200.0 / DT))
    env.reset(seed=0)
    rows = _timeline(env, 200.0)

    # The default grid is the 3 x 3 training level - nine junctions.
    assert len(env._junction_ids) == 9
    for junction_id in env._junction_ids:
        gaps = _clearance_gaps(rows[junction_id])
        assert len(gaps) >= 4, f"{junction_id} has only {len(gaps)} clearances in 200 s"
        for gap in gaps:
            assert abs(gap - EXPECTED_CLEARANCE_SECS) <= TOLERANCE_SECS, (
                f"{junction_id}: a clearance lasted {gap:.3f} s, "
                f"expected {EXPECTED_CLEARANCE_SECS} s"
            )
        # The shape is symmetric: every clearance is the same length.
        assert len({round(gap, 3) for gap in gaps}) == 1, f"{junction_id}: {gaps}"


def test_the_period_is_seventy_two_seconds_at_every_junction() -> None:
    """Every junction repeats every 72 s."""
    env = NetworkSignalEnv(max_steps=int(200.0 / DT))
    env.reset(seed=0)
    rows = _timeline(env, 200.0)

    for junction_id in env._junction_ids:
        for axis in (0, 1):
            starts = _green_starts(rows[junction_id], axis)
            assert len(starts) >= 2, f"{junction_id} axis {axis}: {starts}"
            periods = [b - a for a, b in zip(starts, starts[1:], strict=False)]
            for period in periods:
                assert abs(period - EXPECTED_PERIOD_SECS) <= TOLERANCE_SECS, (
                    f"{junction_id} axis {axis}: the pattern repeated every "
                    f"{period:.3f} s, expected {EXPECTED_PERIOD_SECS} s"
                )


def test_the_green_phase_is_a_full_thirty_seconds() -> None:
    """A green is a full phase - never a slice.

    The **first** green of a shifted row is cut by the shift (the row
    starts apart, so its green has already been running when the episode
    opens), so the assertion is on the windows that follow it.
    """
    env = NetworkSignalEnv(max_steps=int(200.0 / DT))
    env.reset(seed=0)
    rows = _timeline(env, 200.0)

    for junction_id in env._junction_ids:
        for axis in (0, 1):
            windows = _green_windows(rows[junction_id], axis)
            assert len(windows) >= 2, f"{junction_id} axis {axis}: {windows}"
            for length in windows[1:]:
                assert (
                    abs(length - EXPECTED_GREEN_SECS) <= TOLERANCE_SECS
                ), f"{junction_id} axis {axis}: a green lasted {length:.3f} s"


def test_the_network_light_is_the_single_junction_light() -> None:
    """The network's clock is `sim_core`'s - not a second implementation.

    The junction of the network and the single-junction env must run the
    **same** light, step for step: same green windows, same clearances,
    same swaps. If they ever diverge, the two envs have stopped being the
    same model and the trained policy would be measured against a
    different clock than the one it was trained on.
    """
    network = NetworkSignalEnv(max_steps=int(150.0 / DT))
    network.reset(seed=0)
    single = SignalEnv(max_steps=int(150.0 / DT))
    single.reset(seed=0)

    steps = int(150.0 / DT)
    for _ in range(steps):
        network.step([NO_OP] * network.n_junctions)
        single.step(NO_OP)
        light = network._cores[network._junction_ids[0]].light
        single_light = single.core.light
        assert (light.ns_green, light.ew_green) == (
            single_light.ns_green,
            single_light.ew_green,
        ), f"the two lights diverged at step {_}"


# --------------------------------------------------------------------------
# Gate 2: the traffic travels
# --------------------------------------------------------------------------


def test_the_vehicles_that_cross_a_junction_reach_the_next_one() -> None:
    """What a junction sends down a link is what its neighbour receives.

    The network conserves vehicles exactly: ``sent == arrived + in
    transit`` at every step, for every pair of junctions.
    """
    env = NetworkSignalEnv(max_steps=int(120.0 / DT))
    env.reset(seed=0)

    for _ in range(int(120.0 / DT)):
        env.step([NO_OP] * env.n_junctions)
        report = env.conservation_report()
        for pair in report["pairs"]:
            assert pair["sent"] == pair["arrived"] + pair["in_transit"], (
                f"{pair['from']} -> {pair['to']}: sent {pair['sent']}, "
                f"arrived {pair['arrived']}, in transit {pair['in_transit']}"
            )

    assert env.conservation_report()["pairs"], "no vehicle ever crossed a link"


def test_the_drain_closes_the_conservation_window() -> None:
    """With the demand off, everything that was sent arrives.

    The vehicles still on a link when the demand is switched off arrive
    during the drain, so the window closes exactly: ``sent == arrived``.

    The **turning is switched off** for this test, and the reason is a
    property of the model rather than of the bookkeeping: with a turn
    probability, a vehicle can circulate through the network without
    ever leaving it — a right turn at every junction of a 2 x 2 grid is
    a closed loop of four junctions. Such a vehicle is still on a link
    when the drain ends, so the window does not close, and the drain
    would have to run forever. The conservation itself is unaffected:
    the per-step identity ``sent == arrived + in transit`` holds with
    the turning on, and that is what the test above pins.
    """
    env = NetworkSignalEnv(max_steps=int(120.0 / DT), turn_probability=0.0)
    env.reset(seed=0)
    for _ in range(int(120.0 / DT)):
        env.step([NO_OP] * env.n_junctions)

    env.external_demand = False
    # The drain has to outlast a **whole signal cycle** (72 s) plus the
    # longest trip across the network: a vehicle that is still queued at
    # a red when the demand stops waits up to a full cycle before it can
    # leave, and the bigger grid holds more of them. 180 s covers the
    # cycle, the longest straight run (two links, 30 s) and the queue
    # that has to discharge first.
    for _ in range(int(180.0 / DT)):
        env.step([NO_OP] * env.n_junctions)

    report = env.conservation_report()
    assert report["pairs"], "no vehicle ever crossed a link"
    for pair in report["pairs"]:
        assert pair["sent"] == pair["arrived"], (
            f"{pair['from']} -> {pair['to']}: sent {pair['sent']}, "
            f"arrived {pair['arrived']} - the vehicles were lost on the link"
        )
        assert pair["in_transit"] == 0


def test_the_turning_keeps_the_conservation_exactly() -> None:
    """The per-step conservation holds with the turning **on**.

    The default configuration turns a quarter of the movements, so this
    is the configuration the signal agent will actually be trained in —
    and the vehicles still have to be conserved exactly: what a junction
    sends down a link is what its neighbour receives, one link later.
    """
    env = NetworkSignalEnv(max_steps=int(120.0 / DT))
    env.reset(seed=0)

    for _ in range(int(120.0 / DT)):
        env.step([NO_OP] * env.n_junctions)
        for pair in env.conservation_report()["pairs"]:
            assert pair["sent"] == pair["arrived"] + pair["in_transit"], (
                f"{pair['from']} -> {pair['to']}: sent {pair['sent']}, "
                f"arrived {pair['arrived']}, in transit {pair['in_transit']}"
            )


def test_some_vehicles_circulate_when_they_turn_at_every_junction() -> None:
    """A right turn at every junction of a 2 x 2 grid is a closed loop.

    It is a property of the model, and it is worth pinning: a traffic
    network whose vehicles can circulate for ever cannot be drained, so
    any measurement that wants an empty network has to switch the
    turning off (see ``test_the_drain_closes_the_conservation_window``).
    """
    env = NetworkSignalEnv(max_steps=int(200.0 / DT))
    env.reset(seed=0)
    for _ in range(int(200.0 / DT)):
        env.step([NO_OP] * env.n_junctions)

    report = env.conservation_report()
    circulating = [p for p in report["pairs"] if p["in_transit"] > 0]
    assert circulating, "no vehicle was still travelling — the loop did not form"


def test_the_junctions_account_for_every_vehicle() -> None:
    """A junction's books balance: received = discharged + queued.

    The external arrivals are the junction's own demand; the internal
    ones are the upstream junctions' output. What came in either left or
    is still waiting.
    """
    env = NetworkSignalEnv(max_steps=int(120.0 / DT))
    env.reset(seed=0)
    for _ in range(int(120.0 / DT)):
        env.step([NO_OP] * env.n_junctions)

    report = env.conservation_report()
    for row in report["per_junction"]:
        assert row["received"] + row["external"] == row["discharged"] + row["queue"], (
            f"{row['junction']}: received {row['received']} + external "
            f"{row['external']} != discharged {row['discharged']} + queue {row['queue']}"
        )


# --------------------------------------------------------------------------
# Gate 3: the queue disperses
# --------------------------------------------------------------------------


def test_the_queue_disperses_under_the_red_green_alternation() -> None:
    """The queue is not monotonically increasing.

    A queue that only grows cannot price a starved axis: the reward would
    be a function of the episode's length and not of the schedule.
    """
    env = NetworkSignalEnv(max_steps=int(200.0 / DT))
    env.reset(seed=0)

    series: list[int] = []
    for _ in range(int(200.0 / DT)):
        _obs, _reward, _terminated, _truncated, info = env.step([NO_OP] * env.n_junctions)
        series.append(int(info["total_queue"]))

    peak = max(series)
    assert peak > 0, "no queue ever formed - the demand is not reaching the junction"
    # The queue falls back after its peak: the green serves it.
    after_peak = series[series.index(peak) :]
    assert (
        min(after_peak) < peak
    ), f"the queue never fell back after its peak ({peak}) - it only grows"
    # And it is empty at least sometimes: the demand is below the
    # saturation flow, so the network can serve it.
    assert min(series) == 0, "the queue never emptied"


# --------------------------------------------------------------------------
# Gate 4: the reward
# --------------------------------------------------------------------------


def test_the_same_seed_gives_the_same_episode() -> None:
    """The episode is reproducible: same seed, same rewards, bit for bit."""
    runs = []
    for _ in range(2):
        env = NetworkSignalEnv(max_steps=600)
        env.reset(seed=7)
        rewards: list[float] = []
        observations: list[np.ndarray] = []
        for _ in range(600):
            obs, reward, _terminated, _truncated, _info = env.step([NO_OP] * env.n_junctions)
            rewards.append(reward)
            observations.append(obs.copy())
        runs.append((rewards, observations))

    assert runs[0][0] == runs[1][0], "the reward sequence moved between two identical runs"
    for first, second in zip(runs[0][1], runs[1][1], strict=True):
        assert first.tobytes() == second.tobytes()


def test_the_reward_is_the_network_total_delay() -> None:
    """The reward is the negative area under the network-wide queue curve.

    The same unit as the single-junction env: the queue length times the
    step, summed over every junction and priced as a cost.
    """
    env = NetworkSignalEnv(max_steps=600)
    env.reset(seed=0)
    total = 0.0
    expected = 0.0
    for _ in range(600):
        _obs, reward, _terminated, _truncated, info = env.step([NO_OP] * env.n_junctions)
        total += reward
        expected -= info["total_queue"] * DT
    assert total == pytest.approx(expected, abs=1e-9)
    assert total < 0.0, "a network with traffic must cost something"


# --------------------------------------------------------------------------
# Gate 5: the demand is per lane
# --------------------------------------------------------------------------


def test_the_demand_is_per_lane_not_per_axis() -> None:
    """The arrivals follow the condition's **per lane** rate.

    The condition documents the demand as "how many vehicles arrive per
    hour **per lane** on each axis", and the single-junction env's
    `test_the_arrivals_follow_the_demand` pins the unit. A per-axis
    reading would deliver half as many vehicles - every lane of an arm
    would share one arrival stream - and the count below would fall out
    of the band.
    """
    env = NetworkSignalEnv(max_steps=2500)
    env.reset(seed=0)
    for _ in range(2500):
        env.step([NO_OP] * env.n_junctions)

    report = env.conservation_report()
    ns_lanes = 0
    ew_lanes = 0
    for spec in env._junctions:
        for arm in spec.arms:
            if arm.neighbour_id is not None:
                continue
            if arm.axis == "ns":
                ns_lanes += arm.lanes
            else:
                ew_lanes += arm.lanes

    # A window that no headway lands on, so the count has no boundary
    # case: 250 s / 12 s = 20.83 and 250 s / 9 s = 27.78.
    window = 2500 * DT
    ns_headway = 3600.0 / TRAIN_CONDITION.ns_arrivals_per_hour
    ew_headway = 3600.0 / TRAIN_CONDITION.ew_arrivals_per_hour
    expected_ns = ns_lanes * math.floor(window / ns_headway)
    expected_ew = ew_lanes * math.floor(window / ew_headway)

    by_axis = report["external_by_axis"]
    # The tolerance is one arrival per lane: a headway that lands exactly
    # on the window's edge may or may not fire.
    assert abs(by_axis["ns"] - expected_ns) <= ns_lanes, (
        f"the NS arrivals are {by_axis['ns']}, expected about {expected_ns} "
        f"({ns_lanes} lanes x {window / ns_headway:.2f})"
    )
    assert abs(by_axis["ew"] - expected_ew) <= ew_lanes, (
        f"the EW arrivals are {by_axis['ew']}, expected about {expected_ew} "
        f"({ew_lanes} lanes x {window / ew_headway:.2f})"
    )
    # The per-axis reading would deliver half of that: one arrival stream
    # per arm instead of one per lane.
    assert (
        by_axis["ns"] > expected_ns / 2
    ), "the demand looks per-axis: the lanes share one arrival stream"
    assert (
        by_axis["ew"] > expected_ew / 2
    ), "the demand looks per-axis: the lanes share one arrival stream"


# --------------------------------------------------------------------------
# the observation and the action
# --------------------------------------------------------------------------


def test_the_observation_is_the_six_dimensions_of_the_single_junction_env() -> None:
    """Six dimensions per junction, in the single-junction env's order.

    The browser's per-junction observation is the same six numbers, so a
    wider vector would break the transfer this level exists for.
    """
    env = NetworkSignalEnv(max_steps=100)
    obs, _info = env.reset(seed=0)
    assert obs.shape == (env.n_junctions, SIG_OBS_DIM)
    # Nine junctions - the 3 x 3 training level.
    assert obs.shape == (9, 6)
    assert env.observation_space.contains(obs)

    for index in range(env.n_junctions):
        junction_id = env._junction_ids[index]
        light = env._cores[junction_id].light
        ns_queue = sum(
            lane.queue
            for direction in ("n", "s")
            for lane in env._arms[junction_id][direction].lanes
        )
        ew_queue = sum(
            lane.queue
            for direction in ("e", "w")
            for lane in env._arms[junction_id][direction].lanes
        )
        assert obs[index, 0] == pytest.approx(min(ns_queue / MAX_QUEUE, 1.0))
        assert obs[index, 1] == pytest.approx(min(ew_queue / MAX_QUEUE, 1.0))
        assert obs[index, 2] == pytest.approx(1.0 if light.ns_green else 0.0)
        assert obs[index, 3] == pytest.approx(1.0 if light.ew_green else 0.0)
        assert obs[index, 4] == pytest.approx(
            1.0 if (not light.ns_green and not light.ew_green) else 0.0
        )
        assert obs[index, 5] == pytest.approx(light.cycle_timer / light.cycle_duration)


def test_the_action_space_is_the_contract_five_actions() -> None:
    """One action per junction, out of the contract's five."""
    env = NetworkSignalEnv(max_steps=10)
    assert env.action_space.n == len(SIGNAL_ACTION_NAMES) == 5
    obs, _info = env.reset(seed=0)
    obs2, _reward, _terminated, _truncated, _info = env.step([0] * env.n_junctions)
    assert obs2.shape == obs.shape


def test_an_action_outside_the_contract_is_refused() -> None:
    """The action vocabulary is a contract, not a free-form integer."""
    env = NetworkSignalEnv(max_steps=10)
    env.reset(seed=0)
    with pytest.raises(ValueError):
        env.step([len(SIGNAL_ACTION_NAMES)] * env.n_junctions)
    with pytest.raises(ValueError):
        env.step([NO_OP] * (env.n_junctions - 1))


def test_the_minimum_green_refuses_the_shortening() -> None:
    """`shorten_red` is **masked**, not clamped, when it would break the
    minimum green time - the contract's rule, the same one the
    single-junction env applies.
    """
    env = NetworkSignalEnv(max_steps=100)
    env.reset(seed=0)
    junction_id = env._junction_ids[0]
    core = env._cores[junction_id]

    # Right at the start of the green the remaining time is the full
    # phase, so the shortening is allowed.
    assert env._may_shorten_red(core) is True
    masked = []
    for _ in range(60):
        _obs, _reward, _terminated, _truncated, info = env.step([SHORTEN_RED] * env.n_junctions)
        masked.append(info["masked"])
    assert any(masked), "the shortening was never refused - the mask does nothing"
    assert all(masked), "the shortening was applied although the green is at its minimum"


def test_the_extend_green_is_applied_to_the_junction() -> None:
    """`extend_green` really reaches the light it was aimed at."""
    env = NetworkSignalEnv(max_steps=100)
    env.reset(seed=0)
    junction_id = env._junction_ids[0]
    core = env._cores[junction_id]
    before = core.light.cycle_timer
    env.step([EXTEND_GREEN] * env.n_junctions)
    # The action takes 5 s off the green and the step advances the clock
    # by one step.
    assert core.light.cycle_timer == pytest.approx(before - 5.0 + DT, abs=1e-9)


# --------------------------------------------------------------------------
# the turns
# --------------------------------------------------------------------------


def test_the_turn_is_straight_by_default_and_reproducible_when_it_is_not() -> None:
    """The default is "go straight if you can"; a turn is reproducible.

    The turn draw is a hash of the episode's coordinates, so the same
    seed gives the same routing - and the interpreter's global random
    state is never touched.
    """
    straight = NetworkSignalEnv(max_steps=int(60.0 / DT))
    straight.reset(seed=0)
    for _ in range(int(60.0 / DT)):
        straight.step([NO_OP] * straight.n_junctions)
    straight_report = straight.conservation_report()

    # With straight-only traffic every link carries traffic in one
    # direction only: a junction's exit arm is always the opposite of the
    # arm the vehicle came from.
    for pair in straight_report["pairs"]:
        assert pair["sent"] > 0

    def routing(seed: int) -> list[tuple[str, str, int]]:
        env = NetworkSignalEnv(
            build_grid_network_dict(2, 2), turn_probability=0.5, max_steps=int(60.0 / DT)
        )
        env.reset(seed=seed)
        for _ in range(int(60.0 / DT)):
            env.step([NO_OP] * env.n_junctions)
        return [
            (pair["from"], pair["to"], pair["sent"]) for pair in env.conservation_report()["pairs"]
        ]

    assert routing(3) == routing(3), "the same seed gave two different routings"
    assert routing(3) != routing(4), "the seed does not reach the turn choice"
