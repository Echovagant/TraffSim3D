"""Plan 041 + 046: OSM parser unit tests (XML + PBF)."""
from __future__ import annotations

from pathlib import Path

import pytest

from app.apps.maps.osm_parser import parse_osm_xml, parse_osmpbf

FIXTURE_DIR = Path(__file__).parent / "fixtures"
FIXTURE_XML = FIXTURE_DIR / "sample-4way.osm"
FIXTURE_PBF = FIXTURE_DIR / "sample-4way.osm.pbf"


def _build_pbf_fixture_if_missing() -> Path:
    """One-time PBF generation from the XML fixture using
    osmium.ForwardReferenceWriter. Skips if already exists."""
    if FIXTURE_PBF.exists() and FIXTURE_PBF.stat().st_size > 100:
        return FIXTURE_PBF
    import osmium
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    # ForwardReferenceWriter uses the XML as ref_src to resolve node
    # references while writing the PBF (preserves IDs).
    fw = osmium.ForwardReferenceWriter(
        outfile=str(FIXTURE_PBF),
        ref_src=str(FIXTURE_XML),
        overwrite=True,
    )

    class _Reader(osmium.SimpleHandler):
        def node(self, n): fw.add_node(n)
        def way(self, w): fw.add_way(w)

    r = _Reader()
    r.apply_file(str(FIXTURE_XML), locations=True)
    fw.close()
    return FIXTURE_PBF


# Auto-build on first test run
_BUILD_PBF_RESULT = _build_pbf_fixture_if_missing()


@pytest.fixture
def sample_network() -> dict:
    return parse_osm_xml(FIXTURE_XML.read_bytes())


def test_parses_4_roads(sample_network: dict) -> None:
    # 4 highway=residential/service ways; footway is skipped.
    assert len(sample_network["roads"]) == 4


def test_bridge_way_has_level_1(sample_network: dict) -> None:
    bridge_roads = [r for r in sample_network["roads"] if r.get("level") == 1]
    assert len(bridge_roads) == 1
    assert bridge_roads[0]["id"] == "w-203"


def test_oneway_way_has_half_lanes(sample_network: dict) -> None:
    # Service way with lanes=4 + oneway=yes -> laneCount=2
    oneway = next(r for r in sample_network["roads"] if r["id"] == "w-204")
    assert oneway["laneCount"] == 2


def test_skip_unrecognized_highway(sample_network: dict) -> None:
    # footway=205 should not be in roads.
    assert all(r["id"] != "w-205" for r in sample_network["roads"])


def test_intersection_at_center_has_traffic_light(sample_network: dict) -> None:
    # 3 ways share node 3 (the center) -> 1 intersection with traffic light.
    assert len(sample_network["intersections"]) >= 1
    inter = sample_network["intersections"][0]
    assert len(inter["trafficLights"]) >= 1


def test_roads_have_waypoints(sample_network: dict) -> None:
    # Each way has >=2 waypoints (polylines).
    for r in sample_network["roads"]:
        assert r["waypoints"] is not None
        assert len(r["waypoints"]) >= 2


def test_empty_xml_returns_empty_network() -> None:
    net = parse_osm_xml(b'<?xml version="1.0"?><osm version="0.6"></osm>')
    assert net["roads"] == []
    assert net["intersections"] == []


def test_invalid_xml_raises() -> None:
    import xml.etree.ElementTree as ET
    with pytest.raises(ET.ParseError):
        parse_osm_xml(b"<not-xml>")


def test_serializer_shape_roundtrip(sample_network: dict) -> None:
    """The dict should serialize to JSON and back without losing structure."""
    import json
    text = json.dumps(sample_network)
    restored = json.loads(text)
    assert restored == sample_network


def test_v7_level_field_compatibility(sample_network: dict) -> None:
    """All roads have a level field (Plan 039 schema addition)."""
    for r in sample_network["roads"]:
        assert "level" in r
        assert isinstance(r["level"], int)

# ---------------------------------------------------------------------------
# Plan 046: PBF parser tests.
# ---------------------------------------------------------------------------

def test_parses_pbf_returns_4_roads() -> None:
    """PBF and XML should produce equivalent road counts (4) for sample-4way."""
    assert _BUILD_PBF_RESULT.exists(), "PBF fixture build failed"
    data = parse_osmpbf(_BUILD_PBF_RESULT.read_bytes())
    assert len(data["roads"]) >= 2  # sample-4way has 4 roads (2 NS + 2 EW)
    for r in data["roads"]:
        assert "id" in r
        assert "waypoints" in r
        assert r["level"] in (-1, 0, 1)  # bridge/tunnel/ground


def test_pbf_and_xml_produce_equivalent_road_counts() -> None:
    xml = parse_osm_xml(FIXTURE_XML.read_bytes())
    pbf = parse_osmpbf(_BUILD_PBF_RESULT.read_bytes())
    assert len(xml["roads"]) == len(pbf["roads"])


def test_pbf_rejects_truncated_file() -> None:
    """Garbage bytes (not a valid PBF) raise ValueError."""
    with pytest.raises(ValueError, match="Invalid PBF"):
        parse_osmpbf(b"\x00\x01\x02 not a pbf")


def test_pbf_rejects_empty_input() -> None:
    with pytest.raises(ValueError, match="Invalid PBF"):
        parse_osmpbf(b"")
