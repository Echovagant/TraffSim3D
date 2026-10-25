"""Multi-junction signal environment - the network-level twin of `signal_env`.

`signal_env` is the **single**-intersection signal env: one light, one
agent, one reward, six observations. This module is the same model lifted
onto a **road network**: N junctions, one light and one agent each, and -
the part the single-junction env cannot have - **traffic that travels
between the junctions**. The vehicle that crosses junction A is the
arrival of the downstream junction B, so a queue at A becomes a queue at
B one link later, and the reward is the delay of the **whole network**.

Why the level matters
=====================

The browser's grid scene (``buildGridNetwork``) already runs 25 junctions
with one light each, and its signal timeline is the reference this module
has to match: a 30 s green, a 6 s clearance in which **neither** axis is
green, and a 72 s period - at every junction, to the step.

The **clock is not written here**. Each junction owns a ``sim_core``
``SimCore`` whose only job is to advance **its** light, and the advance
goes through ``SimCore.step()`` - the same code path the single-junction
``SignalEnv`` uses. So the timeline is the contract's timeline by
construction, not by a re-implementation of it.

The **observation is not widened either**: six dimensions per junction, in
the order the single-junction env uses (``signal_env.SIG_OBS_DIM``), with
the same normalisation constants (``signal_env.MAX_QUEUE``). The browser's
per-junction observation is the same six numbers, so a policy trained here
can be dropped into the browser's grid - which is the whole point of
building the level.

The traffic model
=================

The traffic is a **queue model**, one queue per lane of every approach
arm:

* an **external** arm (a direction with no road behind it - the network
  boundary) generates arrivals at the condition's demand, **per lane** -
  the same unit as ``signal_conditions.TrafficCondition``;
* a vehicle waits in its lane's queue while the light is red and is
  served at the **saturation flow** when the axis is green (one vehicle
  per lane per ``SATURATION_HEADWAY_SECS``);
* a served vehicle crosses the intersection, picks an exit arm (straight
  by default, see ``turn_probability``) and **travels the link** to the
  downstream junction, where it becomes an arrival. A vehicle that exits
  through an external arm leaves the network.

Because the vehicle is *counted* at every hand-over, the network conserves
vehicles exactly: what a junction sends out is what its downstream
junction receives, one link later. ``conservation_report()`` prints the
per-pair numbers.

What is deliberately **not** modelled: the vehicle dynamics (a vehicle is
a point that queues, not a body that accelerates), the conflict between
two axes inside the intersection (the 6 s clearance covers it), the
turning vehicles' own geometry and the **one-way roads** (the graph knows
the flag; the arm model does not express it, so the env refuses such a
network loudly instead of simulating it as a bidirectional road). Those
are the browser's job; the level under test is the **network flow and the
global schedule**.
"""

from __future__ import annotations

import hashlib
import heapq
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import gymnasium as gym
import numpy as np
from gymnasium import spaces

from .network_graph import NetworkGraph, build_network_graph
from .signal_conditions import TRAIN_CONDITION, TrafficCondition
from .signal_env import MAX_QUEUE, SIG_OBS_DIM
from .sim_core import (
    DT,
    MIN_GREEN_SECS,
    NPC_SPEED,
    PHASE_ADJUST_SECS,
    SIGNAL_ACTION_NAMES,
    SimCore,
    Vehicle,
)

__all__ = [
    "GRID_LANE_COUNT",
    "GRID_ROW_PHASE_SECS",
    "GRID_SPACING_M",
    "GRID_SPEED_LIMIT",
    "LANE_WIDTH_M",
    "MAX_QUEUE",
    "NET_OBS_DIM",
    "NOSE_CLEARANCE_M",
    "SATURATION_HEADWAY_SECS",
    "SIG_OBS_DIM",
    "ArmSpec",
    "JunctionSpec",
    "NetworkSignalEnv",
    "build_grid_network_dict",
    "junction_radius",
]

