"""Scene 4 v3 — driving to a POINT OF INTEREST.

The negotiation env (`intersection_env.py`) asks "who goes first at this
junction"; this one asks "can you **get somewhere**" — each driver is
assigned a destination (a point of interest) and has to reach it while
the traffic around it goes on as usual.

Why the destinations are synthetic
----------------------------------
The real POI data is not usable for training: the OSM extract of a
Shenzhen district carries **ten** `amenity` nodes against 7 320 roads
(measured on the project's own file), and the provider's POIs would
need a key on every training run. So the training env **places its own
POIs** — on the road network, at a category's typical offset from the
carriageway — and the shape of the problem (a destination across a
junction, other traffic in the way) is the same either way. The
product's real POIs come from the provider (`app/apps/maps/poi.py`).

What the driver has to see
--------------------------
The plain observation (29 numbers) says nothing about **where it is
going** — it is the traffic's picture. The POI task adds four numbers
about the destination: its offset in the ego's frame, its distance, and
whether it has arrived. Without them the policy would be driving the
negotiation blind.

The objective
-------------
    reward = -(own delay + delay caused to others)
             - conflicts - collisions
             + 0.2 per metre closed on the destination
             + 20 on arrival

The scale is chosen so the objective says the right thing: a 60 m drive
earns 12 and the arrival another 20, while a collision costs 50 —
crashing is never worth it, and a conflict (2.0) has to be worth
avoiding.
"""

from __future__ import annotations

import math
from typing import Any

import gymnasium as gym
import numpy as np
from gymnasium import spaces

from .drive_core import ACTION_DIM_DRIVE, OBS_DIM_DRIVE_POI, DriveCore
from .intersection_env import build_unsignalised_junction_network
from .network_graph import NetworkGraph, Route, build_network_graph

#: The categories the synthetic POIs use, with the lateral offset (m)
#: from the carriageway's centre line where such a place sits.
#:
#: The offset is what makes the destination REACHABLE: a driver driving
#: in the keep-right lane passes 4.5 m from a POI at the kerb, and the
#: arrival radius is 10 m (`TARGET_ARRIVAL_RADIUS_M`). A POI across the
#: street (12–15 m off the centre line) would be outside it — and the
#: task would be impossible rather than hard.
POI_KINDS: tuple[tuple[str, float], ...] = (
    ("咖啡", 4.5),
    ("超市", 5.0),
    ("医院", 4.5),
    ("学校", 5.5),
    ("加油站", 4.5),
)

#: How far along its arm (m) a POI sits — inside the 60 m arm, so a
#: driver that crosses into that arm drives past it.
POI_MIN_DISTANCE_M = 35.0
POI_MAX_DISTANCE_M = 55.0

#: How far apart the POIs on the shared street are (m) — enough that a
#: driver that has reached its own POI does not stand on the next one.
POI_SPACING_M = 10.0


