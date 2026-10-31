"""The `coord` query param on the parse endpoints — datum conversion.

The failure this guards against is silent: a 高德-exported file parsed
as WGS84 lands 300–600 m off with NO error anywhere — roads render,
traffic runs, the map is simply in the wrong place. So the endpoint
must (a) convert when asked, (b) refuse an unknown datum loudly, and
(c) leave the default path byte-compatible with the pre-param
behaviour.

The conversion is verified on the PAYLOAD (the parsed network's origin
and geometry are in the local metric frame — the datum offset is
visible as the difference between two parses of the same file), not on
raw lat/lon that the payload no longer carries.
"""

from __future__ import annotations

import pytest
from httpx2 import ASGITransport, AsyncClient

from app.main import app

#: A tiny two-node-one-way map around 天安门, with coordinates in
#: GCJ-02 (the 高德 datum) — the offset to WGS84 is ~0.0025 lat /
#: ~0.0058 lon here, far above the parse noise. The second node sits
#: +0.001/+0.001 away, and the parser centres the map on the NODES'
#: CENTRE — hence the +0.0005 on the expected origin.
GCJ_LAT, GCJ_LON = 39.9087457, 116.3974992
GCJ_CENTER_LAT, GCJ_CENTER_LON = GCJ_LAT + 0.0005, GCJ_LON + 0.0005

OSM_XML = f"""<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="{GCJ_LAT}" lon="{GCJ_LON}"/>
  <node id="2" lat="{GCJ_LAT + 0.001}" lon="{GCJ_LON + 0.001}"/>
  <way id="100">
    <nd ref="1"/>
    <nd ref="2"/>
    <tag k="highway" v="secondary"/>
    <tag k="name" v="测试路"/>
  </way>
</osm>
"""


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def _parse(client: AsyncClient, coord: str) -> dict:
    files = {"file": ("tiny.osm", OSM_XML.encode("utf-8"), "application/xml")}
    response = await client.post(f"/api/v1/maps/parse-osm?coord={coord}", files=files)
    assert response.status_code == 200
    return response.json()


@pytest.mark.asyncio
async def test_the_default_path_is_wgs84_passthrough(client: AsyncClient) -> None:
    """No coord param = WGS84: the origin is where the file says it is.

    The payload carries the map origin as `originLat` / `originLon` (the
    roads' coordinates are LOCAL METRES relative to it — the datum
    difference is visible exactly there).
    """
    no_param = await client.post(
        "/api/v1/maps/parse-osm",
        files={"file": ("tiny.osm", OSM_XML.encode("utf-8"), "application/xml")},
    )
    no_param = no_param.json()
    default = await _parse(client, "wgs84")
    # The default IS wgs84 — the two payloads agree on the origin.
    assert default["originLat"] == pytest.approx(no_param["originLat"], abs=1e-12)
    assert default["originLon"] == pytest.approx(no_param["originLon"], abs=1e-12)
    # And the origin sits at the file's coordinates (the parser centres
    # the map on the first node).
    assert default["originLat"] == pytest.approx(GCJ_CENTER_LAT, abs=1e-4)


@pytest.mark.asyncio
async def test_the_gcj02_datum_shifts_the_map_by_the_datum_offset(
    client: AsyncClient,
) -> None:
    """The conversion is visible in the payload: the same file parsed as
    GCJ-02 puts the origin at the WGS84 position, ~0.0025/0.0058 degrees
    from the un-converted parse."""
    gcj = await _parse(client, "gcj02")
    wgs = await _parse(client, "wgs84")

    dlat = gcj["originLat"] - wgs["originLat"]
    dlon = gcj["originLon"] - wgs["originLon"]
    # The datum offset, expressed on the payload: ~0.0025 lat / ~0.0058
    # lon in Beijing, NEGATIVE latitude (the GCJ offset rotates with
    # position — the sign is the formula's, the magnitude is the point).
    assert 0.001 < abs(dlat) < 0.006
    assert 0.004 < abs(dlon) < 0.008


@pytest.mark.asyncio
async def test_an_unknown_datum_is_refused_loudly(client: AsyncClient) -> None:
    """Silently treating an unknown datum as WGS84 would place the map
    300-600 m off with no signal at all."""
    response = await client.post(
        "/api/v1/maps/parse-osm?coord=gauss-kruger",
        files={"file": ("tiny.osm", OSM_XML.encode("utf-8"), "application/xml")},
    )
    assert response.status_code == 422
    assert "unknown coord datum" in response.json()["detail"]


@pytest.mark.asyncio
async def test_the_pbf_endpoint_accepts_the_same_param(client: AsyncClient) -> None:
    """The datum refusal is wired on the PBF endpoint too (the happy
    path needs libosmium and a real file — the refusal is the parity
    that must not drift)."""
    response = await client.post(
        "/api/v1/maps/parse-pbf?coord=gauss-kruger",
        files={"file": ("tiny.osm.pbf", b"not-a-real-pbf", "application/octet-stream")},
    )
    # The datum check runs BEFORE the bytes are streamed: the 422 is the
    # datum refusal, not a PBF parse error.
    assert response.status_code == 422
    assert "unknown coord datum" in response.json()["detail"]
