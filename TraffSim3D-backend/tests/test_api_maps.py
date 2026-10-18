"""Plan 041: FastAPI /api/v1/maps/parse-osm endpoint tests.

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