#: The per-junction observation width. The **same six dimensions** the
#: single-junction env uses, in the same order: the browser's per-junction
#: observation is these six numbers, so a wider vector would break the
#: transfer the level exists for.
NET_OBS_DIM = SIG_OBS_DIM

#: The saturation flow of one lane, as the headway between two vehicles
#: leaving a green (s). 1.8 s = 2000 veh/h/lane - the usual saturation flow
#: of a signalised lane.
SATURATION_HEADWAY_SECS = 1.8

# ===== the grid scene =====

#: Distance between two neighbouring junctions (m) - the browser's grid
#: value, so the link travel time matches the browser's.
GRID_SPACING_M = 120.0
#: Lanes per grid segment: 2 forward + 2 backward.
GRID_LANE_COUNT = 4
#: The grid's speed limit (m/s).
GRID_SPEED_LIMIT = 16.67
#: How far the green of row `i` has already been running when the scene
#: opens (s) - the browser's ``GRID_ROW_PHASE_SECS``. The junctions are
#: ranked by their z coordinate, and the rank times this value is the
#: junction's phase offset. It keeps the network from pulsing as one.
GRID_ROW_PHASE_SECS = 6.0
#: The width of one lane (m).
LANE_WIDTH_M = 3.5
#: The nose-overhang clearance of a junction box (m) - the longest
#: vehicle's half length, because the stop rule acts on the vehicle's
#: centre.
NOSE_CLEARANCE_M = 4.5

#: The four compass directions an arm can point at.
DIRECTIONS = ("n", "s", "e", "w")
#: The direction across the junction.
OPPOSITE = {"n": "s", "s": "n", "e": "w", "w": "e"}
#: The signalised axis of a direction: the north-south road and the
#: east-west road (the browser's ``approachAxis``).
AXIS_OF = {"n": "ns", "s": "ns", "e": "ew", "w": "ew"}
#: The exit arm of a left turn (right-hand traffic: the driver keeps right).
LEFT_TURN = {"n": "e", "s": "w", "e": "s", "w": "n"}
#: The exit arm of a right turn.
RIGHT_TURN = {"n": "w", "s": "e", "e": "n", "w": "s"}


def junction_radius(lane_count: int) -> float:
    """The junction box radius of a junction with `lane_count` lanes.

    The browser's rule (``junctionRadius``): the crossing carriageway's
    half width plus the nose-overhang clearance. Four lanes give
    4 x 3.5 / 2 + 4.5 = 11.5 m.
    """
    return lane_count * LANE_WIDTH_M / 2.0 + NOSE_CLEARANCE_M


