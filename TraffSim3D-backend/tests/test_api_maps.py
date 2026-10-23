"""FastAPI /api/v1/maps/parse-osm endpoint tests.

Uses httpx2 + ASGITransport (in-process, no subprocess overhead).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from httpx2 import ASGITransport, AsyncClient

from app.main import app

FIXTURE = Path(__file__).parent / "fixtures" / "sample-4way.osm"


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.mark.asyncio
async def test_parse_osm_returns_200_with_roads(client: AsyncClient) -> None:
    with FIXTURE.open("rb") as f:
        r = await client.post(
            "/api/v1/maps/parse-osm",
            files={"file": ("sample.osm", f, "application/xml")},
        )
    assert r.status_code == 200
    body = r.json()
    assert "roads" in body
    assert len(body["roads"]) >= 2


@pytest.mark.asyncio
async def test_parse_osm_rejects_invalid_xml(client: AsyncClient) -> None:
    r = await client.post(
        "/api/v1/maps/parse-osm",
        files={"file": ("bad.osm", b"<not-xml", "application/xml")},
    )
    assert r.status_code == 400
    assert "Invalid OSM XML" in r.text


@pytest.mark.asyncio
async def test_parse_osm_handles_xml_without_highways(client: AsyncClient) -> None:
    r = await client.post(
        "/api/v1/maps/parse-osm",
        files={
            "file": (
                "empty.osm",
                b'<?xml version="1.0"?><osm version="0.6"></osm>',
                "application/xml",
            )
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["roads"] == []
    assert body["intersections"] == []


@pytest.mark.asyncio
async def test_parse_osm_response_carries_origin_and_spawn_points(
    client: AsyncClient,
) -> None:
    """The front-end consumes the origin and the spawn points from here."""
    with FIXTURE.open("rb") as f:
        r = await client.post(
            "/api/v1/maps/parse-osm",
            files={"file": ("sample.osm", f, "application/xml")},
        )
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body["originLat"], float)
    assert isinstance(body["originLon"], float)
    road_ids = {road["id"] for road in body["roads"]}
    assert body["spawnPoints"], "no spawn points in the response"
    for spawn in body["spawnPoints"]:
        assert spawn["roadId"] in road_ids
        assert spawn["id"] == f"sp-{spawn['roadId']}-{spawn['laneIndex']}"
        assert spawn["laneIndex"] == 0
        assert spawn["s"] == 0
        assert spawn["occupiedBy"] is None


@pytest.mark.asyncio
async def test_parse_pbf_response_matches_the_xml_response(client: AsyncClient) -> None:
    """Both endpoints run the same pipeline, so they must agree."""
    pbf = Path(__file__).parent / "fixtures" / "sample-4way.osm.pbf"
    if not pbf.exists():
        pytest.skip("PBF fixture not yet generated")
    with FIXTURE.open("rb") as f:
        xml_body = (
            await client.post(
                "/api/v1/maps/parse-osm",
                files={"file": ("sample.osm", f, "application/xml")},
            )
        ).json()
    with pbf.open("rb") as f:
        pbf_body = (
            await client.post(
                "/api/v1/maps/parse-pbf",
                files={"file": ("sample.osm.pbf", f, "application/octet-stream")},
            )
        ).json()
    assert len(xml_body["roads"]) == len(pbf_body["roads"])
    assert len(xml_body["intersections"]) == len(pbf_body["intersections"])
    xml_signals = sum(len(i["trafficLights"]) for i in xml_body["intersections"])
    pbf_signals = sum(len(i["trafficLights"]) for i in pbf_body["intersections"])
    assert xml_signals == pbf_signals
    assert xml_signals >= 1


@pytest.mark.asyncio
async def test_parse_pbf_returns_200_with_roads(client: AsyncClient) -> None:
    pbf = Path(__file__).parent / "fixtures" / "sample-4way.osm.pbf"
    if not pbf.exists():
        pytest.skip("PBF fixture not yet generated")
    with pbf.open("rb") as f:
        r = await client.post(
            "/api/v1/maps/parse-pbf",
            files={"file": ("sample.osm.pbf", f, "application/octet-stream")},
        )
    assert r.status_code == 200
    body = r.json()
    assert "roads" in body
    assert len(body["roads"]) >= 2


@pytest.mark.asyncio
async def test_parse_pbf_rejects_truncated(client: AsyncClient) -> None:
    r = await client.post(
        "/api/v1/maps/parse-pbf",
        files={"file": ("bad.pbf", b"\x00\x01\x02 not a pbf", "application/octet-stream")},
    )
    assert r.status_code == 400
    assert "Invalid OSM PBF" in r.text
