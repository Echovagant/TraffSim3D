"""Generate the cooperative-driving policy's **observation** fixture.

The forward pass already has its contract (``gen_drive_policy_fixture.py``:
the same weights and the same observation vector give the same action).
What it deliberately does NOT pin is where the browser's observation
vector **comes from** — and that is the harder half. The repository
already knows the failure mode (``signalPolicySource.ts`` idx 5, the
phase clock that ran 0.52..1.0 instead of 0..1): an observation whose
*normalisation* is wrong on one side only does not turn any test red,
because the cross-language contract compares the schema, not the
numbers.

This fixture pins the normalisation. It holds a set of **deterministic
scene states** (vehicle poses around the unsignalised junction, chosen
to span the situations the policy meets: the authored start layout, a
staggered approach, a vehicle already inside the box, an oncoming pair
sharing one arm) and, for each agent of each state, the 23-dim
observation `app.apps.rl.drive_core` computes for it. The frontend's
builder (`driveObservation.ts`) must reproduce every number.

Two implementations, one contract
---------------------------------
The committed vectors are computed **twice** on the Python side:

1. by `DriveCore._observation` itself — the code under test (float32
   numpy), and
2. by the pure-Python float64 reference below — the same arithmetic the
   TypeScript side runs.

The two must agree to within float32 noise (1e-6), and the **float64**
vectors are the ones committed: the browser computes in float64 too, so
the parity assertion can use the repository's measured libm noise floor
(``1e-9``, ADR-009) instead of a slack.

Regenerate (from ``TraffSim3D-backend``)::

    .\\.venv\\Scripts\\python.exe scripts\\gen_drive_observation_fixture.py
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.apps.rl.drive_core import (  # noqa: E402
    ARRIVAL_TOLERANCE,
    NEAREST_OTHERS,
    OBS_DIM_DRIVE,
    SPEED_LIMIT_DRIVE,
    DriveCore,
)
from app.apps.rl.intersection_env import build_unsignalised_junction_network  # noqa: E402
from app.apps.rl.network_graph import build_network_graph  # noqa: E402

FIXTURE_PATH = (
    REPO_ROOT
    / "TraffSim3D-frontend"
    / "src"
    / "infrastructure"
    / "rl"
    / "fixtures"
    / "drive-observation-fixture.json"
)

#: The scenarios the fixture pins. `overrides` maps vehicle index ->
#: (distance along its in-road, speed); the pose is computed with the
#: core's own lane geometry, so the states are exactly the ones the
#: model produces.
SCENARIOS: list[dict[str, Any]] = [
    {
        "name": "authored-junction-start",
        "n_agents": 3,
        "n_npcs": 1,
        # The browser scene's authored layout: three drivers staggered
        # along three different arms, the scripted car on the fourth.
        "overrides": {0: (27.0, 0.0), 1: (34.0, 0.0), 2: (41.0, 0.0), 3: (34.0, 0.0)},
    },
    {
        "name": "staggered-approach",
        "n_agents": 3,
        "n_npcs": 1,
        # Everyone rolling: the arrival-time deltas are what the
        # negotiation reads.
        "overrides": {0: (24.0, 8.0), 1: (34.0, 6.0), 2: (44.0, 4.0), 3: (30.0, 8.0)},
    },
    {
        "name": "one-inside-the-box",
        "n_agents": 3,
        "n_npcs": 0,
        # Agent 0 is inside the arrival tolerance (2 m): obs[5] fires.
        "overrides": {0: (1.0, 2.0), 1: (25.0, 6.0), 2: (40.0, 8.0)},
    },
    {
        "name": "oncoming-pair-one-arm",
        "n_agents": 2,
        "n_npcs": 1,
        # An approaching driver and a departing one share the north arm,
        # 10.5 m apart laterally: the keep-right offset is what keeps
        # them out of each other.
        "overrides": {0: (20.0, 8.0), 1: (25.0, 8.0), 2: (40.0, 8.0)},
    },
    {
        "name": "crossing-priority",
        "n_agents": 2,
        "n_npcs": 1,
        # The classic negotiation: a close fast driver and a far slow
        # one on crossing arms — who arrives first is the decision.
        "overrides": {0: (15.0, 10.0), 1: (30.0, 4.0), 2: (40.0, 8.0)},
    },
]

#: The road each vehicle index starts from, per scenario — the same
#: (in-road) assignment `_pick_approach` makes for 3 agents + 1 npc on
#: the four arms (sorted arms, round-robin). Scenarios with fewer
#: vehicles use the first entries.
ARMS = ["in-e", "in-n", "in-s", "in-w"]


def _build_states() -> list[dict[str, Any]]:
    """The deterministic scene states, posed by the core's own geometry."""
    graph = build_network_graph(build_unsignalised_junction_network())
    scenarios: list[dict[str, Any]] = []
    for spec in SCENARIOS:
        core = DriveCore(
            graph,
            n_agents=spec["n_agents"],
            n_npcs=spec["n_npcs"],
            conflict_point=(0.0, 0.0),
            max_steps=400,
        )
        core.reset(np.random.default_rng(0))
        vehicles: list[dict[str, Any]] = []
        for index, vehicle in enumerate(core.vehicles):
            road_id = ARMS[index % len(ARMS)]
            segment = graph.segments[road_id]
            distance, speed = spec["overrides"][index]
            heading = core._segment_heading(segment, distance)
            x, z = core._lane_point(segment, distance, heading)
            # The route progress the env's own formula produces:
            # (done + seg_t) / total, over the two-segment route.
            in_length = segment.length
            out_id = "out-" + road_id.split("-", 1)[1]
            total = in_length + graph.segments[out_id].length
            vehicle.x = x
            vehicle.z = z
            vehicle.heading = heading
            vehicle.speed = float(speed)
            vehicle.route_progress = min(1.0, distance / total)
            vehicles.append(
                {
                    "id": f"v-{index + 1}",
                    "isAgent": vehicle.is_agent,
                    "x": x,
                    "y": 0.0,
                    "z": z,
                    "heading": heading,
                    "speed": float(speed),
                    "routeProgress": vehicle.route_progress,
                }
            )
        scenarios.append(
            {
                "name": spec["name"],
                "conflictPoint": {"x": 0.0, "z": 0.0},
                "vehicles": vehicles,
                "agents": [v["id"] for v in vehicles if v["isAgent"]],
            }
        )
    return scenarios


