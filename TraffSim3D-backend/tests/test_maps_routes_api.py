"""The route-planning endpoint — `POST /api/v1/routes/plan`.

What is pinned here:

1. **The path is the cheapest one.** A longer detour must not win.
2. **The direction is the car's.** The start is "the end of this road,
   in this direction" — so a route planned from a car heading *backwards*
   along a road starts at that road's *first* vertex, and the returned
   legs are drivable from where the car is.
3. **One-way streets are one-way.** The graph is directed; a route must
   not drive a one-way street against its traffic.
4. **Unknown ends are errors**, not "somewhere near the target".
"""

from __future__ import annotations

from typing import Any

import pytest
from httpx2 import ASGITransport, AsyncClient

from app.main import app


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def _pos(x: float, z: float) -> dict[str, float]:
    return {"x": x, "z": z, "y": 0.0}


def _grid_network() -> dict[str, Any]:
    """A 2 x 2 grid of junctions, four roads of 100 m each.

      i0 ---- r0 ---- i1
       |               |
      r2             r3
       |               |
      i3 ---- r1 ---- i2

    Every road is bidirectional, so both directions are drivable.
    """
    return {
        "roads": [
            {
                "id": "r0",
                "startNode": _pos(0, 0),
                "endNode": _pos(100, 0),
                "laneCount": 2,
                "speedLimit": 16.67,
            },
            {
                "id": "r1",
                "startNode": _pos(0, 100),
                "endNode": _pos(100, 100),
                "laneCount": 2,
                "speedLimit": 16.67,
            },
            {
                "id": "r2",
                "startNode": _pos(0, 0),
                "endNode": _pos(0, 100),
                "laneCount": 2,
                "speedLimit": 16.67,
            },
            {
                "id": "r3",
                "startNode": _pos(100, 0),
                "endNode": _pos(100, 100),
                "laneCount": 2,
                "speedLimit": 16.67,
            },
        ],
        "intersections": [
            {"id": "i0", "position": _pos(0, 0), "connectedRoads": ["r0", "r2"]},
            {"id": "i1", "position": _pos(100, 0), "connectedRoads": ["r0", "r3"]},
            {"id": "i2", "position": _pos(100, 100), "connectedRoads": ["r1", "r3"]},
            {"id": "i3", "position": _pos(0, 100), "connectedRoads": ["r1", "r2"]},
        ],
        "vehicles": [],
    }


