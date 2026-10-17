"""M3 bbox wiring: the parser's existing clipping capability reaches the HTTP API.

`osm_parser.parse_osm_xml` / `parse_osmpbf` already accept `bbox`
(south, west, north, east) and default to the `MAX_BBOX_DEG = 0.5`
memory-safety cap when it is omitted. Nothing in `app/api/v1/maps.py`
forwarded that argument, so "只加载仿真区域" was unreachable over HTTP.

These tests pin the contract at the API boundary:

* omitting every bbox param must leave the response byte-for-byte the
  historical shape (parallel e2e work depends on it);
* supplying a bbox must actually change the parsed network — otherwise the
  endpoint is silently ignoring it, which is the failure mode this file
  exists to catch;
* a malformed bbox must be rejected as a *request* error (422), not turned
  into a 500 by the parser's ValueError falling into the generic handler.

The expected road ids below were derived by running the parser directly
against the two fixtures, not guessed.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from httpx2 import ASGITransport, AsyncClient

from app.main import app

FIXTURES = Path(__file__).parent / "fixtures"
XML_FIXTURE = FIXTURES / "sample-4way.osm"
PBF_FIXTURE = FIXTURES / "sample-4way.osm.pbf"

# Response shape the endpoints produced before bbox was wired in. Any new
# top-level key would break callers that do `loadNetwork(body)` directly.
HISTORICAL_KEYS = {"roads", "intersections", "vehicles", "spawnPoints"}

# sample-4way.osm has 4 usable roads. Nodes 1/2/6 sit at lon -0.0010/-0.0005,
# node 8 at 0.0015 and node 9 at 0.0020. Clipping the east edge to 0.0009 drops
# nodes 5, 8 and 9, which leaves way 204 (nodes 7, 8, 9) with a single
# surviving node and therefore no road at all.
XML_BBOX_CLIP = {"south": -0.01, "west": 0.0, "north": 0.01, "east": 0.0009}
XML_ALL_ROADS = {"w-201", "w-202", "w-203", "w-204"}
XML_CLIPPED_ROADS = {"w-201", "w-202", "w-203"}
PBF_ALL_ROADS = {"w-pbf-201", "w-pbf-202", "w-pbf-203", "w-pbf-204"}
PBF_CLIPPED_ROADS = {"w-pbf-201", "w-pbf-202", "w-pbf-203"}

# Three east-west roads at clearly separated latitudes so a bbox selects
# between them unambiguously. Same fixture idea as tests/test_osm_clipping.py;
# repeated here because the assertion under test is the HTTP wiring, not the
# parser (which that file already covers).
GRID_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="0.00" lon="0.00"/>
  <node id="2" lat="0.00" lon="0.01"/>
  <node id="3" lat="0.05" lon="0.00"/>
  <node id="4" lat="0.05" lon="0.01"/>
  <node id="5" lat="0.09" lon="0.00"/>
  <node id="6" lat="0.09" lon="0.01"/>
  <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way>
  <way id="11"><nd ref="3"/><nd ref="4"/><tag k="highway" v="residential"/></way>
  <way id="12"><nd ref="5"/><nd ref="6"/><tag k="highway" v="residential"/></way>
</osm>
"""

XML_ENDPOINT = "/api/v1/maps/parse-osm"
PBF_ENDPOINT = "/api/v1/maps/parse-pbf"


@pytest.fixture
async def client():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


def _xml_upload(payload: bytes = b"", filename: str = "sample.osm") -> dict:
    return {"file": (filename, payload or XML_FIXTURE.read_bytes(), "application/xml")}


def _pbf_upload() -> dict:
    return {
        "file": (
            "sample.osm.pbf",
            PBF_FIXTURE.read_bytes(),
            "application/octet-stream",
        )
    }


# --------------------------------------------------------------------------
# Backward compatibility: no bbox => identical response.
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_parse_osm_without_bbox_keeps_historical_response(client: AsyncClient) -> None:
    """No bbox params at all => historical shape, 0.5 deg safety cap."""
    r = await client.post(XML_ENDPOINT, files=_xml_upload())
    assert r.status_code == 200
    body = r.json()
    assert set(body.keys()) == HISTORICAL_KEYS
    assert {road["id"] for road in body["roads"]} == XML_ALL_ROADS


@pytest.mark.asyncio
async def test_parse_pbf_without_bbox_keeps_historical_response(client: AsyncClient) -> None:
    r = await client.post(PBF_ENDPOINT, files=_pbf_upload())
    assert r.status_code == 200
    body = r.json()
    assert set(body.keys()) == HISTORICAL_KEYS
    assert {road["id"] for road in body["roads"]} == PBF_ALL_ROADS