def _observation_reference(
    conflict_point: tuple[float, float],
    agent: dict[str, Any],
    others: list[dict[str, Any]],
) -> list[float]:
    """The pure-Python **float64** reference of `DriveCore._observation`.

    The same arithmetic the TypeScript builder runs — which is why the
    committed vectors can be pinned at the libm noise floor rather than
    at a slack. Kept next to the core on purpose: if the two drift, the
    fixture generator is where it shows.
    """
    obs = [0.0] * OBS_DIM_DRIVE
    conflict_x, conflict_z = conflict_point

    own_distance = math.hypot(agent["x"] - conflict_x, agent["z"] - conflict_z)
    own_arrival = own_distance / max(agent["speed"], 0.5)

    obs[0] = agent["speed"] / SPEED_LIMIT_DRIVE
    obs[1] = min(own_distance / 100.0, 1.0)
    obs[2] = max(-1.0, min(1.0, own_arrival / 20.0))

    # The bearing **from the vehicle to the conflict point** — the same
    # direction `DriveCore._bearing` computes (atan2 of point - vehicle,
    # not vehicle - point). Getting the vector backwards here would flip
    # the sign of everything behind the car, and the two sides would
    # disagree by exactly pi.
    angle = math.atan2(conflict_z - agent["z"], conflict_x - agent["x"]) - agent["heading"]
    bearing = (angle + math.pi) % (2 * math.pi) - math.pi
    obs[3] = bearing / math.pi
    obs[4] = agent["routeProgress"]

    ranked = sorted(
        others,
        key=lambda other: math.hypot(other["x"] - agent["x"], other["z"] - agent["z"]),
    )

    def arrival(other: dict[str, Any]) -> float:
        distance = math.hypot(other["x"] - conflict_x, other["z"] - conflict_z)
        return distance / max(other["speed"], 0.5)

    earlier = 0
    earliest_delta = 0.0
    for other in ranked:
        delta = arrival(other) - own_arrival
        if delta < 0:
            earlier += 1
            earliest_delta = min(earliest_delta, delta)
    obs[5] = 1.0 if own_distance <= ARRIVAL_TOLERANCE else 0.0
    obs[6] = earlier / max(1, len(ranked))
    obs[7] = max(-1.0, min(1.0, earliest_delta / 10.0))

    cos_h = math.cos(-agent["heading"])
    sin_h = math.sin(-agent["heading"])
    for slot, other in enumerate(ranked[:NEAREST_OTHERS]):
        base = 8 + slot * 5
        dx = other["x"] - conflict_x
        dz = other["z"] - conflict_z
        obs[base] = 1.0
        obs[base + 1] = (dx * cos_h - dz * sin_h) / 50.0
        obs[base + 2] = (dx * sin_h + dz * cos_h) / 50.0
        obs[base + 3] = other["speed"] / SPEED_LIMIT_DRIVE
        obs[base + 4] = max(-1.0, min(1.0, (arrival(other) - own_arrival) / 10.0))
    return obs


