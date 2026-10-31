"""The unsignalised-intersection environment — several drivers negotiating.

This is Scene 4's environment: **learned drivers meet at a junction that
has no traffic lights** and have to sort out who goes first.

Why this scenario
-----------------
The signal agent (Scene 3) commands lights. That only covers the
junctions that *have* lights — and in the real imported city they are
the exception: of Shenzhen's 7991 junctions, **51 carry a traffic
light**. The other 96 % are unsignalised, and there the right of way is
not given by a phase — it is negotiated, by behaviour, between drivers
who can only see their neighbourhood.

That is a genuinely cooperative problem: the outcome depends on what
the *other* drivers do, and no single driver can fix it alone.

The reward
----------
Each agent's reward is the negative of

    its own waiting time + the waiting time it caused to others

plus a collision penalty it shares with the other party. The second
term is what makes it cooperative: a driver that holds up the traffic
behind it pays for that traffic's waiting time. (The same accounting
the signal agent uses in reverse: there, the network's delay is the sum
of the junctions' delays and each junction is given its own term; here,
the wait is attributed to whoever caused it.)

The baselines
-------------
Two scripted policies are measured against the learned one, because
"the learned policy is better than nothing" is not a result:

* ``always_go`` — nobody yields. It shows what the cooperation is
  worth (and how many collisions that costs).
* ``right_of_way`` — the driver on the right has priority, the classic
  rule at an unsignalised junction.
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
    SPEED_LIMIT_DRIVE,
    DriveCore,
)
from .network_graph import NetworkGraph, build_network_graph

#: The four approaches of the junction, as (name, in-road, out-road).
#: The junction sits at the origin; every arm is 60 m long.
ARM_LENGTH_M = 60.0

#: How many approaches the junction has.
ARM_COUNT = 4

#: The environment's default agent count (how many drivers negotiate).
DEFAULT_N_AGENTS = 3

#: The scripted traffic that joins the negotiation.
DEFAULT_N_NPCS = 1


def build_unsignalised_junction_network(arm_length: float = ARM_LENGTH_M) -> dict[str, Any]:
    """A four-arm junction **without** traffic lights.

    The shape is the one the browser sends (`serializeNetwork`): roads
    with `waypoints` / `laneCount` / `speedLimit`, intersections with
    `connectedRoads` and **no** `trafficLights`.

    Every arm is an incoming road (ending at the junction) and an
    outgoing road (starting at it), so a driver comes in on one arm and
    leaves on another — the choice is part of the negotiation.
    """
    roads: list[dict[str, Any]] = []
    connected: list[str] = []
    # The four directions, in the order north / east / south / west.
    directions = [
        ("n", 0.0, 1.0),
        ("e", 1.0, 0.0),
        ("s", 0.0, -1.0),
        ("w", -1.0, 0.0),
    ]
    for name, dx, dz in directions:
        outer = {"x": dx * arm_length, "y": 0.0, "z": dz * arm_length}
        in_road = {
            "id": f"in-{name}",
            "startNode": outer,
            "endNode": {"x": 0.0, "y": 0.0, "z": 0.0},
            "waypoints": [outer, {"x": 0.0, "y": 0.0, "z": 0.0}],
            "laneCount": 2,
            "speedLimit": SPEED_LIMIT_DRIVE,
        }
        out_road = {
            "id": f"out-{name}",
            "startNode": {"x": 0.0, "y": 0.0, "z": 0.0},
            "endNode": outer,
            "waypoints": [{"x": 0.0, "y": 0.0, "z": 0.0}, outer],
            "laneCount": 2,
            "speedLimit": SPEED_LIMIT_DRIVE,
        }
        roads.append(in_road)
        roads.append(out_road)
        connected.extend([in_road["id"], out_road["id"]])

    return {
        "roads": roads,
        "intersections": [
            {
                "id": "j-0",
                "position": {"x": 0.0, "y": 0.0, "z": 0.0},
                "connectedRoads": connected,
                # **No traffic lights.** That is the whole point of the
                # scenario: the right of way has to be negotiated.
                "trafficLights": [],
                "intersectionRadius": 8.0,
            }
        ],
        "vehicles": [],
        "spawnPoints": [],
    }


class IntersectionEnv(gym.Env):
    """Several learned drivers negotiating an unsignalised junction."""

    metadata = {"render_modes": []}

    def __init__(
        self,
        *,
        n_agents: int = DEFAULT_N_AGENTS,
        n_npcs: int = DEFAULT_N_NPCS,
        max_steps: int = 400,
        baseline: str | None = None,
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
        self.network_dict = build_unsignalised_junction_network()
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

    # ---- gym API --------------------------------------------------------

    def reset(
        self,
        *,
        seed: int | None = None,
        options: dict[str, Any] | None = None,
    ) -> tuple[np.ndarray, dict[str, Any]]:
        super().reset(seed=seed)
        rng = np.random.default_rng(seed)
        self.core.reset(rng)
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

    # ---- the scripted baselines -----------------------------------------

    def _scripted_actions(self, baseline: str) -> np.ndarray:
        """The actions a scripted policy would take, as the same shape.

        The baselines are the yardstick: "the learned policy is better
        than nothing" is not a result, so both a do-nothing-yield
        baseline and the classical right-of-way rule are measured on the
        same scenarios.
        """
        actions = np.zeros((self.n_agents, ACTION_DIM_DRIVE), dtype=np.float32)
        for index, agent in enumerate(self.core.agents):
            if baseline == "always_go":
                actions[index, 0] = 1.0
                continue
            actions[index, 0] = self._right_of_way_accel(agent)
        return actions

    def _right_of_way_accel(self, agent: Any) -> float:
        """First-come-first-served, with the classical tie-break.

        The rule a driver would actually apply at an unsignalised
        junction:

        * **first come, first served** — a driver that is closer to the
          conflict point has priority;
        * **the driver on the right wins a tie** — the classical rule,
          and the only thing that breaks the symmetry when two cars
          arrive together.

        A driver that yields **brakes before the box** (while it is still
        outside it). Once it is inside, it keeps going: the model has no
        reverse gear, and a driver that stopped in the middle of the
        junction would block everybody — which is a real phenomenon
        ("blocking the box"), but here it would be an artefact of the
        model rather than of the policy.
        """
        conflict_x, conflict_z = self.core.conflict_point
        own_distance = float(np.hypot(agent.x - conflict_x, agent.z - conflict_z))
        own_arm = agent.route.segment_ids[0] if agent.route.segment_ids else ""

        # The vehicles whose path crosses mine: a different approach arm.
        conflicting = [
            other
            for other in self.core.vehicles
            if other is not agent
            and not other.finished
            and other.route.segment_ids
            and other.route.segment_ids[0] != own_arm
        ]
        if not conflicting:
            return 1.0

        distances = [
            float(np.hypot(other.x - conflict_x, other.z - conflict_z)) for other in conflicting
        ]
        earliest = min(distances)
        if earliest < own_distance - 0.5:
            # They get there first — I yield, but only while I can still
            # stop outside the box.
            return -1.0 if own_distance > CONFLICT_RADIUS else 1.0
        if earliest > own_distance + 0.5:
            return 1.0

        # A tie: the driver on my right has priority.
        own_bearing = np.arctan2(agent.z - conflict_z, agent.x - conflict_x)
        for other, other_distance in zip(conflicting, distances, strict=True):
            if abs(other_distance - own_distance) > 0.5:
                continue
            other_bearing = np.arctan2(other.z - conflict_z, other.x - conflict_x)
            delta = (own_bearing - other_bearing) % (2 * np.pi)
            if delta < np.pi:
                # It is on my right — it has priority, I yield.
                return -1.0 if own_distance > CONFLICT_RADIUS else 1.0
        return 1.0


def evaluate_baseline(
    baseline: str,
    *,
    seeds: tuple[int, ...] = (0, 1, 2),
    n_agents: int = DEFAULT_N_AGENTS,
    n_npcs: int = DEFAULT_N_NPCS,
    max_steps: int = 400,
) -> dict[str, Any]:
    """Measure a scripted baseline over a set of seeds.

    The same seeds the learned policy is evaluated on, so the two are
    comparable: the scenarios are identical, only the drivers differ.
    """
    env = IntersectionEnv(
        n_agents=n_agents,
        n_npcs=n_npcs,
        max_steps=max_steps,
        baseline=baseline,
    )
    collisions = 0
    conflicts = 0
    delay = 0.0
    deadlock_steps = 0
    finished = 0
    steps = 0
    returns = 0.0
    for seed in seeds:
        env.reset(seed=seed)
        episode_return = 0.0
        while True:
            _, reward, terminated, truncated, info = env.step(
                np.zeros((env.n_agents, 2), np.float32)
            )
            episode_return += float(np.sum(reward))
            steps += 1
            if terminated or truncated:
                collisions += int(info["collisions"])
                conflicts += int(info["conflicts"])
                delay += float(info["delay"])
                deadlock_steps += int(info["deadlock_steps"])
                finished += int(info["finished"])
                returns += episode_return
                break
    count = len(seeds)
    return {
        "baseline": baseline,
        "seeds": count,
        "agents": n_agents,
        "collisions": collisions,
        "conflicts": conflicts,
        "delay": round(delay / count, 2),
        "deadlock_steps": deadlock_steps / count,
        "finished": finished,
        "return": round(returns / count, 2),
        "steps": steps // count,
    }
