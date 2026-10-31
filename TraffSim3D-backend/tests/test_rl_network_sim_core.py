"""Behavioural tests for the network-level simulation core.

`network_sim_core` is the **24-dimension** core that runs on an arbitrary
user road network. It is a different thing from `sim_core`, which is the
**14-dimension** core for the fixed cross/corridor scenes and is the
authority for the cross-language contract. These tests pin the 24-dim
core's own invariants and — just as importantly — pin that the two cores
stay decoupled.

These are property assertions, not snapshots.
"""

from __future__ import annotations

import inspect
import math
import re

import numpy as np

from app.apps.rl import network_sim_core as nsc
from app.apps.rl.network_graph import build_network_graph
from app.apps.rl.network_sim_core import OBS_DIM_NETWORK, NetworkSimCore


def _road(road_id: str, start: tuple[float, float], end: tuple[float, float], **extra) -> dict:
    return {
        "id": road_id,
        "startNode": {"x": start[0], "z": start[1]},
        "endNode": {"x": end[0], "z": end[1]},
        "laneCount": 2,
        "speedLimit": 16.67,
        **extra,
    }


def _intersection(node_id: str, pos: tuple[float, float], roads: list[str]) -> dict:
    return {
        "id": node_id,
        "position": {"x": pos[0], "z": pos[1]},
        "connectedRoads": roads,
        "trafficLights": [],
        "intersectionRadius": 8.0,
    }


def _loop_network() -> dict:
    """A square loop of four roads — vehicles can drive around forever."""
    corners = [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)]
    roads = [_road(f"r{i}", corners[i], corners[(i + 1) % 4]) for i in range(4)]
    intersections = [
        _intersection(f"I{i}", corners[i], [f"r{i}", f"r{(i + 3) % 4}"]) for i in range(4)
    ]
    return {"roads": roads, "intersections": intersections, "vehicles": []}


def _core(network: dict | None = None) -> NetworkSimCore:
    return NetworkSimCore(build_network_graph(network or _loop_network()))


def test_observation_dimension_is_twenty_four() -> None:
    """The network core's observation is 24-dim — not the 14-dim contract one."""
    assert OBS_DIM_NETWORK == 24
    assert nsc.OBS_DIM_NETWORK == 24


def test_reset_returns_an_observation_of_the_right_shape() -> None:
    core = _core()
    obs = core.reset(seed=0)

    assert isinstance(obs, np.ndarray)
    assert obs.shape == (OBS_DIM_NETWORK,)
    assert obs.dtype == np.float32


def test_step_returns_an_observation_of_the_right_shape() -> None:
    core = _core()
    core.reset(seed=1)

    obs, reward, terminated, truncated, info = core.step(np.array([1.0, 0.0]))

    assert obs.shape == (OBS_DIM_NETWORK,)
    assert isinstance(reward, float)
    assert isinstance(terminated, bool)
    assert isinstance(truncated, bool)
    assert "reason" in info


def test_observations_are_always_finite() -> None:
    """No NaN, no Inf — in the reset observation or in any step."""
    core = _core()
    obs = core.reset(seed=7)
    assert np.all(np.isfinite(obs)), f"non-finite reset observation: {obs}"

    for step in range(50):
        obs, _reward, terminated, _truncated, _info = core.step(
            np.array([0.5, 0.0], dtype=np.float32)
        )
        assert obs.shape == (OBS_DIM_NETWORK,)
        assert np.all(np.isfinite(obs)), f"non-finite observation at step {step}: {obs}"
        if terminated:
            break


def test_the_ego_moves_forward() -> None:
    """A vehicle under power actually moves along the network."""
    core = _core()
    core.reset(seed=3)
    start = (core.ego.x, core.ego.z)

    core.step(np.array([1.0, 0.0]))

    assert math.hypot(core.ego.x - start[0], core.ego.z - start[1]) > 0.0
    assert core.ego.speed > 0.0


def test_the_ego_travelled_further_over_more_steps() -> None:
    """Position keeps changing as the simulation runs."""
    core = _core()
    core.reset(seed=5)

    positions = [(core.ego.x, core.ego.z)]
    for _ in range(5):
        core.step(np.array([1.0, 0.0]))
        positions.append((core.ego.x, core.ego.z))

    travelled = sum(
        math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(positions, positions[1:], strict=False)
    )
    assert travelled > 0.0