def build_fixture() -> dict[str, Any]:
    """The fixture: the states, and each agent's expected observation."""
    graph = build_network_graph(build_unsignalised_junction_network())
    scenarios = _build_states()
    expected: list[dict[str, Any]] = []
    for scenario in scenarios:
        core = DriveCore(
            graph,
            n_agents=len(scenario["agents"]),
            n_npcs=len(scenario["vehicles"]) - len(scenario["agents"]),
            conflict_point=(0.0, 0.0),
            max_steps=400,
        )
        core.reset(np.random.default_rng(0))
        for vehicle, state in zip(core.vehicles, scenario["vehicles"], strict=True):
            vehicle.x = state["x"]
            vehicle.z = state["z"]
            vehicle.heading = state["heading"]
            vehicle.speed = state["speed"]
            vehicle.route_progress = state["routeProgress"]
        observations = core.observations()
        agent_states = [v for v in scenario["vehicles"] if v["isAgent"]]
        for state, observation in zip(agent_states, observations, strict=True):
            others = [v for v in scenario["vehicles"] if v["id"] != state["id"]]
            reference = _observation_reference(
                (scenario["conflictPoint"]["x"], scenario["conflictPoint"]["z"]),
                state,
                others,
            )
            # The core's own output (float32) and the float64 reference
            # must agree to within float32 noise — if they drift, the
            # fixture would pin whichever one the generator liked, and
            # the two implementations would be free to diverge.
            delta = max(abs(float(a) - b) for a, b in zip(observation, reference, strict=True))
            if delta > 1e-6:
                raise RuntimeError(
                    f"scenario {scenario['name']!r} agent {state['id']}: the core's "
                    f"observation and the float64 reference disagree by {delta:.3e}"
                )
            expected.append(
                {
                    "scenario": scenario["name"],
                    "agentId": state["id"],
                    "observation": reference,
                }
            )
    return {
        "_comment": (
            "The cooperative-driving policy's OBSERVATION contract. Each "
            "scenario is a deterministic scene state around the unsignalised "
            "junction; expected[] is the 23-dim observation "
            "app.apps.rl.drive_core computes for each agent, computed in "
            "float64 (the same arithmetic the browser runs) and cross-checked "
            "against the core's own float32 output. The frontend's "
            "driveObservation.ts must reproduce every number — the fixture "
            "exists because an observation whose normalisation is wrong on "
            "one side only does not turn the schema-level contract red. "
            "Generated by the backend; asserted by "
            "driveObservationParity.spec.ts."
        ),
        "regenerate": (
            "cd TraffSim3D-backend && .\\.venv\\Scripts\\python.exe "
            "scripts\\gen_drive_observation_fixture.py"
        ),
        "obs_dim": OBS_DIM_DRIVE,
        "scenarios": scenarios,
        "expected": expected,
    }


def main() -> None:
    fixture = build_fixture()
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {FIXTURE_PATH}")
    print(
        f"scenarios: {len(fixture['scenarios'])} · expected observations: {len(fixture['expected'])}"
    )


if __name__ == "__main__":
    main()