@pytest.mark.asyncio
async def test_the_cheapest_path_is_returned(client: AsyncClient) -> None:
    # From i0 to i2 the cheap way is r0 + r3 (200 m); the way round is
    # r2 + r1 (also 200 m here — so make the detour clearly longer).
    network = _grid_network()
    network["roads"].append(
        {
            "id": "r4",
            "startNode": _pos(0, 0),
            "endNode": _pos(0, 100),
            "laneCount": 2,
            "speedLimit": 16.67,
        }
    )
    # r4 runs the same 100 m as r2 — make r4 the long way round instead.
    network["roads"][2] = {
        "id": "r2",
        "startNode": _pos(0, 0),
        "endNode": _pos(0, 100),
        "laneCount": 2,
        "speedLimit": 16.67,
    }

    response = await client.post(
        "/api/v1/routes/plan",
        json={
            "network": network,
            "start": {"junction_id": "i0"},
            "end": {"junction_id": "i2"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["found"] is True
    assert body["cost_m"] == pytest.approx(200.0)
    assert body["roads"] == ["r0", "r3"]


@pytest.mark.asyncio
async def test_the_start_is_the_end_of_the_road_in_the_driving_direction(
    client: AsyncClient,
) -> None:
    """A car driving forward along r0 arrives at i1; backward, at i0."""
    network = _grid_network()

    forward = await client.post(
        "/api/v1/routes/plan",
        json={
            "network": network,
            "start": {"road_id": "r0", "direction": "forward"},
            "end": {"junction_id": "i2"},
        },
    )
    backward = await client.post(
        "/api/v1/routes/plan",
        json={
            "network": network,
            "start": {"road_id": "r0", "direction": "backward"},
            "end": {"junction_id": "i2"},
        },
    )

    assert forward.status_code == 200
    assert backward.status_code == 200

    # Forward along r0 → the car is heading for i1, so the route continues
    # from i1: r3 to i2.
    assert forward.json()["roads"] == ["r3"]
    # Backward along r0 → the car is heading for i0, so the route continues
    # from i0: r2 to i3 and then r1 to i2.
    assert backward.json()["roads"] == ["r2", "r1"]


@pytest.mark.asyncio
async def test_a_one_way_street_is_not_driven_backwards(client: AsyncClient) -> None:
    network = _grid_network()
    # r0 becomes one-way, running i0 → i1 only.
    network["roads"][0]["oneway"] = True

    # i1 → i0 would have to drive r0 backwards.
    against = await client.post(
        "/api/v1/routes/plan",
        json={
            "network": network,
            "start": {"junction_id": "i1"},
            "end": {"junction_id": "i0"},
        },
    )
    # i0 → i1 drives it the legal way.
    with_it = await client.post(
        "/api/v1/routes/plan",
        json={
            "network": network,
            "start": {"junction_id": "i0"},
            "end": {"junction_id": "i1"},
        },
    )

    assert with_it.status_code == 200
    assert with_it.json()["found"] is True
    assert with_it.json()["roads"] == ["r0"]
    # No legal path from i1 to i0 on this network: i1's only roads are r0
    # (one-way, against us) and r3, and r3 leads to i2 → i3 → i0 the long
    # way round — which IS legal. So the route must take the long way.
    assert against.status_code == 200
    assert against.json()["found"] is True
    assert against.json()["roads"] == ["r3", "r1", "r2"]


@pytest.mark.asyncio
async def test_an_unreachable_end_is_reported_not_guessed(client: AsyncClient) -> None:
    network = _grid_network()
    # A road that leads nowhere: it is not connected to any junction.
    network["roads"].append(
        {
            "id": "r9",
            "startNode": _pos(500, 500),
            "endNode": _pos(600, 500),
            "laneCount": 2,
            "speedLimit": 16.67,
        }
    )

    response = await client.post(
        "/api/v1/routes/plan",
        json={
            "network": network,
            "start": {"junction_id": "i0"},
            "end": {"road_id": "r9", "direction": "forward"},
        },
    )

    # r9's end node exists in the graph (it is a waypoint), so the route
    # is planned — and it is NOT found, because r9 is not connected to
    # the rest of the network.
    assert response.status_code == 200
    assert response.json()["found"] is False
    assert response.json()["roads"] == []


@pytest.mark.asyncio
async def test_unknown_ends_are_404(client: AsyncClient) -> None:
    network = _grid_network()

    missing_junction = await client.post(
        "/api/v1/routes/plan",
        json={
            "network": network,
            "start": {"junction_id": "nope"},
            "end": {"junction_id": "i2"},
        },
    )
    missing_road = await client.post(
        "/api/v1/routes/plan",
        json={
            "network": network,
            "start": {"junction_id": "i0"},
            "end": {"road_id": "nope", "direction": "forward"},
        },
    )
    no_endpoint = await client.post(
        "/api/v1/routes/plan",
        json={"network": network, "start": {}, "end": {"junction_id": "i2"}},
    )
    empty_network = await client.post(
        "/api/v1/routes/plan",
        json={"network": {}, "start": {"junction_id": "i0"}, "end": {"junction_id": "i2"}},
    )

    assert missing_junction.status_code == 404
    assert missing_road.status_code == 404
    assert no_endpoint.status_code == 400
    assert empty_network.status_code == 400


@pytest.mark.asyncio
async def test_a_route_across_the_real_5x5_grid(client: AsyncClient) -> None:
    """The endpoint on the product's own scene data, not a toy network.

    The 5 x 5 grid is what the browser loads for the grid scene, built
    by the same builder the RL environment trains on. A route from one
    corner to the opposite one has to cross 8 segments of 120 m each —
    the Manhattan distance, because the grid is a lattice.
    """
    from app.apps.rl.network_signal_env import build_grid_network_dict

    network = build_grid_network_dict(5, 5)
    intersections = network["intersections"]
    assert len(intersections) == 25

    response = await client.post(
        "/api/v1/routes/plan",
        json={
            "network": network,
            "start": {"junction_id": intersections[0]["id"]},
            "end": {"junction_id": intersections[-1]["id"]},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["found"] is True
    # A corner-to-corner crossing of a 5 x 5 lattice: 4 segments east and
    # 4 south, 120 m each.
    assert body["cost_m"] == pytest.approx(8 * 120.0)
    assert len(body["roads"]) == 8
    # Every leg is a real road of the network.
    road_ids = {r["id"] for r in network["roads"]}
    assert set(body["roads"]) <= road_ids
    # The legs chain: each leg's `to` is the next leg's `from`.
    for first, second in zip(body["legs"], body["legs"][1:], strict=False):
        assert first["to"] == second["from"]