def test_npcs_are_driven_by_the_model() -> None:
    """The NPCs move too — they are not frozen placeholders."""
    core = _core()
    core.reset(seed=11)
    before = [(npc.x, npc.z) for npc in core.npcs]

    for _ in range(3):
        core.step(np.array([0.0, 0.0]))

    moved = sum(
        1
        for npc, (x, z) in zip(core.npcs, before, strict=False)
        if math.hypot(npc.x - x, npc.z - z) > 0.0
    )
    assert moved >= 1


def test_speed_stays_within_the_road_limits() -> None:
    """No vehicle exceeds the speed limit or goes negative."""
    core = _core()
    core.reset(seed=13)

    for _ in range(30):
        core.step(np.array([1.0, 0.0]))
        assert 0.0 <= core.ego.speed <= nsc.SPEED_LIMIT_DEFAULT
        for npc in core.npcs:
            assert 0.0 <= npc.speed <= nsc.SPEED_LIMIT_DEFAULT


def test_an_empty_network_terminates_immediately() -> None:
    """No roads → the episode ends with a reason, not a crash."""
    core = NetworkSimCore(build_network_graph({"roads": [], "intersections": []}))
    obs = core.reset(seed=0)

    assert obs.shape == (OBS_DIM_NETWORK,)
    assert np.all(np.isfinite(obs))
    _obs, _reward, terminated, _truncated, info = core.step(np.array([0.0, 0.0]))
    assert terminated
    assert info["reason"] == "no_roads"


def test_the_ego_turns_at_a_junction_instead_of_driving_past_it() -> None:
    """The Pure Pursuit alpha sign — a regression test for a real defect.

    The alpha was `heading - target_angle`, the opposite of the
    textbook sign (and of the contract core's), which makes the
    steering **diverge**: the heading error grows every step. Measured
    on an L-shaped road, an ego that had to turn at the junction drove
    straight past it and ended 52 m off the road with its route progress
    stuck at 0.500. Straight roads hid it — the target is dead ahead
    there, so the alpha stays near zero — which is why the other tests
    never caught it.
    """
    graph = build_network_graph(
        {
            "roads": [
                {
                    "id": "r-a",
                    "startNode": {"x": 0, "y": 0, "z": 0},
                    "endNode": {"x": 100, "y": 0, "z": 0},
                    "waypoints": [{"x": 0, "y": 0, "z": 0}, {"x": 100, "y": 0, "z": 0}],
                    "laneCount": 2,
                    "speedLimit": 16.67,
                },
                {
                    "id": "r-b",
                    "startNode": {"x": 100, "y": 0, "z": 0},
                    "endNode": {"x": 100, "y": 0, "z": 100},
                    "waypoints": [{"x": 100, "y": 0, "z": 0}, {"x": 100, "y": 0, "z": 100}],
                    "laneCount": 2,
                    "speedLimit": 16.67,
                },
            ],
            "intersections": [
                {
                    "id": "i-1",
                    "position": {"x": 100, "y": 0, "z": 0},
                    "connectedRoads": ["r-a", "r-b"],
                }
            ],
            "vehicles": [],
            "spawnPoints": [],
        }
    )
    core = NetworkSimCore(graph)
    core.reset(seed=0)
    core.ego.route.segment_ids = ["r-a", "r-b"]
    core.ego.current_seg_idx = 0
    core.ego.x, core.ego.z, core.ego.heading = 40.0, 0.0, 0.0
    core.ego.speed = 8.0
    core.ego.seg_t = 40.0

    for _ in range(80):
        core.step(np.array([1.0, 0.0]))

    # The ego turned (its heading left the road's direction) and it got
    # further along its route.
    assert abs(core.ego.heading) > 0.3, "the ego never turned"
    assert (
        core.ego.route_progress > 0.6
    ), f"the route progress is still {core.ego.route_progress:.3f}"


def test_the_network_core_does_not_import_the_contract_core() -> None:
    """The two cores must stay decoupled.

    `sim_core.py` is the cross-language contract authority (14-dim, fixed
    scenes, byte-compared against the TypeScript mirror). If the 24-dim
    network core imported it, the contract goldens would start depending on
    user-authored networks.
    """
    source = inspect.getsource(nsc)
    forbidden = re.compile(
        r"from\s+\.sim_core\s+import"
        r"|from\s+app\.apps\.rl\.sim_core\s+import"
        r"|import\s+sim_core\b"
    )
    assert not forbidden.search(source), "network_sim_core must not import sim_core"


def test_the_two_cores_have_different_observation_sizes() -> None:
    """The 24-dim core and the 14-dim contract core are not the same thing."""
    from app.apps.rl import sim_core

    assert sim_core.OBS_DIM == 14
    assert OBS_DIM_NETWORK == 24
    assert sim_core.OBS_DIM != OBS_DIM_NETWORK
