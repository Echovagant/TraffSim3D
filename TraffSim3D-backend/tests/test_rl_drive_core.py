"""The multi-agent driving core — the geometry, the delay and its attribution.

What is pinned here:

1. **The vehicles drive on their lane, not on the centre line.** The
   lateral offset is what keeps an approaching driver and a departing one
   out of each other's way on a shared arm; without it the geometry
   forces a head-on collision that no policy could avoid.
2. **The turn is a pivot.** The Pure Pursuit alone cannot make the
   90 degree turn (the turn radius is smaller than the lateral step
   between the lanes), so the core pivots at the junction — the same
   idiom as the browser's `roadTransition.ts`.
3. **The delay is attributed.** A driver that waits behind another one
   is waiting because of it, and the blocker carries the cost.
4. **The steering converges.** The Pure Pursuit alpha is the textbook
   one; the opposite sign makes the heading error grow every step.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.apps.rl.drive_core import (
    LANE_OFFSET_M,
    OBS_DIM_DRIVE,
    DriveCore,
)
from app.apps.rl.network_graph import build_network_graph


def _network() -> dict:
    """A four-arm junction without traffic lights."""
    roads = []
    connected = []
    for name, dx, dz in (("n", 0.0, 1.0), ("e", 1.0, 0.0), ("s", 0.0, -1.0), ("w", -1.0, 0.0)):
        outer = {"x": dx * 60.0, "y": 0.0, "z": dz * 60.0}
        roads.append(
            {
                "id": f"in-{name}",
                "startNode": outer,
                "endNode": {"x": 0.0, "y": 0.0, "z": 0.0},
                "waypoints": [outer, {"x": 0.0, "y": 0.0, "z": 0.0}],
                "laneCount": 4,
                "speedLimit": 16.67,
            }
        )
        roads.append(
            {
                "id": f"out-{name}",
                "startNode": {"x": 0.0, "y": 0.0, "z": 0.0},
                "endNode": outer,
                "waypoints": [{"x": 0.0, "y": 0.0, "z": 0.0}, outer],
                "laneCount": 4,
                "speedLimit": 16.67,
            }
        )
        connected.extend([f"in-{name}", f"out-{name}"])
    return {
        "roads": roads,
        "intersections": [
            {
                "id": "j-0",
                "position": {"x": 0.0, "y": 0.0, "z": 0.0},
                "connectedRoads": connected,
                "trafficLights": [],
                "intersectionRadius": 8.0,
            }
        ],
        "vehicles": [],
        "spawnPoints": [],
    }


def _core(n_agents: int = 3, n_npcs: int = 1) -> DriveCore:
    graph = build_network_graph(_network())
    return DriveCore(graph, n_agents=n_agents, n_npcs=n_npcs, max_steps=400)


def test_the_vehicles_start_on_different_arms() -> None:
    core = _core()
    core.reset(np.random.default_rng(0))
    arms = {agent.route.segment_ids[0] for agent in core.agents}
    assert len(arms) == len(core.agents), "two drivers share an approach arm"


def test_no_driver_leaves_its_arm_the_way_it_came() -> None:
    # The out road of the same arm as the in road would be a U-turn.
    core = _core()
    core.reset(np.random.default_rng(0))
    for vehicle in core.vehicles:
        in_road, out_road = vehicle.route.segment_ids[0], vehicle.route.segment_ids[1]
        assert core._outer_end(in_road) != core._outer_end(out_road)


def test_the_vehicles_drive_on_a_lane_not_on_the_centre_line() -> None:
    core = _core()
    core.reset(np.random.default_rng(0))
    for vehicle in core.vehicles:
        segment = core.graph.segments[vehicle.route.segment_ids[0]]
        # The perpendicular distance from the road's centre line.
        (ax, az), (bx, bz) = segment.points[0], segment.points[-1]
        dx, dz = bx - ax, bz - az
        length = math.hypot(dx, dz)
        ux, uz = dx / length, dz / length
        # The signed lateral distance (right of the travel direction).
        lateral = (vehicle.x - ax) * uz - (vehicle.z - az) * ux
        assert abs(lateral) == pytest.approx(LANE_OFFSET_M, abs=0.01)


def test_the_observation_has_the_declared_dimension() -> None:
    core = _core()
    core.reset(np.random.default_rng(0))
    observations = core.observations()
    assert len(observations) == core.n_agents
    for observation in observations:
        assert observation.shape == (OBS_DIM_DRIVE,)
        assert np.all(np.isfinite(observation))


def test_the_observation_tells_the_driver_who_arrives_first() -> None:
    core = _core(n_agents=2, n_npcs=0)
    core.reset(np.random.default_rng(3))
    agent = core.agents[0]
    others = [v for v in core.vehicles if v is not agent]
    observation = core._observation(agent)
    # Slot 0 holds the nearest other vehicle: its presence flag, its
    # offset from the conflict point and its arrival time relative to
    # mine.
    assert observation[8] == 1.0
    assert observation[12] != 0.0 or observation[13] != 0.0
    assert others  # the scenario has somebody to negotiate with


def test_the_delay_is_attributed_to_the_blocker() -> None:
    core = _core(n_agents=1, n_npcs=1)
    core.reset(np.random.default_rng(0))
    leader = core.agents[0]
    follower = core.npcs[0]
    # Put the follower right behind the leader, both stopped.
    # The follower is 8 m *ahead* of the leader, in the leader's
    # direction of travel (the leader heads towards -X here, so ahead is
    # -X).
    follower.x = leader.x + 8.0
    follower.z = leader.z
    follower.speed = 0.0
    follower.heading = leader.heading
    leader.speed = 0.0

    core._accumulate_delay()

    assert follower.delay > 0.0, "the waiting driver accrued no delay"
    assert leader.caused_delay > 0.0, "the blocker was not charged for the wait"


def test_a_driver_waiting_without_a_blocker_pays_for_itself_alone() -> None:
    core = _core(n_agents=1, n_npcs=0)
    core.reset(np.random.default_rng(0))
    agent = core.agents[0]
    agent.speed = 0.0

    core._accumulate_delay()

    assert agent.delay > 0.0
    assert agent.caused_delay == 0.0


def test_the_steering_converges_on_its_target() -> None:
    """The Pure Pursuit alpha is the textbook one.

    The opposite sign (`heading - target_angle`) makes the heading error
    grow every step: the steering law would drive the vehicle **away**
    from its target. Measured on the network core before this was fixed:
    an ego that had to turn at a junction drove straight past it and
    ended 52 m off the road.
    """
    core = _core(n_agents=1, n_npcs=0)
    core.reset(np.random.default_rng(0))
    vehicle = core.agents[0]
    # The target is straight ahead (20 m down the road), and the vehicle
    # starts with a heading error of 0.3 rad towards it.
    vehicle.x, vehicle.z, vehicle.heading = 0.0, 0.0, -0.3

    errors = []
    for _step in range(20):
        target = (20.0, 0.0)
        steer = core._steer_towards(vehicle, target)
        vehicle.heading += steer * 0.1
        error = abs(
            (math.atan2(target[1] - vehicle.z, target[0] - vehicle.x) - vehicle.heading + math.pi)
            % (2 * math.pi)
            - math.pi
        )
        errors.append(error)

    assert errors[-1] < errors[0], f"the heading error grew: {errors[0]:.4f} -> {errors[-1]:.4f}"


def test_a_driver_that_goes_straight_reaches_the_far_side() -> None:
    """A full crossing, driven by the model alone (no policy)."""
    core = _core(n_agents=1, n_npcs=0)
    core.reset(np.random.default_rng(0))
    vehicle = core.agents[0]
    # Straight through: the out road of the opposite arm.
    vehicle.route = type(vehicle.route)(
        segment_ids=[vehicle.route.segment_ids[0], "out-s"], found=True
    )
    for _step in range(300):
        core._drive_agent(vehicle, (1.0, 0.0))
        core._advance_route_progress(vehicle)
        if vehicle.finished:
            break
    assert vehicle.finished, f"the driver never got through (progress {vehicle.route_progress:.3f})"


def test_the_conflict_is_counted_as_an_event_not_per_step() -> None:
    core = _core(n_agents=2, n_npcs=0)
    core.reset(np.random.default_rng(0))
    first, second = core.agents[0], core.agents[1]
    # Both inside the box, and staying there.
    first.x = first.z = 0.0
    second.x = second.z = 0.0
    first.speed = second.speed = 0.0

    core._detect_collisions()
    core._detect_collisions()

    assert core.total_conflicts == 1, "the conflict was counted per step, not per event"


def test_the_core_does_not_import_the_contract_core() -> None:
    """The 23-dim core must not couple to the 14-dim contract surface."""
    import pathlib

    source = pathlib.Path("app/apps/rl/drive_core.py").read_text(encoding="utf-8")
    # The check is about the imports, not the prose: the module's
    # docstring names `sim_core.py` precisely to say it does NOT use it.
    assert "from .sim_core" not in source
    assert "import sim_core" not in source
