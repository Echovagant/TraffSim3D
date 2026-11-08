"""The bundled sample city endpoint (`POST /api/v1/maps/parse-sample`).

The sample is the 深圳福田 extract that ships with the backend. The
endpoint exists so the Smart City view can show a real city — with the
cars on the roads the picture draws — without an upload and without
Overpass.

These tests pin the contract the frontend depends on:

  - the network is a real city (hundreds of roads, thousands of
    junctions, hundreds of spawn points);
  - the projection origin is the centre of the drawn rectangle, which
    is the same point the frontend uses as its fallback tangent origin
    — the simulation and the basemap have to describe ONE place;
  - the road class survives the parse (the renderer draws the road
    hierarchy from it);
  - the second call is served from the cache.
"""

from __future__ import annotations

import pytest
from httpx2 import ASGITransport, AsyncClient

from app.api.v1 import maps as maps_api
from app.main import app

# The frontend's fallback tangent origin (viewer.ts). The sample's
# projection origin has to BE this point, or the cars and the basemap
# would not describe the same place.
FRONTEND_TANGENT_ORIGIN = {"lat": 22.54297, "lon": 114.06865}


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.mark.asyncio
async def test_parse_sample_returns_a_real_city(client: AsyncClient) -> None:
    r = await client.post("/api/v1/maps/parse-sample")
    assert r.status_code == 200
    body = r.json()

    roads = body["roads"]
    intersections = body["intersections"]
    assert len(roads) > 500, f"expected a real city, got {len(roads)} roads"
    assert len(intersections) > 500
    # The cars need somewhere to start.
    assert len(body.get("spawnPoints", [])) > 100


@pytest.mark.asyncio
async def test_parse_sample_origin_is_the_drawn_rectangle_centre(
    client: AsyncClient,
) -> None:
    r = await client.post("/api/v1/maps/parse-sample")
    body = r.json()

    assert body["originLat"] == pytest.approx(FRONTEND_TANGENT_ORIGIN["lat"], abs=1e-4)
    assert body["originLon"] == pytest.approx(FRONTEND_TANGENT_ORIGIN["lon"], abs=1e-4)
    # The sample's rectangle is the one the frontend fetches the
    # basemap for.
    south, west, north, east = maps_api.SAMPLE_BBOX
    assert (south, west, north, east) == (22.52297, 114.04865, 22.56297, 114.08865)


@pytest.mark.asyncio
async def test_parse_sample_keeps_the_road_class(client: AsyncClient) -> None:
    r = await client.post("/api/v1/maps/parse-sample")
    roads = r.json()["roads"]

    classes = {road.get("highway") for road in roads}
    assert None not in classes, "every parsed road must carry its OSM class"
    # The classes a city actually has — the renderer maps them onto the
    # four road tiers.
    assert classes & {"motorway", "trunk", "primary", "secondary", "tertiary", "residential"}


@pytest.mark.asyncio
async def test_parse_sample_is_cached(client: AsyncClient) -> None:
    first = await client.post("/api/v1/maps/parse-sample")
    second = await client.post("/api/v1/maps/parse-sample")

    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