# --------------------------------------------------------------------------
# The actual wiring: bbox must reach the parser.
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_parse_osm_applies_bbox(client: AsyncClient) -> None:
    """The eastern service road is dropped once bbox reaches the parser."""
    r = await client.post(XML_ENDPOINT, files=_xml_upload(), params=XML_BBOX_CLIP)
    assert r.status_code == 200
    body = r.json()
    assert set(body.keys()) == HISTORICAL_KEYS
    assert {road["id"] for road in body["roads"]} == XML_CLIPPED_ROADS


@pytest.mark.asyncio
async def test_parse_pbf_applies_bbox(client: AsyncClient) -> None:
    r = await client.post(PBF_ENDPOINT, files=_pbf_upload(), params=XML_BBOX_CLIP)
    assert r.status_code == 200
    body = r.json()
    assert {road["id"] for road in body["roads"]} == PBF_CLIPPED_ROADS


@pytest.mark.asyncio
async def test_bbox_is_south_west_north_east_order(client: AsyncClient) -> None:
    """Proven through HTTP, not assumed from the parser signature.

    The three fixture roads are separated purely by latitude, so this only
    holds if the query params mean (south, west, north, east). Under
    (north, west, south, east) the south<north check would reject the
    request; under (west, south, east, north) it would select the wrong band.
    """
    south_only = await client.post(
        XML_ENDPOINT,
        files=_xml_upload(GRID_XML, "grid.osm"),
        params={"south": -0.01, "west": -0.01, "north": 0.01, "east": 0.02},
    )
    assert south_only.status_code == 200
    assert {r["id"] for r in south_only.json()["roads"]} == {"w-10"}

    two_bands = await client.post(
        XML_ENDPOINT,
        files=_xml_upload(GRID_XML, "grid.osm"),
        params={"south": -0.01, "west": -0.01, "north": 0.06, "east": 0.02},
    )
    assert two_bands.status_code == 200
    assert {r["id"] for r in two_bands.json()["roads"]} == {"w-10", "w-11"}


@pytest.mark.asyncio
async def test_bbox_outside_the_data_returns_an_empty_network(client: AsyncClient) -> None:
    """A bbox matching nothing is a valid 200 with an empty, well-formed body."""
    r = await client.post(
        XML_ENDPOINT,
        files=_xml_upload(),
        params={"south": 50.0, "west": 50.0, "north": 50.01, "east": 50.01},
    )
    assert r.status_code == 200
    body = r.json()
    assert set(body.keys()) == HISTORICAL_KEYS
    assert body["roads"] == []
    assert body["intersections"] == []


# --------------------------------------------------------------------------
# Validation: a bad bbox is a 422 request error, never a 500.
# --------------------------------------------------------------------------


INVALID_BBOX_CASES = [
    pytest.param(
        {"south": 1.0, "west": 0.0, "north": 0.5, "east": 1.0},
        "south",
        id="south-above-north",
    ),
    pytest.param(
        {"south": 0.0, "west": 1.0, "north": 1.0, "east": 0.5},
        "west",
        id="west-above-east",
    ),
    pytest.param(
        {"south": 91.0, "west": 0.0, "north": 92.0, "east": 1.0},
        "south",
        id="latitude-out-of-range",
    ),
    pytest.param(
        {"south": 0.0, "west": 0.0, "north": 1.0, "east": 181.0},
        "east",
        id="longitude-out-of-range",
    ),
    pytest.param(
        {"south": "abc", "west": 0.0, "north": 1.0, "east": 1.0},
        "south",
        id="non-numeric",
    ),
    pytest.param(
        {"south": -0.01, "west": -0.01, "north": 0.01},
        "east",
        id="partial-bbox",
    ),
    pytest.param(
        {"west": -0.01, "north": 0.01, "east": 0.02},
        "south",
        id="partial-bbox-first",
    ),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("params,offending", INVALID_BBOX_CASES)
async def test_parse_osm_rejects_invalid_bbox(
    client: AsyncClient, params: dict, offending: str
) -> None:
    r = await client.post(XML_ENDPOINT, files=_xml_upload(), params=params)
    assert r.status_code == 422, r.text
    assert offending in r.text


@pytest.mark.asyncio
@pytest.mark.parametrize("params,offending", INVALID_BBOX_CASES)
async def test_parse_pbf_rejects_invalid_bbox(
    client: AsyncClient, params: dict, offending: str
) -> None:
    r = await client.post(PBF_ENDPOINT, files=_pbf_upload(), params=params)
    assert r.status_code == 422, r.text
    assert offending in r.text


@pytest.mark.asyncio
async def test_invalid_bbox_does_not_mask_a_bad_file(client: AsyncClient) -> None:
    """Validation runs before parsing, so a 422 never reports a parse failure."""
    r = await client.post(
        XML_ENDPOINT,
        files=_xml_upload(b"<not-xml", "bad.osm"),
        params={"south": 1.0, "west": 0.0, "north": 0.5, "east": 1.0},
    )
    assert r.status_code == 422
    assert "Invalid OSM XML" not in r.text