def build_grid_network_dict(
    rows: int = 2,
    cols: int = 2,
    *,
    spacing: float = GRID_SPACING_M,
    lane_count: int = GRID_LANE_COUNT,
    speed_limit: float = GRID_SPEED_LIMIT,
) -> dict[str, Any]:
    """A rows x cols grid in the frontend's ``serializeNetwork`` shape.

    The shape is the one ``build_network_graph`` reads (and the one the
    browser sends): roads with ``waypoints`` / ``laneCount`` /
    ``speedLimit``, intersections with ``connectedRoads`` /
    ``trafficLights`` / ``intersectionRadius``.

    A 2 x 2 grid is four junctions and four roads; every junction has
    **four arms**, of which two lead to a neighbour and two are the
    **network boundary** (a direction with no road behind it). The
    boundary arms are where the external traffic enters and where the
    traffic leaves the network.

    The grid is centred on the origin and the junction positions are
    whole metres - ``build_network_graph`` snaps the node positions to an
    integer grid, so a fractional position would not find its node.
    """
    if rows < 1 or cols < 1:
        raise ValueError(f"a grid needs at least one row and column, got {rows}x{cols}")

    def position(row: int, col: int) -> dict[str, float]:
        return {
            "x": (col - (cols - 1) / 2.0) * spacing,
            "y": 0.0,
            "z": (row - (rows - 1) / 2.0) * spacing,
        }

    roads: list[dict[str, Any]] = []
    connected: dict[tuple[int, int], list[str]] = {}

    def add_road(road_id: str, a: tuple[int, int], b: tuple[int, int]) -> None:
        start = position(*a)
        end = position(*b)
        roads.append(
            {
                "id": road_id,
                "startNode": dict(start),
                "endNode": dict(end),
                "waypoints": [dict(start), dict(end)],
                "laneCount": lane_count,
                "speedLimit": speed_limit,
            }
        )
        connected.setdefault(a, []).append(road_id)
        connected.setdefault(b, []).append(road_id)

    # The east-west segments: (row, col) -> (row, col + 1).
    for row in range(rows):
        for col in range(cols - 1):
            add_road(f"w-{row}-{col}-h", (row, col), (row, col + 1))
    # The north-south segments: (row, col) -> (row + 1, col).
    for row in range(rows - 1):
        for col in range(cols):
            add_road(f"w-{row}-{col}-v", (row, col), (row + 1, col))

    radius = junction_radius(lane_count)
    intersections: list[dict[str, Any]] = []
    for row in range(rows):
        for col in range(cols):
            junction_id = f"j-{row}-{col}"
            spot = position(row, col)
            intersections.append(
                {
                    "id": junction_id,
                    "position": dict(spot),
                    "connectedRoads": list(connected.get((row, col), [])),
                    # One light per axis group - the same shape the browser
                    # builds for a crossroads.
                    "trafficLights": [
                        {
                            "id": f"{junction_id}-light-ns",
                            "position": dict(spot),
                            "phase": "green",
                            "phaseRemaining": 30.0,
                            "cycleSeconds": 72.0,
                            "axis": "ns",
                            "controlledLane": 0,
                        },
                        {
                            "id": f"{junction_id}-light-ew",
                            "position": dict(spot),
                            "phase": "red",
                            "phaseRemaining": 30.0,
                            "cycleSeconds": 72.0,
                            "axis": "ew",
                            "controlledLane": 0,
                        },
                    ],
                    "intersectionRadius": radius,
                }
            )

    return {
        "roads": roads,
        "intersections": intersections,
        "vehicles": [],
        "spawnPoints": [],
    }


@dataclass(frozen=True)
class ArmSpec:
    """One approach arm of a junction.

    An arm is the **approach** side: the direction the traffic comes
    *from*. ``neighbour_id`` is the junction at the other end of the road;
    ``None`` means the arm is the network boundary - traffic enters from
    there and leaves through it.
    """

    junction_id: str
    direction: str
    axis: str
    lanes: int
    neighbour_id: str | None
    link_length: float


@dataclass(frozen=True)
class JunctionSpec:
    """One junction of the network, with its four arms."""

    id: str
    position: tuple[float, float]
    arms: tuple[ArmSpec, ...]


@dataclass
class _Lane:
    """One lane of one approach arm.

    ``queue`` counts the vehicles waiting at the stop line;
    ``service_timer`` is the discharge clock (it is reset whenever the
    lane is not served, so a lane can never bank service across a red);
    ``arrival_timer`` is the arrival clock of an external arm.
    """

    queue: int = 0
    service_timer: float = 0.0
    arrival_timer: float = 0.0


@dataclass
class _Arm:
    """The live state of one arm."""

    spec: ArmSpec
    lanes: list[_Lane] = field(default_factory=list)


