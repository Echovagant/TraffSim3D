"""Scene 4 v2 — the unsignalised grid: multiple junctions, repeated negotiations.

The v1 scenario asked whether three drivers can sort out ONE junction.
This one asks whether the same behaviour holds when the drivers drive a
NETWORK: routes that cross several junctions, so the negotiations
repeat and the traffic persists.

The observation stays the same 23 numbers — each driver's conflict
point is the NEXT real intersection on its route
(`DriveCore._update_next_junction`), so a policy trained on the single
junction can be measured here unchanged. That is the point of the
scenario: it measures **generalisation**, not re-training.
"""

from __future__ import annotations

from typing import Any

import gymnasium as gym
import numpy as np
from gymnasium import spaces

from .drive_core import (
    ACTION_DIM_DRIVE,
    CONFLICT_RADIUS,
    OBS_DIM_DRIVE,
    DriveCore,
    DriveVehicle,
)
from .intersection_env import build_unsignalised_grid_network
from .network_graph import NetworkGraph, build_network_graph, find_route


class GridDriveEnv(gym.Env):
    """Several learned drivers negotiating a grid of unsignalised junctions."""

    metadata = {"render_modes": []}

    def __init__(
        self,
        *,
        n_agents: int = 6,
        n_npcs: int = 2,
        max_steps: int = 900,
        baseline: str | None = None,
        rows: int = 2,
        cols: int = 2,
    ) -> None:
        super().__init__()
        if baseline not in (None, "always_go", "right_of_way"):
            raise ValueError(
                f"baseline must be None, 'always_go' or 'right_of_way', got {baseline!r}"
            )
        self.n_agents = n_agents
        self.n_npcs = n_npcs
        self.max_steps = max_steps
        self.baseline = baseline
        self.network_dict = build_unsignalised_grid_network(rows, cols)
        self.graph: NetworkGraph = build_network_graph(self.network_dict)
        self.core = DriveCore(
            self.graph,
            n_agents=n_agents,
            n_npcs=n_npcs,
            conflict_point=(0.0, 0.0),
            max_steps=max_steps,
        )
        self.observation_space = spaces.Box(
            low=-1.0,
            high=1.0,
            shape=(n_agents, OBS_DIM_DRIVE),
            dtype=np.float32,
        )
        self.action_space = spaces.Box(
            low=-1.0,
            high=1.0,
            shape=(n_agents, ACTION_DIM_DRIVE),
            dtype=np.float32,
        )

    def _spawn_roads(self) -> list[tuple[str, str]]:
        """The (in-stub, out-stub) pairs the drivers can start from.

        Each in-stub is paired with the out-stub on the FAR side of the
        grid (index + half), so a route crosses the grid — through one
        to three junctions — instead of dribbling in and out of the same
        corner. The pairing is fixed, so the scenarios stay comparable
        across seeds.
        """
        stubs_in = sorted(rid for rid in self.graph.segments if rid.startswith("stub-in-"))
        stubs_out = sorted(rid for rid in self.graph.segments if rid.startswith("stub-out-"))
        half = max(1, len(stubs_in) // 2)
        return [
            (in_road, stubs_out[(index + half) % len(stubs_out)])
            for index, in_road in enumerate(stubs_in)
        ]

    def reset(
        self,
        *,
        seed: int | None = None,
        options: dict[str, Any] | None = None,
    ) -> tuple[np.ndarray, dict[str, Any]]:
        super().reset(seed=seed)
        rng = np.random.default_rng(seed)

        # Reset the core's bookkeeping, then place the grid's own
        # vehicles — the core's reset spawns for the single-junction
        # scenario, which does not apply here.
        self.core.reset(rng)
        spawn_pairs = self._spawn_roads()
        if len(spawn_pairs) < 2:
            raise ValueError("the grid has no stubs to spawn from")

        self.core.agents = []
        self.core.npcs = []
        for index in range(self.n_agents + self.n_npcs):
            in_road, out_road = spawn_pairs[index % len(spawn_pairs)]
            route = find_route(self.graph, in_road, out_road)
            segment = self.graph.segments[in_road]
            fraction = float(rng.uniform(0.3, 0.7))
            distance = segment.length * fraction
            heading = self.core._segment_heading(segment, distance)
            x, z = self.core._lane_point(segment, distance, heading)
            vehicle = DriveVehicle(
                x=x,
                z=z,
                heading=heading,
                speed=0.0,
                route=route,
                current_seg_idx=0,
                seg_t=distance,
                is_agent=index < self.n_agents,
                agent_index=index if index < self.n_agents else -1,
                id=f"v-{index + 1}",
            )
            if index < self.n_agents:
                self.core.agents.append(vehicle)
            else:
                self.core.npcs.append(vehicle)
        self.core.vehicles = [*self.core.agents, *self.core.npcs]
        for vehicle in self.core.vehicles:
            self.core._update_next_junction(vehicle)

        observations = self.core.observations()
        info = self.core.metrics()
        info["baseline"] = self.baseline
        return np.stack(observations), info

    def step(
        self,
        actions: np.ndarray,
    ) -> tuple[np.ndarray, np.ndarray, bool, bool, dict[str, Any]]:
        actions = np.asarray(actions, dtype=np.float32).reshape(self.n_agents, ACTION_DIM_DRIVE)
        if self.baseline is not None:
            actions = self._scripted_actions(self.baseline)
        observations, rewards, terminated, truncated, info = self.core.step(actions)
        metrics = self.core.metrics()
        info.update(metrics)
        info["baseline"] = self.baseline
        return (
            np.stack(observations),
            np.asarray(rewards, dtype=np.float32),
            terminated,
            truncated,
            info,
        )

    def _scripted_actions(self, baseline: str) -> np.ndarray:
        """The scripted baselines, generalised to the grid.

        `always_go` never yields. `right_of_way` applies the classical
        rule per junction — first come, first served, the driver on the
        right winning a tie — measured against each driver's OWN next
        junction, and only while it can still stop outside the box.
        """
        actions = np.zeros((self.n_agents, ACTION_DIM_DRIVE), dtype=np.float32)
        for index, agent in enumerate(self.core.agents):
            if baseline == "always_go":
                actions[index, 0] = 1.0
                continue
            actions[index, 0] = self._right_of_way_accel(agent)
        return actions

    def _right_of_way_accel(self, agent: DriveVehicle) -> float:
        conflict_x, conflict_z = self.core._conflict_point_for(agent)
        own_distance = float(np.hypot(agent.x - conflict_x, agent.z - conflict_z))

        # The vehicles whose next junction is the SAME one — those are
        # the paths that can cross mine.
        conflicting = [
            other
            for other in self.core.vehicles
            if other is not agent
            and not other.finished
            and self.core._conflict_point_for(other) == (conflict_x, conflict_z)
        ]
        if not conflicting:
            return 1.0

        distances = [
            float(np.hypot(other.x - conflict_x, other.z - conflict_z)) for other in conflicting
        ]
        earliest = min(distances)
        if earliest < own_distance - 0.5:
            return -1.0 if own_distance > CONFLICT_RADIUS else 1.0
        if earliest > own_distance + 0.5:
            return 1.0

        own_bearing = np.arctan2(agent.z - conflict_z, agent.x - conflict_x)
        for other, other_distance in zip(conflicting, distances, strict=True):
            if abs(other_distance - own_distance) > 0.5:
                continue
            other_bearing = np.arctan2(other.z - conflict_z, other.x - conflict_x)
            delta = (own_bearing - other_bearing) % (2 * np.pi)
            if delta < np.pi:
                return -1.0 if own_distance > CONFLICT_RADIUS else 1.0
        return 1.0
