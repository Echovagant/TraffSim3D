"""Multi-agent driving core — several learned drivers on one road network.

This is the **third** simulation core, and it is a different thing from the
other two:

    sim_core.py         14-dim observation, fixed scenes (cross/corridor),
                        byte-compared against the TypeScript mirror by the
                        cross-language contract tests. It is the contract
                        authority — never edit it.

    network_sim_core.py 24-dim observation, arbitrary road network, ONE
                        learned ego + scripted NPCs.

    drive_core.py       (this module) arbitrary road network, N learned
                        drivers + scripted traffic, and the bookkeeping a
                        *cooperative* reward needs: per-vehicle delay and
                        the attribution of a wait to the vehicle that caused
                        it.

Like `network_sim_core`, this module must never import `sim_core`: the
contract goldens must not depend on a user-authored network.

The three things that make this core different from the single-ego one
-----------------------------------------------------------------------------
1. **Several agents, one policy.** Every learned driver runs the same
   actor (parameter sharing), so the browser can load one weight file and
   drive every car with it.
2. **A conflict zone.** The observation is built around the junction the
   agents are negotiating: each vehicle's distance to it, its arrival
   time, and — for the others — how much earlier or later they arrive.
   That difference (Δt) is what "who goes first" is made of.
3. **Delay attribution.** A wait is not free: whoever caused it pays for
   it. The reward of the vehicle that blocked another one carries the
   blocked vehicle's delay, which is what turns "keep going" into
   "negotiate".

The observation (29 dims, per agent)
------------------------------------
    [0]      own speed
    [1]      own distance to the conflict point
    [2]      own arrival time at the conflict point
    [3]      own bearing to the conflict point, relative to own heading
    [4]      own route progress
    [5]      am I inside the conflict zone (0/1)
    [6]      how many of the others arrive before I do (0..3, /3)
    [7]      the earliest such difference, in seconds (/10)
    [8..28]  the three nearest other vehicles, SEVEN numbers each:
             present (0/1), their offset from the conflict point in MY
             frame (x, z), their speed, their arrival time minus mine,
             COMMITTED (inside the junction box, 0/1), and YIELDING
             (stopped outside the box, 0/1)

The offsets are expressed in the ego's frame, so "which side of me is
that car coming from" is directly readable — and the frame rotates with
the ego, so the policy does not have to learn four different approaches.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .idm import find_lead_vehicle, idm_acceleration
from .network_graph import NetworkGraph, Route, point_on_road

#: The observation dimension of one learned driver.
#:
#: 29 = 8 own-state numbers + three other-vehicle slots of SEVEN
#: numbers each. The two extra numbers per slot (added 2026-10-31) are
#: the negotiation state the policy could not see before: whether the
#: other is INSIDE the junction box (committed — it will not yield) and
#: whether it is STOPPED outside the box (has yielded — the way is
#: mine). The measured gap to the right-of-way rule (conflicts 1.8 per
#: window against 0.2) was attributed to exactly this: the arrival
#: delta says WHEN the other arrives, not whether it will still be
#: there when I do.
OBS_DIM_DRIVE = 29

#: The number of other vehicles each agent perceives (nearest first).
NEAREST_OTHERS = 3

#: The action dimension: (acceleration, steering residual).
ACTION_DIM_DRIVE = 2

#: The vehicle model's constants. They shadow `network_sim_core`'s on
#: purpose — the two cores are separate namespaces, not one config.
SPEED_LIMIT_DRIVE = 16.67
NPC_SPEED_DRIVE = 8.0
EGO_WHEELBASE = 2.5
COLLISION_DISTANCE = 2.5
LOOKAHEAD_DISTANCE = 10.0
MAX_STEER = 0.4
DT = 0.1
MAX_ACCEL = 3.0

#: Below this speed a vehicle counts as *waiting* (and accrues delay).
WAITING_SPEED = 2.0

#: The conflict zone: the junction's radius (m).
CONFLICT_RADIUS = 6.0

#: The radius at which a pair **leaves** the conflict zone. The gap to
#: `CONFLICT_RADIUS` is the hysteresis that keeps a vehicle sitting on
#: the boundary from flickering in and out of the zone.
CONFLICT_RELEASE_M = 7.5

#: The lateral tolerance of the lead search (m) — one lane width, the
#: same rule the IDM uses.
LEAD_LANE_TOLERANCE = 3.5

#: The lead search range (m) — the IDM's own.
LEAD_SEARCH_RANGE = 30.0

#: How close (m) a vehicle has to be to count as "arrived" at the
#: conflict point.
ARRIVAL_TOLERANCE = 2.0

#: How close (m) to the end of its current segment a vehicle has to be
#: before the route advances to the next segment.
SEGMENT_ADVANCE_M = 2.0

#: The junction's roads carry this many lanes (two each way), so a
#: vehicle drives `laneOffset(0, LANE_COUNT)` = 5.25 m to the right of
#: the centre line — the same convention the browser uses.
#:
#: The offset is not cosmetic: without it, a vehicle leaving through an
#: arm and a vehicle approaching along the same arm would drive down the
#: *same* centre line in opposite directions — a head-on collision
#: baked into the geometry, with nothing to negotiate. With it, the two
#: are 10.5 m apart and meet only where their paths really cross.
LANE_COUNT = 4

#: The lateral distance from the centre line to the keep-right lane.
LANE_OFFSET_M = (LANE_COUNT / 2 - 0.5) * 3.5

#: The cost of a conflict: two vehicles inside the junction's box at the
#: same time. It is a *conflict*, not necessarily an overlap — that is
#: the traffic-engineering notion, and it is the thing the negotiation
#: is about.
#:
#: The scale matters: the delay costs 0.1 per step of waiting, so a
#: conflict at 1.0 per step is "as expensive as ten seconds of waiting".
#: At 2.0 the conflict term dominated everything and the policy's
#: cheapest way out was to never enter the box at all — which is not a
#: negotiation, it is a standstill.
CONFLICT_PENALTY = 1.0

#: The per-driver reward for MAKING PROGRESS along its route.
#:
#: v2's measured failure (three 40k-step runs, best -82.5 against the
#: baselines' -84.8 / -68.5, ONE of six drivers through in the window)
#: was a **standstill equilibrium**: waiting costs only the delay rate
#: (0.1/s) while moving risks conflict and collision penalties, so the
#: gradient pointed at "yield forever". The progress term breaks that
#: equilibrium: driving earns what waiting costs. The scale — the full
#: route is worth 2.0, i.e. ~20 s of waiting — keeps it WELL under the
#: collision penalty (50) so rushing is never the cheap way out, and
#: comfortably above the noise of a single conflict event (1.0).
PROGRESS_REWARD = 2.0

#: The per-driver bonus for REACHING the end of its route.
#:
#: The terminal counterpart of the progress term: a driver that gets
#: through stops the delay bleed for good. 5.0 = ~50 s of waiting —
#: larger than the conflict events a rushed crossing would collect
#: (2-3 x 1.0), so it cannot be hacked by driving through traffic, and
#: far below the collision penalty.
FINISH_BONUS = 5.0

#: The cost of an actual overlap.
#:
#: The ratio matters more than the number. A crash has to be worth
#: **much more** than the waiting it causes, or the objective says the
#: wrong thing: measured with a crash worth 5 (a second of waiting is
#: 0.1), the "nobody yields" baseline came out **ahead** of the
#: classical right-of-way rule (-23.5 against -67.0) — the policy would
#: have been rewarded for crashing through. At 20 (a crash is worth 20
#: seconds of waiting) the ordering is the intended one: crashing is
#: the worst thing that can happen at a junction.
COLLISION_PENALTY = 50.0


@dataclass
class DriveVehicle:
    """One vehicle in the core — learned driver or scripted traffic."""

    x: float = 0.0
    z: float = 0.0
    heading: float = 0.0
    speed: float = 0.0
    route: Route = field(default_factory=lambda: Route(segment_ids=[]))
    route_progress: float = 0.0
    current_seg_idx: int = 0
    seg_t: float = 0.0
    #: Learned drivers are the agents; scripted traffic is the background.
    is_agent: bool = False
    agent_index: int = -1
    #: Accumulated waiting time (veh·s).
    delay: float = 0.0
    #: Accumulated waiting time this vehicle caused to others (veh·s).
    caused_delay: float = 0.0
    #: This step's waiting time (veh·s).
    delay_increment: float = 0.0
    #: This step's waiting time caused to others (veh·s).
    caused_delay_increment: float = 0.0
    #: This step's collisions.
    collisions_increment: int = 0
    #: This step's conflicts (both vehicles inside the junction's box).
    conflicts_increment: int = 0
    #: This step's route progress gain (reward input; the grid env's
    #: progress reward consumes it).
    progress_gain: float = 0.0
    #: Whether the vehicle FINISHED on this step (reward input).
    finished_increment: int = 0
    #: The route progress at the end of the previous step.
    prev_route_progress: float = 0.0
    #: How many collisions this vehicle was involved in (cumulative).
    collisions: int = 0
    #: How many conflicts this vehicle was involved in (cumulative).
    conflicts: int = 0
    #: A stable identity (the pair bookkeeping needs a key).
    id: str = ""
    #: The junction this vehicle is heading for — its own conflict
    #: point. On the single-junction scenario this is THE junction for
    #: everyone; on a network it is the next real intersection on the
    #: route, updated as the route advances (see
    #: `_update_next_junction`). `None` falls back to the core's
    #: `conflict_point`.
    next_junction: tuple[float, float] | None = None
    #: Whether it has reached the end of its route.
    finished: bool = False
    #: The simulation time at which it finished (0 while unfinished).
    finished_at: float = 0.0


class DriveCore:
    """A road network with several learned drivers and scripted traffic.

    The learned drivers are the **agents**: their acceleration and
    steering come from the policy. The scripted traffic is driven by the
    IDM car-following model, exactly like the NPCs of the single-ego core.
    """

    obs_dim: int = OBS_DIM_DRIVE

    def __init__(
        self,
        graph: NetworkGraph,
        *,
        n_agents: int = 3,
        n_npcs: int = 1,
        conflict_point: tuple[float, float] = (0.0, 0.0),
        max_steps: int = 400,
        progress_reward: bool = False,
        conflict_penalty: float = CONFLICT_PENALTY,
    ) -> None:
        if n_agents < 1:
            raise ValueError(f"n_agents must be >= 1, got {n_agents}")
        self.graph = graph
        self.n_agents = n_agents
        self.n_npcs = max(0, n_npcs)
        self.conflict_point = conflict_point
        self.max_steps = max_steps
        # The progress / finish incentives (the standstill-equilibrium
        # fix). The single-junction scenario keeps its measured reward —
        # the shipped policy's numbers were taken with it — so this is
        # opt-in, enabled by the GRID scenario where the standstill
        # equilibrium was measured.
        self.progress_reward = progress_reward
        # The conflict penalty is recalibratable per scenario: the grid
        # measures MORE conflict events per route (a route crosses
        # several junctions), so the same 1.0/event that worked for one
        # junction under-weights them there (measured: the v3 policy's
        # conflicts, 1.8/window, were the gap to the right-of-way
        # baseline).
        self.conflict_penalty = conflict_penalty
        self.step_count = 0
        self.sim_time = 0.0
        self.agents: list[DriveVehicle] = []
        self.npcs: list[DriveVehicle] = []
        self.vehicles: list[DriveVehicle] = []
        self._terminated = False
        self._terminated_reason = ""
        self.total_collisions = 0
        #: How many (step, pair) conflicts were counted.
        self.total_conflicts = 0
        #: Which pairs were jointly inside the box last step (the
        #: conflict events are counted on the transition into it).
        self._joint_in_zone: dict[tuple[str, str], bool] = {}
        #: Steps in which nothing moved while vehicles remained.
        self.deadlock_steps = 0

    # ---- lifecycle ------------------------------------------------------

    def reset(self, rng: np.random.Generator) -> None:
        """Place the agents and the scripted traffic, and give them routes.

        The agents approach the conflict point from different roads, at
        slightly different distances — so the negotiation has a natural
        order (who arrives first) instead of every car arriving at the
        same instant, which would be a coin toss rather than a decision.
        """
        self.step_count = 0
        self.sim_time = 0.0
        self._terminated = False
        self._terminated_reason = ""
        self.total_collisions = 0
        # The conflict counter is a **per-episode** number: without the
        # reset here it accumulated over the whole run, and the reported
        # "conflicts" grew by ~20 per evaluation no matter what the
        # policy did (measured over a 30 000 step run).
        self.total_conflicts = 0
        self._joint_in_zone = {}
        self._overlapping = {}
        self.deadlock_steps = 0
        self.agents = []
        self.npcs = []

        approaches = self.approach_roads()
        if len(approaches) < 2:
            raise ValueError(
                "the network needs at least two approach roads to negotiate, "
                f"found {len(approaches)}"
            )

        for index in range(self.n_agents):
            in_road, out_road = self._pick_approach(approaches, index)
            vehicle = self._spawn_on(in_road, out_road, rng, is_agent=True)
            vehicle.agent_index = index
            self.agents.append(vehicle)

        for index in range(self.n_npcs):
            in_road, out_road = self._pick_approach(approaches, self.n_agents + index)
            self.npcs.append(self._spawn_on(in_road, out_road, rng, is_agent=False))

        self.vehicles = [*self.agents, *self.npcs]
        for index, vehicle in enumerate(self.vehicles):
            vehicle.id = f"v-{index}"

    def _pick_approach(
        self,
        approaches: list[tuple[str, str]],
        index: int,
    ) -> tuple[str, str]:
        """The (in, out) roads for the n-th vehicle.

        The vehicles must come from **different arms** — two cars on the
        same approach never meet at the junction, so they would not be
        negotiating at all. And the exit must be a different arm: leaving
        by the arm you came from is a U-turn, not a negotiation.
        """
        incoming = sorted({in_road for in_road, _ in approaches})
        in_road = incoming[index % len(incoming)]
        exits = [out_road for candidate_in, out_road in approaches if candidate_in == in_road]
        # A different arm. The arms are told apart by their **outer
        # end**: the road that comes in from the west and the road that
        # goes out to the west have different ids but share their outer
        # end, and pairing them would be a U-turn, not a negotiation.
        outer = self._outer_end(in_road)
        distinct = [out for out in exits if self._outer_end(out) != outer]
        pool = distinct or exits
        return (in_road, pool[index % len(pool)])

    def _outer_end(self, road_id: str) -> tuple[float, float] | None:
        """The end of a road that is *not* at the conflict point."""
        segment = self.graph.segments.get(road_id)
        if segment is None or not segment.points:
            return None
        for point in (segment.points[0], segment.points[-1]):
            if not self._is_conflict(point):
                return (point[0], point[1])
        return None

    def approach_roads(self) -> list[tuple[str, str]]:
        """The (incoming, outgoing) road pairs around the conflict point.

        A road "comes in" when it *ends* at the conflict point and
        "goes out" when it *starts* there. The pairs are the ways through
        the junction: an agent that comes in on one road leaves on
        another (never back the way it came — that is a U-turn, not a
        negotiation).
        """
        incoming: list[str] = []
        outgoing: list[str] = []
        for seg_id, (start_node, end_node) in self.graph.segment_endpoints.items():
            if seg_id not in self.graph.segments:
                continue
            end_pos = self.graph.nodes[end_node].position if end_node in self.graph.nodes else None
            start_pos = (
                self.graph.nodes[start_node].position if start_node in self.graph.nodes else None
            )
            if end_pos and self._is_conflict(end_pos):
                incoming.append(seg_id)
            if start_pos and self._is_conflict(start_pos):
                outgoing.append(seg_id)
        pairs: list[tuple[str, str]] = []
        for in_road in incoming:
            for out_road in outgoing:
                if in_road != out_road:
                    pairs.append((in_road, out_road))
        return pairs

    def _is_conflict(self, position: tuple[float, float]) -> bool:
        return (
            math.hypot(
                position[0] - self.conflict_point[0],
                position[1] - self.conflict_point[1],
            )
            <= CONFLICT_RADIUS + 1e-6
        )

    def _spawn_on(
        self,
        in_road: str,
        out_road: str,
        rng: np.random.Generator,
        *,
        is_agent: bool,
    ) -> DriveVehicle:
        """Put a vehicle on `in_road`, heading for the conflict point.

        The start distance is jittered per vehicle (and per seed): with
        every car equally far away, who goes first would be decided by
        floating-point luck instead of by negotiation.
        """
        segment = self.graph.segments[in_road]
        # Start between 45 % and 80 % of the way in, so the agents are
        # staggered but none of them starts inside the junction.
        fraction = float(rng.uniform(0.45, 0.80))
        distance = segment.length * fraction
        heading = self._segment_heading(segment, distance)
        x, z = self._lane_point(segment, distance, heading)

        route = Route(segment_ids=[in_road, out_road], found=True)
        return DriveVehicle(
            x=x,
            z=z,
            heading=heading,
            speed=0.0,
            route=route,
            route_progress=0.0,
            current_seg_idx=0,
            seg_t=distance,
            is_agent=is_agent,
        )

    def _lane_point(self, segment: Any, t: float, heading: float) -> tuple[float, float]:
        """A point on the segment's **keep-right lane**, not its centre.

        The lateral offset is what keeps an approaching vehicle and a
        departing one out of each other's way on a shared arm.
        """
        x, z = point_on_road(segment, t)
        return (x + math.sin(heading) * LANE_OFFSET_M, z - math.cos(heading) * LANE_OFFSET_M)

    def _segment_heading(self, segment: Any, t: float) -> float:
        """The travel heading of a segment at arc length `t`."""
        points = segment.points
        accumulated = 0.0
        for i in range(len(points) - 1):
            dx = points[i + 1][0] - points[i][0]
            dz = points[i + 1][1] - points[i][1]
            seg_len = math.hypot(dx, dz)
            if accumulated + seg_len >= t or i == len(points) - 2:
                if seg_len < 1e-9:
                    return 0.0
                return math.atan2(dz, dx)
            accumulated += seg_len
        return math.atan2(points[-1][1] - points[0][1], points[-1][0] - points[0][0])

    # ---- stepping -------------------------------------------------------

    def step(
        self,
        actions: Sequence[Sequence[float]],
    ) -> tuple[list[np.ndarray], list[float], bool, bool, dict[str, Any]]:
        """Advance the world by one step.

        `actions[i]` is the (acceleration, steering residual) of agent
        `i`. The scripted traffic is driven by the IDM model.
        """
        if self._terminated:
            return (
                self.observations(),
                [0.0] * self.n_agents,
                True,
                False,
                {"reason": self._terminated_reason},
            )

        for vehicle in self.vehicles:
            vehicle.delay_increment = 0.0
            vehicle.caused_delay_increment = 0.0
            vehicle.collisions_increment = 0
            vehicle.conflicts_increment = 0
            vehicle.progress_gain = 0.0
            vehicle.finished_increment = 0

        for index, agent in enumerate(self.agents):
            action = actions[index] if index < len(actions) else (0.0, 0.0)
            self._drive_agent(agent, action)

        for npc in self.npcs:
            self._drive_npc(npc)

        for vehicle in self.vehicles:
            self._advance_route_progress(vehicle)

        self._detect_collisions()
        self._accumulate_delay()
        self._check_deadlock()

        self.sim_time += DT
        self.step_count += 1

        rewards = self._rewards()
        observations = self.observations()
        terminated, truncated, info = self._termination()
        return observations, rewards, terminated, truncated, info

    def _drive_agent(self, vehicle: DriveVehicle, action: Sequence[float]) -> None:
        """An agent: the policy's acceleration, Pure Pursuit + a residual."""
        accel = max(-MAX_ACCEL, min(MAX_ACCEL, float(action[0]) * MAX_ACCEL))
        steer_residual = max(-1.0, min(1.0, float(action[1]))) * MAX_STEER

        vehicle.speed = max(0.0, vehicle.speed + accel * DT)
        steer = self._pure_pursuit_steer(vehicle) + steer_residual
        steer = max(-MAX_STEER, min(MAX_STEER, steer))
        vehicle.heading += steer * DT
        vehicle.x += vehicle.speed * math.cos(vehicle.heading) * DT
        vehicle.z += vehicle.speed * math.sin(vehicle.heading) * DT

    def _drive_npc(self, vehicle: DriveVehicle) -> None:
        """Scripted traffic: IDM for the speed, Pure Pursuit for the line."""
        lead = self._lead_for(vehicle)
        accel = idm_acceleration(vehicle.speed, lead, desired_speed=NPC_SPEED_DRIVE)
        vehicle.speed = max(0.0, vehicle.speed + accel * DT)
        steer = self._pure_pursuit_steer(vehicle)
        vehicle.heading += steer * DT
        vehicle.x += vehicle.speed * math.cos(vehicle.heading) * DT
        vehicle.z += vehicle.speed * math.sin(vehicle.heading) * DT

    def _lead_for(self, vehicle: DriveVehicle) -> Any:
        """The lead vehicle of `vehicle` (the IDM dataclass), if any."""
        others = [v for v in self.vehicles if v is not vehicle]
        return find_lead_vehicle(
            vehicle.x,
            vehicle.z,
            vehicle.heading,
            vehicle.speed,
            others,
        )

    def _blocker_for(self, vehicle: DriveVehicle) -> DriveVehicle | None:
        """The vehicle `vehicle` is stuck behind, if any.

        The search mirrors the IDM's own lead search (same range, same
        forward cone, same lane width) and returns the **vehicle**, not
        the IDM's measurement: the IDM reports the bumper-to-bumper gap
        (the centre distance minus the vehicle length), which cannot be
        compared with a centre distance to find the vehicle again.
        """
        cos_h = math.cos(vehicle.heading)
        sin_h = math.sin(vehicle.heading)
        best: DriveVehicle | None = None
        best_distance = math.inf
        for other in self.vehicles:
            if other is vehicle:
                continue
            dx = other.x - vehicle.x
            dz = other.z - vehicle.z
            distance = math.hypot(dx, dz)
            if distance < 0.5 or distance > LEAD_SEARCH_RANGE:
                continue
            if dx * cos_h + dz * sin_h < 0:
                continue  # behind
            if abs(-dx * sin_h + dz * cos_h) > LEAD_LANE_TOLERANCE:
                continue  # more than one lane to the side
            if distance < best_distance:
                best = other
                best_distance = distance
        return best

    def _pure_pursuit_steer(self, vehicle: DriveVehicle) -> float:
        """The steering that keeps a vehicle on its route."""
        if not vehicle.route.segment_ids:
            return 0.0
        idx = min(vehicle.current_seg_idx, len(vehicle.route.segment_ids) - 1)
        seg_id = vehicle.route.segment_ids[idx]
        if seg_id not in self.graph.segments:
            return 0.0
        segment = self.graph.segments[seg_id]
        target_t = vehicle.seg_t + LOOKAHEAD_DISTANCE
        if target_t > segment.length and idx < len(vehicle.route.segment_ids) - 1:
            next_seg = vehicle.route.segment_ids[idx + 1]
            if next_seg in self.graph.segments:
                next_segment = self.graph.segments[next_seg]
                next_heading = self._segment_heading(next_segment, LOOKAHEAD_DISTANCE * 0.5)
                target = self._lane_point(next_segment, LOOKAHEAD_DISTANCE * 0.5, next_heading)
                return self._steer_towards(vehicle, target)
        clamped = min(target_t, segment.length)
        target = self._lane_point(segment, clamped, self._segment_heading(segment, clamped))
        return self._steer_towards(vehicle, target)

    def _steer_towards(self, vehicle: DriveVehicle, target: tuple[float, float]) -> float:
        """The Pure Pursuit steering law.

        `alpha` is the **textbook** one — the angle from the vehicle's
        heading to the target (`target_angle - heading`), so the steer
        turns *towards* it. This is the same convention as
        `sim_core.py` (the contract core), the browser's
        `purePursuit.ts` and `egoKernel.ts`: all three use the textbook
        sign, and the opposite one makes the steering **diverge** (the
        heading error grows every step). See the note in the browser's
        `purePursuit.ts` — the sign was wrong there until 2026-10-22.
        """
        dx = target[0] - vehicle.x
        dz = target[1] - vehicle.z
        target_angle = math.atan2(dz, dx)
        alpha = target_angle - vehicle.heading
        alpha = (alpha + math.pi) % (2 * math.pi) - math.pi
        return math.atan2(2.0 * EGO_WHEELBASE * math.sin(alpha), LOOKAHEAD_DISTANCE)

    def _junction_position(self, node_id: str) -> tuple[float, float] | None:
        """The position of a REAL intersection node (no placeholders)."""
        node = self.graph.nodes.get(node_id)
        if node is None or node.is_synthetic:
            return None
        return (node.position[0], node.position[1])

    def _update_next_junction(self, vehicle: DriveVehicle) -> None:
        """The next real intersection on the vehicle's route.

        The observation is built around the junction the vehicle is
        heading for — on a single junction that is THE junction, on a
        network it is the next one ahead. The route's remaining segments
        are scanned from the current one: the first segment whose end
        node is a real intersection is it.
        """
        if not vehicle.route.segment_ids:
            vehicle.next_junction = None
            return
        remaining = vehicle.route.segment_ids[vehicle.current_seg_idx :]
        for seg_id in remaining:
            endpoints = self.graph.segment_endpoints.get(seg_id)
            if endpoints is None:
                continue
            position = self._junction_position(endpoints[1])
            if position is not None:
                vehicle.next_junction = position
                return
        # No real intersection AHEAD (the vehicle is on its last stub,
        # whose end is a synthetic node). The junction it is LEAVING —
        # the last remaining segment's start — is the meaningful point:
        # the vehicle is driving away from it, and the observation's
        # distance/bearing read exactly that. Falling back to the core's
        # single-junction point here would be a lie on a grid (measured:
        # a car at (120, 0) reading a conflict point at (0, 0)).
        for seg_id in reversed(remaining):
            endpoints = self.graph.segment_endpoints.get(seg_id)
            if endpoints is None:
                continue
            position = self._junction_position(endpoints[0])
            if position is not None:
                vehicle.next_junction = position
                return
        vehicle.next_junction = None

    def _advance_route_progress(self, vehicle: DriveVehicle) -> None:
        """Track how far along its route a vehicle is.

        The route advances to the next segment when the vehicle reaches
        the end of the current one — the junction, in the negotiation
        scenario.
        """
        if not vehicle.route.segment_ids:
            return
        idx = min(vehicle.current_seg_idx, len(vehicle.route.segment_ids) - 1)
        seg_id = vehicle.route.segment_ids[idx]
        if seg_id not in self.graph.segments:
            return
        segment = self.graph.segments[seg_id]
        vehicle.seg_t = self._project_on_segment(segment, (vehicle.x, vehicle.z))

        # Past the end of the segment? The route moves on — by a
        # **pivot**, which is the model's own idiom for a turn (the
        # browser does the same: `roadTransition.ts`).
        #
        # The pivot matters here: the Pure Pursuit alone cannot make the
        # 90 degree turn, because the turn radius (wheelbase 2.5 m,
        # max steer 0.4 rad => ~6 m) is smaller than the lateral step
        # between the two lanes (10.5 m). The vehicle cut the corner and
        # ended up metres off its lane — measured 33 m off, which put the
        # "conflicts" in places where no two drivers' paths actually
        # cross.
        #
        # The pivot moves the body sideways by up to 7.4 m (the two lane
        # offsets are perpendicular at a 90 degree turn) — the same sweep
        # the browser documents for its own pivots.
        if (
            idx < len(vehicle.route.segment_ids) - 1
            and segment.length - vehicle.seg_t <= SEGMENT_ADVANCE_M
        ):
            self._pivot_to_next_segment(vehicle)

        total_length = sum(
            self.graph.segments[sid].length
            for sid in vehicle.route.segment_ids
            if sid in self.graph.segments
        )
        if total_length <= 0.0:
            vehicle.route_progress = 1.0
            return
        done = sum(
            self.graph.segments[sid].length
            for sid in vehicle.route.segment_ids[: vehicle.current_seg_idx]
            if sid in self.graph.segments
        )
        vehicle.route_progress = min(1.0, (done + vehicle.seg_t) / total_length)
        vehicle.progress_gain = max(0.0, vehicle.route_progress - vehicle.prev_route_progress)
        vehicle.prev_route_progress = vehicle.route_progress
        if vehicle.route_progress >= 0.999 and not vehicle.finished:
            vehicle.finished = True
            vehicle.finished_at = self.sim_time
            vehicle.finished_increment = 1
        # The conflict point rides the route: after every advance (and
        # every pivot), the vehicle looks at the next real intersection
        # ahead.
        self._update_next_junction(vehicle)

    def _pivot_to_next_segment(self, vehicle: DriveVehicle) -> None:
        """Move a vehicle onto the next segment's lane — the pivot."""
        idx = vehicle.current_seg_idx
        if idx + 1 >= len(vehicle.route.segment_ids):
            return
        next_id = vehicle.route.segment_ids[idx + 1]
        segment = self.graph.segments.get(next_id)
        if segment is None:
            return
        heading = self._segment_heading(segment, 0.0)
        x, z = self._lane_point(segment, 0.0, heading)
        vehicle.x = x
        vehicle.z = z
        vehicle.heading = heading
        vehicle.current_seg_idx = idx + 1
        vehicle.seg_t = 0.0

    def _project_on_segment(self, segment: Any, point: tuple[float, float]) -> float:
        """The arc length of the closest point on a segment."""
        points = segment.points
        best_t = 0.0
        best_d = math.inf
        accumulated = 0.0
        for i in range(len(points) - 1):
            ax, az = points[i]
            bx, bz = points[i + 1]
            dx = bx - ax
            dz = bz - az
            seg_len = math.hypot(dx, dz)
            if seg_len < 1e-9:
                continue
            t = ((point[0] - ax) * dx + (point[1] - az) * dz) / (seg_len * seg_len)
            t = max(0.0, min(1.0, t))
            px = ax + t * dx
            pz = az + t * dz
            distance = math.hypot(point[0] - px, point[1] - pz)
            if distance < best_d:
                best_d = distance
                best_t = accumulated + t * seg_len
            accumulated += seg_len
        return best_t

    def _conflict_zones(self) -> list[tuple[float, float]]:
        """The junction boxes a conflict can happen in.

        One per real intersection on the network; the single-junction
        scenario has exactly one. A network without any real intersection
        falls back to the core's conflict point.
        """
        zones = [
            position
            for position in (self._junction_position(node_id) for node_id in self.graph.nodes)
            if position is not None
        ]
        return zones or [self.conflict_point]

    def _detect_collisions(self) -> None:
        """Count the overlaps and the conflicts.

        A **collision** is an overlap — the bodies are in each other.
        A **conflict** is two vehicles inside the SAME junction's box at
        the same time: their paths cross there, whether or not they
        touched. The conflict is the thing the negotiation is about (the
        traffic-engineering notion), and it is what the reward charges.
        On a network every real intersection is a zone.
        """
        zones = self._conflict_zones()
        for i in range(len(self.vehicles)):
            for j in range(i + 1, len(self.vehicles)):
                a = self.vehicles[i]
                b = self.vehicles[j]
                pair_key = (a.id, b.id)
                overlapping = math.hypot(a.x - b.x, a.z - b.z) < COLLISION_DISTANCE
                was_overlapping = self._overlapping.get(pair_key, False)
                if overlapping and not was_overlapping:
                    # A collision is an **event**, charged once: the two
                    # bodies overlap for several steps, and charging
                    # every one of them made a one-second overlap cost
                    # 200 (a crash was priced at 20). The metrics count
                    # the event too.
                    a.collisions += 1
                    b.collisions += 1
                    self.total_collisions += 1
                    # The collision is charged to the vehicle that was
                    # **moving**. A vehicle that stopped (it yielded, as
                    # it should have) and was hit is the victim; charging
                    # it the same penalty as the one that drove into it
                    # leaves the policy unable to tell "I caused this"
                    # from "I was hit" — and the gradient points at
                    # "don't move" instead of "don't move into an
                    # occupied box".
                    if a.speed >= WAITING_SPEED:
                        a.collisions_increment += 1
                    if b.speed >= WAITING_SPEED:
                        b.collisions_increment += 1
                self._overlapping[pair_key] = overlapping
                # The conflict zones: a pair conflicts when both are
                # inside the SAME junction's box. A conflict is an
                # **event** (counted on the transition into it, with the
                # same release hysteresis the single-junction version
                # had — a vehicle sitting on the boundary flickers in
                # and out, and every flicker counted as a new conflict;
                # measured: 486 "conflicts" in one evaluation of a
                # policy that was not conflicting at all).
                for zone_index, (zx, cz) in enumerate(zones):
                    zone_key = (zone_index, a.id, b.id)
                    was_jointly = self._joint_in_zone.get(zone_key, False)
                    a_distance = math.hypot(a.x - zx, a.z - cz)
                    b_distance = math.hypot(b.x - zx, b.z - cz)
                    if was_jointly:
                        a_in_zone = a_distance <= CONFLICT_RELEASE_M
                        b_in_zone = b_distance <= CONFLICT_RELEASE_M
                    else:
                        a_in_zone = a_distance <= CONFLICT_RADIUS
                        b_in_zone = b_distance <= CONFLICT_RADIUS
                    jointly = a_in_zone and b_in_zone
                    if jointly and not was_jointly:
                        a.conflicts += 1
                        b.conflicts += 1
                        a.conflicts_increment += 1
                        b.conflicts_increment += 1
                        self.total_conflicts += 1
                    self._joint_in_zone[zone_key] = jointly

    def _accumulate_delay(self) -> None:
        """Accrue waiting time, and attribute it to whoever caused it.

        A vehicle that is waiting *behind another vehicle* is waiting
        because of it — so the blocker carries the cost. A vehicle that
        waits at the junction without a leader (waiting for a gap) pays
        for itself alone: nobody blocked it.
        """
        for vehicle in self.vehicles:
            if vehicle.finished:
                continue
            if vehicle.speed >= WAITING_SPEED:
                continue
            increment = DT
            vehicle.delay += increment
            vehicle.delay_increment += increment
            blocker = self._blocker_for(vehicle)
            if blocker is None:
                continue
            # The blocker is itself stuck — the wait is the traffic's,
            # not the blocker's fault.
            if blocker.speed >= WAITING_SPEED:
                continue
            blocker.caused_delay += increment
            blocker.caused_delay_increment += increment

    def _check_deadlock(self) -> None:
        """A step in which nobody moved while vehicles remained."""
        if any(v.finished for v in self.vehicles):
            return
        if all(v.speed < WAITING_SPEED for v in self.vehicles):
            self.deadlock_steps += 1

    def _termination(self) -> tuple[bool, bool, dict[str, Any]]:
        all_finished = all(v.finished for v in self.agents)
        if all_finished:
            self._terminated = True
            self._terminated_reason = "success"
        truncated = self.step_count >= self.max_steps and not self._terminated
        info = {
            "reason": self._terminated_reason,
            "collisions": self.total_collisions,
            "conflicts": self.total_conflicts,
            "delay": sum(v.delay for v in self.vehicles),
            "finished": sum(1 for v in self.agents if v.finished),
            "deadlock_steps": self.deadlock_steps,
        }
        return self._terminated, truncated, info

    # ---- reward ---------------------------------------------------------

    def _rewards(self) -> list[float]:
        """Each agent's reward: its own delay plus the delay it caused.

        The wait is counted twice across the team — once for the vehicle
        that waited, once for the one that blocked it. That is the point:
        a blocker pays for the traffic it holds up, so "keep going" is no
        longer free.
        """
        rewards = []
        for agent in self.agents:
            reward = -(agent.delay_increment + agent.caused_delay_increment)
            reward -= self.conflict_penalty * agent.conflicts_increment
            reward -= COLLISION_PENALTY * agent.collisions_increment
            if self.progress_reward:
                # The standstill-equilibrium fix (see PROGRESS_REWARD):
                # driving earns what waiting costs, and getting through
                # stops the bleed for good.
                reward += PROGRESS_REWARD * agent.progress_gain
                reward += FINISH_BONUS * agent.finished_increment
            rewards.append(reward)
        return rewards

    # ---- observation ----------------------------------------------------

    def observations(self) -> list[np.ndarray]:
        """One observation per agent — ego-centric, permutation-stable."""
        return [self._observation(agent) for agent in self.agents]

    def _conflict_point_for(self, vehicle: DriveVehicle) -> tuple[float, float]:
        """The junction this vehicle's observation is built around."""
        if vehicle.next_junction is not None:
            return vehicle.next_junction
        return self.conflict_point

    def _observation(self, agent: DriveVehicle) -> np.ndarray:
        obs = np.zeros(OBS_DIM_DRIVE, dtype=np.float32)
        conflict_x, conflict_z = self._conflict_point_for(agent)

        own_distance = math.hypot(agent.x - conflict_x, agent.z - conflict_z)
        own_speed = max(agent.speed, 0.5)
        own_arrival = own_distance / own_speed

        obs[0] = agent.speed / SPEED_LIMIT_DRIVE
        obs[1] = min(own_distance / 100.0, 1.0)
        obs[2] = max(-1.0, min(1.0, own_arrival / 20.0))
        obs[3] = self._bearing(agent, conflict_x, conflict_z) / math.pi
        obs[4] = agent.route_progress

        others = self._others_ranked(agent)
        earlier = 0
        earliest_delta = 0.0
        for other in others:
            other_arrival = self._arrival_time(other)
            delta = other_arrival - own_arrival
            if delta < 0:
                earlier += 1
                earliest_delta = min(earliest_delta, delta)
        obs[5] = 1.0 if own_distance <= ARRIVAL_TOLERANCE else 0.0
        obs[6] = earlier / max(1, len(others))
        obs[7] = max(-1.0, min(1.0, earliest_delta / 10.0))

        for slot, other in enumerate(others[:NEAREST_OTHERS]):
            base = 8 + slot * 7
            # The offset from the conflict point, expressed in the ego's
            # frame: "which side of me is that car coming from".
            dx = other.x - conflict_x
            dz = other.z - conflict_z
            cos_h = math.cos(-agent.heading)
            sin_h = math.sin(-agent.heading)
            other_distance = math.hypot(other.x - conflict_x, other.z - conflict_z)
            obs[base] = 1.0
            obs[base + 1] = (dx * cos_h - dz * sin_h) / 50.0
            obs[base + 2] = (dx * sin_h + dz * cos_h) / 50.0
            obs[base + 3] = other.speed / SPEED_LIMIT_DRIVE
            obs[base + 4] = max(-1.0, min(1.0, (self._arrival_time(other) - own_arrival) / 10.0))
            # The negotiation state the arrival delta cannot carry:
            # COMMITTED (inside the box — it will not yield, do not
            # fight it) and YIELDING (stopped outside the box — the way
            # is mine, go).
            obs[base + 5] = 1.0 if other_distance <= CONFLICT_RADIUS else 0.0
            obs[base + 6] = (
                1.0 if other.speed < WAITING_SPEED and other_distance > CONFLICT_RADIUS else 0.0
            )

        return obs

    def _arrival_time(self, vehicle: DriveVehicle) -> float:
        """How long until this vehicle reaches ITS conflict point.

        On the single-junction scenario every vehicle shares the point;
        on a network each vehicle measures its own next junction — which
        is what makes the arrival-order readout meaningful across the
        grid.
        """
        cx, cz = self._conflict_point_for(vehicle)
        distance = math.hypot(vehicle.x - cx, vehicle.z - cz)
        return distance / max(vehicle.speed, 0.5)

    def _others_ranked(self, agent: DriveVehicle) -> list[DriveVehicle]:
        """The other vehicles, nearest first (a stable order)."""
        others = [v for v in self.vehicles if v is not agent and not v.finished]
        others.sort(key=lambda v: math.hypot(v.x - agent.x, v.z - agent.z))
        return others

    def _bearing(self, vehicle: DriveVehicle, x: float, z: float) -> float:
        """The bearing of a world point, relative to the vehicle's heading."""
        angle = math.atan2(z - vehicle.z, x - vehicle.x) - vehicle.heading
        return (angle + math.pi) % (2 * math.pi) - math.pi

    # ---- metrics --------------------------------------------------------

    def metrics(self) -> dict[str, Any]:
        """The numbers the report is made of."""
        return {
            "collisions": self.total_collisions,
            "conflicts": self.total_conflicts,
            "delay": sum(v.delay for v in self.vehicles),
            "agent_delay": sum(v.delay for v in self.agents),
            "caused_delay": sum(v.caused_delay for v in self.agents),
            "finished": sum(1 for v in self.agents if v.finished),
            "agents": self.n_agents,
            "deadlock_steps": self.deadlock_steps,
            "steps": self.step_count,
            "travel_time": sum(v.finished_at for v in self.agents),
        }