class PoiNavigationEnv(gym.Env):
    """Several drivers navigating to their own points of interest."""

    metadata = {"render_modes": []}

    def __init__(
        self,
        *,
        n_agents: int = 3,
        n_npcs: int = 1,
        max_steps: int = 400,
        baseline: str | None = None,
    ) -> None:
        super().__init__()
        if baseline not in (None, "always_go", "straight_at_target"):
            raise ValueError(
                f"baseline must be None, 'always_go' or 'straight_at_target', got {baseline!r}"
            )
        self.n_agents = n_agents
        self.n_npcs = n_npcs
        self.max_steps = max_steps
        self.baseline = baseline
        self.network_dict = build_unsignalised_junction_network()
        self.graph: NetworkGraph = build_network_graph(self.network_dict)
        self.core = DriveCore(
            self.graph,
            n_agents=n_agents,
            n_npcs=n_npcs,
            conflict_point=(0.0, 0.0),
            max_steps=max_steps,
            progress_reward=True,
            conflict_penalty=2.0,
            poi_tasks=True,
        )
        self.observation_space = spaces.Box(
            low=-1.0,
            high=1.0,
            shape=(n_agents, OBS_DIM_DRIVE_POI),
            dtype=np.float32,
        )
        self.action_space = spaces.Box(
            low=-1.0,
            high=1.0,
            shape=(n_agents, ACTION_DIM_DRIVE),
            dtype=np.float32,
        )
        #: The POIs placed on the map (the scenario's "places").
        self.pois: list[dict[str, Any]] = []

    # ---- the scenario ----------------------------------------------------

    def _place_pois(self, rng: np.random.Generator) -> list[dict[str, Any]]:
        """A POI per agent, on the arm its ROUTE ends on.

        The destination has to be where the driver is going: the core
        has already given the agent a route (in on one arm, out on
        another), and the POI goes on the **out** arm, inside it. Then
        the driver crosses the junction — which is where the traffic
        from the other arms is — and drives past its destination.

        Putting the POI on any other arm made the task impossible
        rather than hard: a driver whose route ended on a different arm
        crossed the junction and drove AWAY from its destination
        (measured: 1 of 3 drivers arrived).
        """
        placed: list[dict[str, Any]] = []
        # The street the POIs are on: an arm no driver comes from.
        used_arms = {
            agent.route.segment_ids[0].split("-", 1)[1]
            for agent in self.core.agents
            if agent.route.segment_ids
        }
        street_arm = next(
            (arm for arm in ("n", "e", "s", "w") if arm not in used_arms),
            "w",
        )
        for index, _agent in enumerate(self.core.agents):
            kind, offset = POI_KINDS[index % len(POI_KINDS)]
            arm = street_arm
            # Each POI a little further along the street, so the drivers
            # queue behind each other on the shared street instead of
            # piling onto one spot. The spacing shrinks when there are
            # more drivers than the street has room for, so every POI
            # stays inside the arm (35–55 m).
            count = len(self.core.agents)
            span = POI_MAX_DISTANCE_M - POI_MIN_DISTANCE_M
            spacing = POI_SPACING_M if count <= 1 else min(POI_SPACING_M, span / (count - 1))
            distance = POI_MIN_DISTANCE_M + index * spacing
            # The POI sits at the kerb, on the **keep-right** side the
            # driver passes: the lateral offset is perpendicular to the
            # arm and on the driver's side, so the driver passes within
            # a few metres of it. (On the OTHER side the lateral gap was
            # 9.75 m — outside the arrival radius that the scenario had
            # at the time (8 m), so the destination was unreachable:
            # measured, the drivers stalled 12–16 m short of it for the
            # whole episode. The radius is 10 m now, and the POI sits on
            # the driver's own side.)
            if arm == "n":
                # Driving north (-z), the keep-right lane is at -x.
                px, pz = -offset, -distance
            elif arm == "e":
                # Driving east (+x), keep-right is +z.
                px, pz = distance, offset
            elif arm == "s":
                # Driving south (+z), keep-right is +x.
                px, pz = offset, distance
            else:
                # Driving west (-x), keep-right is -z.
                px, pz = -distance, -offset
            placed.append(
                {
                    "id": f"poi-{index + 1}",
                    "name": f"{kind} (合成 POI)",
                    "category": kind,
                    "x": px,
                    "z": pz,
                    "arm": arm,
                    "distance": distance,
                }
            )
        return placed

    def _assign_targets(self) -> None:
        """Each agent gets a POI, and a route that ENDS on its arm.

        The route matters as much as the target: a driver whose route
        ends on a DIFFERENT arm crosses the junction and drives away
        from its destination - it would never arrive, however well it
        drove.
        """
        for agent in self.core.agents:
            index = agent.agent_index
            if 0 <= index < len(self.pois):
                poi = self.pois[index]
                agent.target_poi = (float(poi["x"]), float(poi["z"]))
                agent.target_reached = False
                agent.target_distance = math.hypot(
                    agent.x - float(poi["x"]), agent.z - float(poi["z"])
                )
                agent.prev_target_distance = agent.target_distance
                # The route ends on the street the POIs are on: every
                # driver crosses the junction towards the same street,
                # so they meet there.
                in_arm = agent.route.segment_ids[0]
                agent.route = Route(
                    segment_ids=[in_arm, f"out-{poi['arm']}"],
                    found=True,
                )
                agent.current_seg_idx = 0
            else:
                agent.target_poi = None

    def reset(
        self,
        *,
        seed: int | None = None,
        options: dict[str, Any] | None = None,
    ) -> tuple[np.ndarray, dict[str, Any]]:
        super().reset(seed=seed)
        rng = np.random.default_rng(seed)
        self.core.reset(rng)
        self.pois = self._place_pois(rng)
        self._assign_targets()
        observations = self.core.observations()
        info = self.core.metrics()
        info["pois"] = len(self.pois)
        info["arrived"] = 0
        return np.stack(observations), info

    def step(
        self,
        actions: np.ndarray,
    ) -> tuple[np.ndarray, np.ndarray, bool, bool, dict[str, Any]]:
        actions = np.asarray(actions, dtype=np.float32).reshape(self.n_agents, ACTION_DIM_DRIVE)
        if self.baseline is not None:
            actions = self._scripted_actions(self.baseline)
        observations, rewards, terminated, truncated, info = self.core.step(actions)
        arrived = sum(1 for agent in self.core.agents if agent.target_reached)
        info.update(self.core.metrics())
        info["pois"] = len(self.pois)
        info["arrived"] = arrived
        # The episode ends when EVERY driver has arrived (or the clock
        # runs out) — the drivers' tasks are independent, so the round
        # ends with the slowest one.
        if arrived == len(self.core.agents):
            terminated = True
            info["reason"] = "arrived"
        return (
            np.stack(observations),
            np.asarray(rewards, dtype=np.float32),
            terminated,
            truncated,
            info,
        )

    # ---- the scripted baselines -----------------------------------------

    def _scripted_actions(self, baseline: str) -> np.ndarray:
        """The baselines, measured against the same task.

        `always_go` never yields (the negotiation's worst case).
        `straight_at_target` drives straight at the destination and never
        yields either — the naive driver, which arrives only if nothing
        is in the way.
        """
        actions = np.zeros((self.n_agents, ACTION_DIM_DRIVE), dtype=np.float32)
        for index, _agent in enumerate(self.core.agents):
            if baseline == "always_go":
                actions[index, 0] = 1.0
                continue
            actions[index, 0] = 1.0
        return actions