class NetworkSignalEnv(gym.Env[np.ndarray, np.ndarray]):
    """A multi-junction signal environment.

    * observation: ``(n_junctions, 6)`` - the six dimensions of
      ``signal_env``, per junction;
    * action: one of ``sim_core.SIGNAL_ACTION_NAMES`` **per junction** -
      ``step`` takes a sequence of ``n_junctions`` indices and returns
      one network-wide reward;
    * reward: the **network total delay**, i.e. the negative area under
      the network-wide queue-length curve.

    The reward is shared (one number for the whole network) because the
    task is global: a junction that serves its own queue at the cost of
    the network's delay has not solved anything. The observation stays
    local - the same six numbers the browser's per-junction agent sees -
    so the policy has to learn the global trade-off from a local view.
    """

    metadata = {"render_modes": []}

    def __init__(
        self,
        network: dict[str, Any] | None = None,
        *,
        condition: TrafficCondition = TRAIN_CONDITION,
        max_steps: int = 2000,
        turn_probability: float = 0.0,
        seed: int | None = None,
        vehicle_speed: float = NPC_SPEED,
        saturation_headway: float = SATURATION_HEADWAY_SECS,
        row_phase_secs: float = GRID_ROW_PHASE_SECS,
        external_demand: bool = True,
    ) -> None:
        super().__init__()
        self.network: dict[str, Any] = (
            network if network is not None else build_grid_network_dict(2, 2)
        )
        self.graph: NetworkGraph = build_network_graph(self.network)
        self.condition = condition
        self.max_steps = int(max_steps)
        self.turn_probability = float(turn_probability)
        self.vehicle_speed = float(vehicle_speed)
        self.saturation_headway = float(saturation_headway)
        self.row_phase_secs = float(row_phase_secs)
        #: Whether the **external** arms generate traffic. Flipping it off
        #: drains the network: the traffic that is already inside keeps
        #: moving and leaves, and nothing new enters. That is how the
        #: vehicle conservation is measured over a closed window.
        self.external_demand = bool(external_demand)
        self._seed = seed

        self._junctions = self._build_topology()
        self._junction_ids = [spec.id for spec in self._junctions]
        self.n_junctions = len(self._junctions)

        self.observation_space = spaces.Box(
            low=-1.0,
            high=1.0,
            shape=(self.n_junctions, NET_OBS_DIM),
            dtype=np.float32,
        )
        # One action per junction - the action space of a single junction.
        self.action_space = spaces.Discrete(len(SIGNAL_ACTION_NAMES))

        self._arms: dict[str, dict[str, _Arm]] = {}
        self._cores: dict[str, SimCore] = {}
        self._pending: list[tuple[float, int, str, str, str]] = []
        self._turn_counter: dict[tuple[str, str], int] = {}
        self._sequence = 0
        self._time = 0.0
        self._step_count = 0
        self._total_delay = 0.0
        self._discharged: dict[str, int] = {}
        self._received: dict[str, int] = {}
        self._external: dict[str, int] = {}
        self._external_by_axis: dict[str, int] = {"ns": 0, "ew": 0}
        self._sent: dict[tuple[str, str], int] = {}
        self._arrived: dict[tuple[str, str], int] = {}
        self._in_transit: dict[tuple[str, str], int] = {}
        self._left_network = 0

    # -- Gymnasium API ------------------------------------------------

    def reset(
        self,
        *,
        seed: int | None = None,
        options: dict[str, Any] | None = None,
    ) -> tuple[np.ndarray, dict[str, Any]]:
        super().reset(seed=seed)
        if seed is not None:
            self._seed = seed
        self._arms = {
            spec.id: {
                arm.direction: _Arm(
                    spec=arm,
                    lanes=[_Lane() for _ in range(arm.lanes)],
                )
                for arm in spec.arms
            }
            for spec in self._junctions
        }
        self._cores = {spec.id: self._make_light_core() for spec in self._junctions}
        offsets = self._phase_offsets()
        for junction_id, core in self._cores.items():
            core.light.cycle_timer = offsets.get(junction_id, 0.0)
        self._pending = []
        self._turn_counter = {}
        self._sequence = 0
        self._time = 0.0
        self._step_count = 0
        self._total_delay = 0.0
        self._discharged = {spec.id: 0 for spec in self._junctions}
        self._received = {spec.id: 0 for spec in self._junctions}
        self._external = {spec.id: 0 for spec in self._junctions}
        self._external_by_axis = {"ns": 0, "ew": 0}
        self._sent = {}
        self._arrived = {}
        self._in_transit = {}
        self._left_network = 0
        return self._observations(), {}

    def step(self, actions: Sequence[int]) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        indices = self._check_actions(actions)
        masked: list[bool] = []
        for junction_id, index in zip(self._junction_ids, indices, strict=True):
            name = SIGNAL_ACTION_NAMES[index]
            # The minimum green time: `shorten_red` is **refused** when it
            # would push the green below the minimum - the same mask the
            # single-junction env applies (the contract's rule: a red is
            # never shorter than 10 s, a green never shorter than 10 s).
            if name == "shorten_red" and not self._may_shorten_red(self._cores[junction_id]):
                masked.append(True)
                continue
            masked.append(False)
            self._cores[junction_id].light.apply_action(name)

        self._advance_traffic()
        # The light advance is `sim_core`'s own: `SimCore.step()` is the
        # code path the single-junction env runs, so the timeline is the
        # contract's timeline by construction.
        for junction_id in self._junction_ids:
            self._cores[junction_id].step(np.zeros(2, dtype=np.float32))

        total_queue = self._network_queue()
        delay = total_queue * DT
        self._total_delay += delay
        self._time += DT
        self._step_count += 1
        truncated = self._step_count >= self.max_steps

        info: dict[str, Any] = {
            "delay": delay,
            "total_delay": self._total_delay,
            "total_queue": total_queue,
            "masked": masked,
            "queue_ns": [self._axis_queue(jid, "ns") for jid in self._junction_ids],
            "queue_ew": [self._axis_queue(jid, "ew") for jid in self._junction_ids],
            "ns_green": [self._cores[jid].light.ns_green for jid in self._junction_ids],
            "ew_green": [self._cores[jid].light.ew_green for jid in self._junction_ids],
            "discharged": dict(self._discharged),
            "received": dict(self._received),
            "external": dict(self._external),
            "external_by_axis": dict(self._external_by_axis),
            "sent": {f"{a}->{b}": n for (a, b), n in self._sent.items()},
            "arrived": {f"{a}->{b}": n for (a, b), n in self._arrived.items()},
            "in_transit": {f"{a}->{b}": n for (a, b), n in self._in_transit.items()},
            "left_network": self._left_network,
        }
        return self._observations(), float(-delay), False, bool(truncated), info

    def render(self) -> None:  # pragma: no cover
        pass

    # -- the topology -------------------------------------------------

    def _build_topology(self) -> list[JunctionSpec]:
        """The junctions, their arms and their axes, read off the graph.

        The arms come from the graph's **geometry** (which junction a
        road's other end is at), not from ``connectedRoads``: the graph
        builder keeps only one junction per road in its road lists, so
        the endpoint map is the trustworthy source.
        """
        real = {
            node_id: node for node_id, node in self.graph.nodes.items() if not node.is_synthetic
        }
        arms: dict[str, dict[str, ArmSpec]] = {junction_id: {} for junction_id in real}
        for seg_id, (start_node, end_node) in self.graph.segment_endpoints.items():
            segment = self.graph.segments[seg_id]
            if segment.oneway:
                # The graph knows the one-way flag; this arm model does not
                # express it (a one-way arm carries traffic in one direction
                # only, and it is not a boundary arm either - it must not
                # generate demand). Simulating it as a bidirectional road
                # would be a silent lie, so the env refuses the network.
                raise ValueError(
                    f"road {seg_id} is one-way; the network signal env does not "
                    "support one-way roads yet (an imported map carries them)"
                )
            for near, far in ((start_node, end_node), (end_node, start_node)):
                if near not in real or far not in real:
                    continue
                direction = _direction_between(real[near].position, real[far].position)
                if direction in arms[near]:
                    raise ValueError(
                        f"junction {near} has two roads in the {direction} direction; "
                        "the arm model needs one road per direction"
                    )
                arms[near][direction] = ArmSpec(
                    junction_id=near,
                    direction=direction,
                    axis=AXIS_OF[direction],
                    lanes=max(1, segment.lane_count // 2),
                    neighbour_id=far,
                    link_length=segment.length,
                )

        specs: list[JunctionSpec] = []
        for junction_id, node in real.items():
            internal = arms[junction_id]
            # The boundary arms carry the junction's own lane count - the
            # road continues past the edge of the network.
            lanes = max((arm.lanes for arm in internal.values()), default=2)
            for direction in DIRECTIONS:
                if direction in internal:
                    continue
                internal[direction] = ArmSpec(
                    junction_id=junction_id,
                    direction=direction,
                    axis=AXIS_OF[direction],
                    lanes=lanes,
                    neighbour_id=None,
                    link_length=0.0,
                )
            specs.append(
                JunctionSpec(
                    id=junction_id,
                    position=(node.position[0], node.position[1]),
                    arms=tuple(internal[direction] for direction in DIRECTIONS),
                )
            )
        specs.sort(key=lambda spec: (spec.position[1], spec.position[0]))
        return specs

    def _phase_offsets(self) -> dict[str, float]:
        """The per-junction phase offset.

        The junctions are ranked by their z coordinate and the rank times
        ``row_phase_secs`` is the offset - the browser's grid does the
        same (``GRID_ROW_PHASE_SECS``), so the network does not pulse as
        one. It does not change the clearance or the period.
        """
        if self.row_phase_secs == 0.0:
            return {spec.id: 0.0 for spec in self._junctions}
        rows = sorted({round(spec.position[1], 3) for spec in self._junctions})
        rank = {z: index for index, z in enumerate(rows)}
        return {
            spec.id: rank[round(spec.position[1], 3)] * self.row_phase_secs
            for spec in self._junctions
        }

    def _make_light_core(self) -> SimCore:
        """A `SimCore` that exists only to advance one light.

        The traffic is this module's own model, so the core carries no
        NPCs; the ego is parked off the road with zero speed (it cannot
        move, cannot run a red and cannot be hit). What is left of
        ``SimCore.step()`` is exactly the contract's light advance.
        """
        core = SimCore(max_steps=10**9, responsive_traffic=True)
        core.npcs = []
        core.ego = Vehicle(x=20.0, z=-45.0, speed=0.0)
        return core

    # -- the traffic --------------------------------------------------

    def _advance_traffic(self) -> None:
        """One step of the network's traffic.

        The order mirrors the single-junction env: the vehicles that
        reached their downstream junction are delivered, the green serves
        the queues, and the new external arrivals join at the back of the
        queue afterwards (so a fresh arrival is never served in the step
        it appears).
        """
        self._deliver_arrivals()
        self._serve_queues()
        self._spawn_external_arrivals()

    def _deliver_arrivals(self) -> None:
        """The vehicles that reached the downstream junction's stop line."""
        while self._pending and self._pending[0][0] <= self._time:
            _arrival, _seq, destination, direction, source = heapq.heappop(self._pending)
            arm = self._arms[destination][direction]
            self._pick_lane(arm).queue += 1
            self._received[destination] += 1
            key = (source, destination)
            self._arrived[key] = self._arrived.get(key, 0) + 1
            self._in_transit[key] = self._in_transit.get(key, 0) - 1

    def _spawn_external_arrivals(self) -> None:
        """The external arms' arrivals - at the demand, **per lane**."""
        if not self.external_demand:
            return
        for junction_id in self._junction_ids:
            for direction in DIRECTIONS:
                arm = self._arms[junction_id][direction]
                if arm.spec.neighbour_id is not None:
                    continue
                rate = (
                    self.condition.ew_arrivals_per_hour
                    if arm.spec.axis == "ew"
                    else self.condition.ns_arrivals_per_hour
                )
                if rate <= 0:
                    continue
                headway = 3600.0 / float(rate)
                for lane in arm.lanes:
                    lane.arrival_timer += DT
                    while lane.arrival_timer >= headway:
                        lane.arrival_timer -= headway
                        lane.queue += 1
                        self._external[junction_id] += 1
                        self._external_by_axis[arm.spec.axis] += 1

    def _serve_queues(self) -> None:
        """The green serves the queues at the saturation flow."""
        for junction_id in self._junction_ids:
            core = self._cores[junction_id]
            for direction in DIRECTIONS:
                arm = self._arms[junction_id][direction]
                green = core.light.ns_green if arm.spec.axis == "ns" else core.light.ew_green
                for lane in arm.lanes:
                    if not green or lane.queue == 0:
                        # No banking: a lane that is not served starts its
                        # next service interval from zero.
                        lane.service_timer = 0.0
                        continue
                    lane.service_timer += DT
                    if lane.service_timer >= self.saturation_headway:
                        lane.service_timer -= self.saturation_headway
                        lane.queue -= 1
                        self._cross(junction_id, direction)

    def _cross(self, junction_id: str, incoming: str) -> None:
        """One vehicle crosses the intersection and picks its exit arm."""
        self._discharged[junction_id] = self._discharged.get(junction_id, 0) + 1
        exit_direction = self._exit_direction(junction_id, incoming)
        exit_arm = self._arms[junction_id][exit_direction]
        if exit_arm.spec.neighbour_id is None:
            # The boundary arm: the vehicle leaves the network.
            self._left_network += 1
            return
        destination = exit_arm.spec.neighbour_id
        travel = exit_arm.spec.link_length / self.vehicle_speed
        self._sequence += 1
        heapq.heappush(
            self._pending,
            (
                self._time + travel,
                self._sequence,
                destination,
                OPPOSITE[exit_direction],
                junction_id,
            ),
        )
        key = (junction_id, destination)
        self._sent[key] = self._sent.get(key, 0) + 1
        self._in_transit[key] = self._in_transit.get(key, 0) + 1

    def _exit_direction(self, junction_id: str, incoming: str) -> str:
        """The arm a vehicle leaves the junction by.

        Straight ahead by default (the browser's rule: "go straight if
        you can"), and a probabilistic turn when ``turn_probability`` is
        positive. The turn is **reproducible**: it is a hash of the
        episode's coordinates, not a draw from the interpreter's global
        random state.
        """
        if self.turn_probability <= 0.0:
            return OPPOSITE[incoming]
        if self._uniform(junction_id, incoming, "turn") >= self.turn_probability:
            return OPPOSITE[incoming]
        if self._uniform(junction_id, incoming, "side") < 0.5:
            return LEFT_TURN[incoming]
        return RIGHT_TURN[incoming]

    def _uniform(self, junction_id: str, incoming: str, salt: str) -> float:
        """A reproducible pseudo-random number in [0, 1)."""
        key = (junction_id, incoming)
        counter = self._turn_counter.get(key, 0)
        self._turn_counter[key] = counter + 1
        digest = hashlib.blake2b(
            f"{self._seed}|{junction_id}|{incoming}|{salt}|{counter}".encode(),
            digest_size=8,
        ).digest()
        return int.from_bytes(digest, "big") / 2.0**64

    @staticmethod
    def _pick_lane(arm: _Arm) -> _Lane:
        """The lane an arriving vehicle joins: the shortest queue."""
        best = arm.lanes[0]
        for lane in arm.lanes[1:]:
            if lane.queue < best.queue:
                best = lane
        return best

    # -- the numbers --------------------------------------------------

    def _axis_queue(self, junction_id: str, axis: str) -> int:
        """The queue on one axis of one junction: the sum over its arms."""
        total = 0
        for direction in DIRECTIONS:
            arm = self._arms[junction_id][direction]
            if arm.spec.axis != axis:
                continue
            for lane in arm.lanes:
                total += lane.queue
        return total

    def _network_queue(self) -> int:
        """The queue of the whole network."""
        return sum(
            self._axis_queue(junction_id, axis)
            for junction_id in self._junction_ids
            for axis in ("ns", "ew")
        )

    def _observations(self) -> np.ndarray:
        """The per-junction observation: the six dimensions of `signal_env`."""
        obs = np.zeros((self.n_junctions, NET_OBS_DIM), dtype=np.float32)
        for index, junction_id in enumerate(self._junction_ids):
            core = self._cores[junction_id]
            obs[index, 0] = min(self._axis_queue(junction_id, "ns") / MAX_QUEUE, 1.0)
            obs[index, 1] = min(self._axis_queue(junction_id, "ew") / MAX_QUEUE, 1.0)
            obs[index, 2] = 1.0 if core.light.ns_green else 0.0
            obs[index, 3] = 1.0 if core.light.ew_green else 0.0
            obs[index, 4] = 1.0 if (not core.light.ns_green and not core.light.ew_green) else 0.0
            obs[index, 5] = core.light.cycle_timer / core.light.cycle_duration
        return obs

    @staticmethod
    def _may_shorten_red(core: SimCore) -> bool:
        """May a `shorten_red` action be applied right now?

        The same rule as the single-junction env: the adjustment takes
        ``PHASE_ADJUST_SECS`` off the green's **remaining** time, so it is
        refused when that would push the green below ``MIN_GREEN_SECS`` -
        and during the inter-green clearance, where the clock is frozen
        and the adjustment would shorten the *next* green.
        """
        if core.in_clearance:
            return False
        light = core.light
        remaining = light.cycle_duration - light.cycle_timer
        return remaining - PHASE_ADJUST_SECS >= MIN_GREEN_SECS

    def _check_actions(self, actions: Sequence[int]) -> list[int]:
        """One action index per junction, in range."""
        indices = [int(action) for action in actions]
        if len(indices) != self.n_junctions:
            raise ValueError(
                f"expected {self.n_junctions} actions (one per junction), got {len(indices)}"
            )
        for index in indices:
            if not 0 <= index < len(SIGNAL_ACTION_NAMES):
                raise ValueError(
                    f"signal action index {index} out of range; "
                    f"expected 0..{len(SIGNAL_ACTION_NAMES) - 1}"
                )
        return indices

    # -- the report ---------------------------------------------------

    def conservation_report(self) -> dict[str, Any]:
        """The vehicle conservation numbers.

        ``sent`` is what a junction sent down a link, ``arrived`` is what
        the downstream junction received from it, and ``in_transit`` is
        what is still on the link between the two. The identity
        ``sent == arrived + in_transit`` holds at every step - that is
        the conservation the level is about.
        """
        pairs = []
        for key in sorted(set(self._sent) | set(self._arrived)):
            source, destination = key
            pairs.append(
                {
                    "from": source,
                    "to": destination,
                    "sent": self._sent.get(key, 0),
                    "arrived": self._arrived.get(key, 0),
                    "in_transit": self._in_transit.get(key, 0),
                }
            )
        return {
            "pairs": pairs,
            "per_junction": [
                {
                    "junction": junction_id,
                    "discharged": self._discharged.get(junction_id, 0),
                    "received": self._received.get(junction_id, 0),
                    "external": self._external.get(junction_id, 0),
                    "queue": self._axis_queue(junction_id, "ns")
                    + self._axis_queue(junction_id, "ew"),
                }
                for junction_id in self._junction_ids
            ],
            "external_by_axis": dict(self._external_by_axis),
            "left_network": self._left_network,
            "total_delay": self._total_delay,
        }


def _direction_between(origin: tuple[float, float], target: tuple[float, float]) -> str:
    """The compass direction from `origin` to `target`.

    The dominant axis wins: a grid is axis-aligned, and a road that is
    not (a diagonal) is classified by the axis it is closest to.
    """
    dx = target[0] - origin[0]
    dz = target[1] - origin[1]
    if abs(dx) >= abs(dz):
        return "e" if dx > 0 else "w"
    return "n" if dz > 0 else "s"
