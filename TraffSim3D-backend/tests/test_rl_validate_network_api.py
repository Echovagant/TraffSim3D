"""API tests for `POST /api/v1/rl/validate-network`.

The endpoint is what lets the frontend check that an imported OSM map can
actually be simulated. It must accept the serialized-network shape the
frontend sends, report what the network-level sim core made of it, and
refuse a network it cannot run — with a message, not a stack trace.

Uses httpx2 + ASGITransport (in-process), like `test_rl_api.py`.
"""

from __future__ import annotations

import pytest
from httpx2 import ASGITransport, AsyncClient

from app.main import app


def _network() -> dict:
    """A square loop of four roads with four intersections."""
    corners = [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)]
    roads = [
        {
            "id": f"r{i}",
            "startNode": {"x": corners[i][0], "y": 0.0, "z": corners[i][1]},
            "endNode": {"x": corners[(i + 1) % 4][0], "y": 0.0, "z": corners[(i + 1) % 4][1]},
            "laneCount": 2,
            "speedLimit": 16.67,
        }
        for i in range(4)
    ]
    intersections = [
        {
            "id": f"I{i}",
            "position": {"x": corners[i][0], "y": 0.0, "z": corners[i][1]},
            "connectedRoads": [f"r{i}", f"r{(i + 3) % 4}"],
            "trafficLights": [],
            "intersectionRadius": 8.0,
        }
        for i in range(4)
    ]
    return {"roads": roads, "intersections": intersections, "vehicles": []}


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.mark.asyncio
async def test_a_valid_network_is_accepted(client: AsyncClient) -> None:
    r = await client.post("/api/v1/rl/validate-network", json={"network": _network()})

    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["obs_dim"] == 24
    assert body["n_roads"] == 4
    assert body["n_intersections"] == 4


@pytest.mark.asyncio
async def test_an_empty_network_is_rejected(client: AsyncClient) -> None:
    r = await client.post("/api/v1/rl/validate-network", json={"network": {"roads": []}})

    assert r.status_code == 400
    assert "roads" in r.json()["detail"]


@pytest.mark.asyncio
async def test_a_malformed_road_is_rejected(client: AsyncClient) -> None:
    """A road without a start node is a 400, not a 500."""
    network = _network()
    network["roads"][0].pop("startNode")

    r = await client.post("/api/v1/rl/validate-network", json={"network": network})

    assert r.status_code == 400
    assert "invalid network" in r.json()["detail"]


@pytest.mark.asyncio
async def test_a_network_with_a_single_road_is_accepted(client: AsyncClient) -> None:
    """One road is enough to run the core on."""
    network = {
        "roads": [
            {
                "id": "only",
                "startNode": {"x": 0.0, "y": 0.0, "z": 0.0},
                "endNode": {"x": 50.0, "y": 0.0, "z": 0.0},
                "laneCount": 2,
                "speedLimit": 16.67,
            }
        ],
        "intersections": [],
        "vehicles": [],
    }

    r = await client.post("/api/v1/rl/validate-network", json={"network": network})

    assert r.status_code == 200
    body = r.json()
    assert body["n_roads"] == 1
    assert body["n_intersections"] == 0


@pytest.mark.asyncio
async def test_the_endpoint_appears_in_the_openapi_schema(client: AsyncClient) -> None:
    """The committed schema must know about the endpoint."""
    r = await client.get("/openapi.json")

    assert r.status_code == 200
    assert "/api/v1/rl/validate-network" in r.json()["paths"]
