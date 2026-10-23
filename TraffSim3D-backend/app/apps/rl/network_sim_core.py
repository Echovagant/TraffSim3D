"""Network-aware simulation core for arbitrary road networks.

Runs a simulation on whatever road network the frontend sends, instead of the
fixed `cross` / `corridor` scenes that `sim_core.py` hardcodes. Same bicycle
kinematic model and Pure Pursuit steering, but vehicles follow route waypoints
on the actual road graph.

This is a **second, independent core** — not a replacement and not a fork
======================================================================
`sim_core.py` and this module are two different things and must not be mixed:

    sim_core.py             14-dim observation, fixed scenes (cross/corridor),
                            byte-compared against the TypeScript mirror by the
                            cross-language contract tests (tests/contract/).
                            It is the contract authority — never edit it.

    network_sim_core.py     24-dim observation, arbitrary user road network,
                            no contract goldens, no shared state with the above.

The constants below (`DT`, `NPC_SPEED`, `MAX_STEPS`, ...) deliberately shadow
the same-named constants in `sim_core.py` with **different values where it
matters**; they are two separate namespaces, not one shared config. This
module must never import `sim_core` — doing so would couple the 24-dim core
to the 14-dim contract surface and make the contract goldens depend on
user-authored networks. `tests/test_rl_network_sim_core.py` guards that.

Observation: 24-dim vector covering ego state, lead vehicle, traffic
light, route info, and neighbor distances.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .idm import find_lead_vehicle, idm_acceleration
from .network_graph import (
    NetworkGraph,
    RoadSegment,
    Route,
    find_route,
    point_on_road,
)

OBS_DIM_NETWORK = 24
SPEED_LIMIT_DEFAULT = 16.67
NPC_SPEED = 8.0
EGO_WHEELBASE = 2.5
COLLISION_DISTANCE = 2.5
LOOKAHEAD_DISTANCE = 10.0
MAX_STEER = 0.4
DT = 0.1
MAX_STEPS = 300
NUM_NPCS = 4
TRAFFIC_LIGHT_CYCLE = 30.0


@dataclass
class _Vehicle:
    x: float = 0.0
    z: float = 0.0
    heading: float = 0.0
    speed: float = 0.0
    route: Route = field(default_factory=lambda: Route(segment_ids=[]))
    route_progress: float = 0.0
    current_seg_idx: int = 0
    seg_t: float = 0.0


@dataclass
class _TrafficLightState:
    green: bool = True
    timer: float = 0.0
    cycle: float = TRAFFIC_LIGHT_CYCLE


class NetworkSimCore:
    """Sim core that runs on any NetworkGraph from the frontend."""

    obs_dim: int = OBS_DIM_NETWORK

    def __init__(self, graph: NetworkGraph, max_steps: int = MAX_STEPS) -> None:
        self.graph = graph
        self.max_steps = max_steps
        self.ego = _Vehicle()
        self.npcs: list[_Vehicle] = []
        self.light_states: dict[str, _TrafficLightState] = {}
        self.step_count = 0
        self.sim_time = 0.0
        self._terminated = False
        self._terminated_reason = ""
        self._prev_ego_progress = 0.0

        for node_id, node in graph.nodes.items():
            if node.has_traffic_light:
                self.light_states[node_id] = _TrafficLightState(
                    green=True,
                    timer=0.0,
                    cycle=TRAFFIC_LIGHT_CYCLE,
                )

    def reset(self, seed: int | None = None) -> np.ndarray:
        rng = np.random.default_rng(seed)
        self.step_count = 0
        self.sim_time = 0.0
        self._terminated = False
        self._terminated_reason = ""

        seg_ids = list(self.graph.segments.keys())
        if not seg_ids:
            self._terminated = True
            self._terminated_reason = "no_roads"
            return np.zeros(OBS_DIM_NETWORK, dtype=np.float32)

        ego_seg_id = seg_ids[rng.integers(0, len(seg_ids))]
        ego_seg = self.graph.segments[ego_seg_id]
        ego_t = ego_seg.length * 0.2
        ego_pos = point_on_road(ego_seg, ego_t)
        ego_heading = _segment_heading(ego_seg, ego_t)

        target_seg_id = seg_ids[rng.integers(0, len(seg_ids))]
        route = find_route(self.graph, ego_seg_id, target_seg_id)

        self.ego = _Vehicle(
            x=ego_pos[0],
            z=ego_pos[1],
            heading=ego_heading,
            speed=0.0,
            route=route,
            route_progress=0.0,
            current_seg_idx=0,
            seg_t=ego_t,
        )
        self._prev_ego_progress = 0.0

        self.npcs = []
        for _ in range(NUM_NPCS):
            npc_seg_id = seg_ids[rng.integers(0, len(seg_ids))]
            npc_seg = self.graph.segments[npc_seg_id]
            npc_t = npc_seg.length * rng.uniform(0.1, 0.9)
            npc_pos = point_on_road(npc_seg, npc_t)
            npc_heading = _segment_heading(npc_seg, npc_t)
            npc_target = seg_ids[rng.integers(0, len(seg_ids))]
            npc_route = find_route(self.graph, npc_seg_id, npc_target)
            self.npcs.append(
                _Vehicle(
                    x=npc_pos[0],
                    z=npc_pos[1],
                    heading=npc_heading,
                    speed=NPC_SPEED,
                    route=npc_route,
                    route_progress=0.0,
                    current_seg_idx=0,
                    seg_t=npc_t,
                )
            )

        for ls in self.light_states.values():
            ls.green = True
            ls.timer = 0.0

        return self._obs()

    def step(self, action: np.ndarray) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        if self._terminated:
            return self._obs(), 0.0, True, False, {"reason": self._terminated_reason}

        accel_cmd = float(np.clip(action[0], -1.0, 1.0)) * 3.0

        target_pt = self._get_pure_pursuit_target(self.ego)
        dx = target_pt[0] - self.ego.x
        dz = target_pt[1] - self.ego.z
        target_angle = math.atan2(dz, dx)
        alpha = self.ego.heading - target_angle
        alpha = (alpha + math.pi) % (2 * math.pi) - math.pi
        steer = math.atan2(2.0 * EGO_WHEELBASE * math.sin(alpha), LOOKAHEAD_DISTANCE)
        steer = float(np.clip(steer, -MAX_STEER, MAX_STEER))

        speed_limit = self._current_speed_limit(self.ego)
        self.ego.speed = max(0.0, min(speed_limit, self.ego.speed + accel_cmd * DT))
        self.ego.heading += steer * DT
        self.ego.x += self.ego.speed * math.cos(self.ego.heading) * DT
        self.ego.z += self.ego.speed * math.sin(self.ego.heading) * DT

        self._advance_route_progress(self.ego)

        all_vehicles = [self.ego] + self.npcs
        for i, npc in enumerate(self.npcs):
            # Pure Pursuit steering (unchanged)
            npc_target_pt = self._get_pure_pursuit_target(npc)
            ndx = npc_target_pt[0] - npc.x
            ndz = npc_target_pt[1] - npc.z
            npc_target_angle = math.atan2(ndz, ndx)
            npc_alpha = npc.heading - npc_target_angle
            npc_alpha = (npc_alpha + math.pi) % (2 * math.pi) - math.pi
            npc_steer = math.atan2(2.0 * EGO_WHEELBASE * math.sin(npc_alpha), LOOKAHEAD_DISTANCE)
            npc_steer = float(np.clip(npc_steer, -MAX_STEER, MAX_STEER))

            # IDM car-following for speed control
            candidates = [v for j, v in enumerate(all_vehicles) if j != i + 1]
            lead = find_lead_vehicle(npc.x, npc.z, npc.heading, npc.speed, candidates)
            npc_accel = idm_acceleration(npc.speed, lead, desired_speed=NPC_SPEED)
            npc.speed = max(0.0, min(SPEED_LIMIT_DEFAULT, npc.speed + npc_accel * DT))

            npc.heading += npc_steer * DT
            npc.x += npc.speed * math.cos(npc.heading) * DT
            npc.z += npc.speed * math.sin(npc.heading) * DT
            self._advance_route_progress(npc)

        for ls in self.light_states.values():
            ls.timer += DT
            if ls.timer >= ls.cycle:
                ls.timer = 0.0
                ls.green = not ls.green

        self.sim_time += DT
        self.step_count += 1

        reward = 0.05
        progress = self.ego.route_progress - self._prev_ego_progress
        self._prev_ego_progress = self.ego.route_progress
        reward += 2.0 * max(0.0, progress)

        for npc in self.npcs:
            d = math.hypot(self.ego.x - npc.x, self.ego.z - npc.z)
            if d < COLLISION_DISTANCE:
                self._terminated = True
                self._terminated_reason = "collision"
                reward -= 10.0
                break

        if not self._terminated and self._check_red_light():
            self._terminated = True
            self._terminated_reason = "red_light"
            reward -= 5.0

        if not self._terminated and self.ego.route_progress > 0.9:
            self._terminated = True
            self._terminated_reason = "success"
            reward += 10.0

        truncated = False
        if self.step_count >= self.max_steps and not self._terminated:
            truncated = True

        info = {"reason": self._terminated_reason, "progress": progress}
        return self._obs(), float(reward), self._terminated, truncated, info

    def _obs(self) -> np.ndarray:
        obs = np.zeros(OBS_DIM_NETWORK, dtype=np.float32)
        max_dist = 100.0

        obs[0] = np.clip(self.ego.x / max_dist, -1.0, 1.0)
        obs[1] = np.clip(self.ego.z / max_dist, -1.0, 1.0)
        obs[2] = self.ego.heading / math.pi
        obs[3] = self.ego.speed / SPEED_LIMIT_DEFAULT
        obs[4] = 0.0

        lead_dist, lead_speed, lead_angle = self._nearest_lead_vehicle()
        obs[5] = min(lead_dist / max_dist, 1.0)
        obs[6] = lead_speed / SPEED_LIMIT_DEFAULT
        obs[7] = lead_angle / math.pi
        obs[8] = 0.0
        obs[9] = 0.0

        light_dist, light_phase, light_remaining, has_light, congestion = (
            self._next_traffic_light_info()
        )
        obs[10] = min(light_dist / max_dist, 1.0)
        obs[11] = light_phase
        obs[12] = light_remaining
        obs[13] = 1.0 if has_light else 0.0
        obs[14] = congestion

        route_dir, route_dist, route_lanes, route_limit, route_curve = self._route_info()
        obs[15] = route_dir
        obs[16] = min(route_dist / max_dist, 1.0)
        obs[17] = route_lanes / 6.0
        obs[18] = route_limit / SPEED_LIMIT_DEFAULT
        obs[19] = route_curve

        for i, direction in enumerate([(1, 0), (-1, 0), (0.7, 0.7), (-0.7, 0.7)]):
            obs[20 + i] = min(self._neighbor_distance(direction) / max_dist, 1.0)

        return obs

    def _get_pure_pursuit_target(self, v: _Vehicle) -> tuple[float, float]:
        if not v.route.segment_ids:
            return (
                v.x + math.cos(v.heading) * LOOKAHEAD_DISTANCE,
                v.z + math.sin(v.heading) * LOOKAHEAD_DISTANCE,
            )

        idx = min(v.current_seg_idx, len(v.route.segment_ids) - 1)
        seg_id = v.route.segment_ids[idx]
        if seg_id not in self.graph.segments:
            return (
                v.x + math.cos(v.heading) * LOOKAHEAD_DISTANCE,
                v.z + math.sin(v.heading) * LOOKAHEAD_DISTANCE,
            )

        seg = self.graph.segments[seg_id]
        target_t = v.seg_t + LOOKAHEAD_DISTANCE
        if target_t > seg.length and idx < len(v.route.segment_ids) - 1:
            next_seg_id = v.route.segment_ids[idx + 1]
            if next_seg_id in self.graph.segments:
                return point_on_road(self.graph.segments[next_seg_id], LOOKAHEAD_DISTANCE * 0.5)

        return point_on_road(seg, min(target_t, seg.length))

    def _advance_route_progress(self, v: _Vehicle) -> None:
        if not v.route.segment_ids:
            return

        idx = min(v.current_seg_idx, len(v.route.segment_ids) - 1)
        seg_id = v.route.segment_ids[idx]
        if seg_id not in self.graph.segments:
            return

        seg = self.graph.segments[seg_id]
        v.seg_t = _project_on_segment(seg, (v.x, v.z))

        total_length = sum(
            self.graph.segments[sid].length
            for sid in v.route.segment_ids
            if sid in self.graph.segments
        )
        if total_length < 1e-6:
            return

        progress = 0.0
        for i, sid in enumerate(v.route.segment_ids):
            if sid not in self.graph.segments:
                continue
            if i < idx:
                progress += self.graph.segments[sid].length
            elif i == idx:
                progress += v.seg_t
                break
        v.route_progress = progress / total_length

        if v.seg_t >= seg.length * 0.95 and idx < len(v.route.segment_ids) - 1:
            v.current_seg_idx = idx + 1
            v.seg_t = 0.0

    def _nearest_lead_vehicle(self) -> tuple[float, float, float]:
        best_dist = 50.0
        best_speed = 0.0
        best_angle = 0.0

        for npc in self.npcs:
            dx = npc.x - self.ego.x
            dz = npc.z - self.ego.z
            dist = math.hypot(dx, dz)
            if dist > best_dist:
                continue
            angle_to_npc = math.atan2(dz, dx)
            rel_angle = angle_to_npc - self.ego.heading
            rel_angle = (rel_angle + math.pi) % (2 * math.pi) - math.pi
            if abs(rel_angle) > math.pi / 3:
                continue
            best_dist = dist
            best_speed = npc.speed
            best_angle = rel_angle

        return best_dist, best_speed, best_angle

    def _next_traffic_light_info(self) -> tuple[float, float, float, bool, float]:
        if not self.light_states:
            return (50.0, 0.0, 0.0, False, 0.0)

        best_dist = 100.0
        best_phase = 0.0
        best_remaining = 0.0
        has_light = False
        congestion = 0.0

        for node_id, ls in self.light_states.items():
            if node_id not in self.graph.nodes:
                continue
            node = self.graph.nodes[node_id]
            dist = math.hypot(node.position[0] - self.ego.x, node.position[1] - self.ego.z)
            if dist < best_dist:
                best_dist = dist
                best_phase = 1.0 if ls.green else 0.0
                best_remaining = (ls.cycle - ls.timer) / ls.cycle
                has_light = True

                nearby = sum(
                    1
                    for npc in self.npcs
                    if math.hypot(npc.x - node.position[0], npc.z - node.position[1])
                    < node.radius * 2
                )
                congestion = min(nearby / 4.0, 1.0)

        return best_dist, best_phase, best_remaining, has_light, congestion

    def _route_info(self) -> tuple[float, float, float, float, float]:
        if not self.ego.route.segment_ids:
            return (0.0, 0.0, 2.0, SPEED_LIMIT_DEFAULT, 0.0)

        idx = min(self.ego.current_seg_idx, len(self.ego.route.segment_ids) - 1)
        seg_id = self.ego.route.segment_ids[idx]
        if seg_id not in self.graph.segments:
            return (0.0, 0.0, 2.0, SPEED_LIMIT_DEFAULT, 0.0)

        seg = self.graph.segments[seg_id]
        heading = _segment_heading(seg, self.ego.seg_t)
        direction = (heading - self.ego.heading + math.pi) % (2 * math.pi) - math.pi

        remaining = sum(
            self.graph.segments[sid].length
            for sid in self.ego.route.segment_ids[idx:]
            if sid in self.graph.segments
        )

        curve = 0.0
        if len(seg.points) >= 3:
            t = self.ego.seg_t
            accumulated = 0.0
            for i in range(len(seg.points) - 1):
                dx = seg.points[i + 1][0] - seg.points[i][0]
                dz = seg.points[i + 1][1] - seg.points[i][1]
                sl = math.hypot(dx, dz)
                if accumulated + sl >= t:
                    if i > 0 and i < len(seg.points) - 2:
                        dx1 = seg.points[i][0] - seg.points[i - 1][0]
                        dz1 = seg.points[i][1] - seg.points[i - 1][1]
                        dx2 = seg.points[i + 1][0] - seg.points[i][0]
                        dz2 = seg.points[i + 1][1] - seg.points[i][1]
                        cross = dx1 * dz2 - dz1 * dx2
                        curve = np.clip(cross / (sl * math.hypot(dx1, dz1) + 1e-6), -1.0, 1.0)
                    break
                accumulated += sl

        return (
            float(np.clip(direction / math.pi, -1.0, 1.0)),
            remaining,
            float(seg.lane_count),
            seg.speed_limit,
            float(curve),
        )

    def _neighbor_distance(self, direction: tuple[float, float]) -> float:
        best = 50.0
        for npc in self.npcs:
            dx = npc.x - self.ego.x
            dz = npc.z - self.ego.z
            dot = dx * direction[0] + dz * direction[1]
            if dot <= 0:
                continue
            perp = abs(-dx * direction[1] + dz * direction[0])
            if perp > 5.0:
                continue
            dist = math.hypot(dx, dz)
            if dist < best:
                best = dist
        return best

    def _check_red_light(self) -> bool:
        for node_id, ls in self.light_states.items():
            if node_id not in self.graph.nodes:
                continue
            node = self.graph.nodes[node_id]
            dist = math.hypot(node.position[0] - self.ego.x, node.position[1] - self.ego.z)
            if dist > node.radius:
                continue
            if not ls.green:
                return True
        return False

    def _current_speed_limit(self, v: _Vehicle) -> float:
        if not v.route.segment_ids:
            return SPEED_LIMIT_DEFAULT
        idx = min(v.current_seg_idx, len(v.route.segment_ids) - 1)
        seg_id = v.route.segment_ids[idx]
        if seg_id in self.graph.segments:
            return self.graph.segments[seg_id].speed_limit
        return SPEED_LIMIT_DEFAULT


def _segment_heading(seg: RoadSegment, t: float) -> float:
    t = max(0.0, min(seg.length, t))
    accumulated = 0.0
    for i in range(len(seg.points) - 1):
        dx = seg.points[i + 1][0] - seg.points[i][0]
        dz = seg.points[i + 1][1] - seg.points[i][1]
        sl = math.hypot(dx, dz)
        if accumulated + sl >= t or i == len(seg.points) - 2:
            return math.atan2(dz, dx)
        accumulated += sl
    dx = seg.points[-1][0] - seg.points[-2][0]
    dz = seg.points[-1][1] - seg.points[-2][1]
    return math.atan2(dz, dx)


def _project_on_segment(seg: RoadSegment, pt: tuple[float, float]) -> float:
    best_t = 0.0
    best_dist = float("inf")
    accumulated = 0.0
    for i in range(len(seg.points) - 1):
        ax, az = seg.points[i]
        bx, bz = seg.points[i + 1]
        dx, dz = bx - ax, bz - az
        sl = math.hypot(dx, dz)
        if sl < 1e-9:
            continue
        t_local = max(0.0, min(1.0, ((pt[0] - ax) * dx + (pt[1] - az) * dz) / (sl * sl)))
        proj_x = ax + dx * t_local
        proj_z = az + dz * t_local
        dist = math.hypot(pt[0] - proj_x, pt[1] - proj_z)
        if dist < best_dist:
            best_dist = dist
            best_t = accumulated + sl * t_local
        accumulated += sl
    return best_t
