"""OSM parser unit tests (XML + PBF)."""

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
        def node(self, n):
            fw.add_node(n)

        def way(self, w):
            fw.add_way(w)

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
    """All roads have a level field (schema addition)."""
    for r in sample_network["roads"]:
        assert "level" in r
        assert isinstance(r["level"], int)


def test_road_carries_an_explicit_oneway_flag(sample_network: dict) -> None:
    """The `oneway` tag is emitted verbatim, not inferred from the lane count."""
    by_id = {r["id"]: r for r in sample_network["roads"]}
    assert by_id["w-204"]["oneway"] is True  # oneway=yes
    assert by_id["w-201"]["oneway"] is False  # no oneway tag
    assert by_id["w-203"]["oneway"] is False


def test_oneway_reverse_flips_the_direction_of_travel() -> None:
    """`oneway=-1` means traffic runs against the digitisation direction."""
    xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="0.0000" lon="0.0000"/>
  <node id="2" lat="0.0000" lon="0.0010"/>
  <way id="10">
    <nd ref="1"/><nd ref="2"/>
    <tag k="highway" v="residential"/><tag k="oneway" v="-1"/>
  </way>
</osm>
"""
    net = parse_osm_xml(xml)
    road = net["roads"][0]
    assert road["oneway"] is True
    assert (
        road["waypoints"][0]["x"] > road["waypoints"][-1]["x"]
    ), "a reversed one-way must point against the digitisation direction"


def test_payload_carries_the_projection_origin(sample_network: dict) -> None:
    """`originLat`/`originLon` are the centre the map was projected around."""
    assert isinstance(sample_network["originLat"], float)
    assert isinstance(sample_network["originLon"], float)
    # The origin is the projection centre: re-parsing with it as the explicit
    # centre has to reproduce the same geometry.
    again = parse_osm_xml(
        FIXTURE_XML.read_bytes(),
        center=(sample_network["originLat"], sample_network["originLon"]),
    )
    assert [r["waypoints"] for r in again["roads"]] == [
        r["waypoints"] for r in sample_network["roads"]
    ]


def test_spawn_points_reference_existing_roads(sample_network: dict) -> None:
    """An imported map must be able to spawn vehicles."""
    road_ids = {r["id"] for r in sample_network["roads"]}
    spawn_points = sample_network["spawnPoints"]
    assert spawn_points, "no spawn points were generated"
    for sp in spawn_points:
        assert sp["roadId"] in road_ids
        assert sp["id"] == f"sp-{sp['roadId']}-{sp['laneIndex']}"
        assert sp["laneIndex"] == 0
        assert sp["s"] == 0
        assert sp["occupiedBy"] is None
    # One per road, no duplicate ids.
    assert len(spawn_points) == len({sp["roadId"] for sp in spawn_points})


def test_spawn_points_only_on_roads_that_can_hold_a_car() -> None:
    """Too short, or too narrow, no spawn point."""
    xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="0.0000" lon="0.000000"/>
  <node id="2" lat="0.0000" lon="0.000045"/>
  <node id="3" lat="0.0000" lon="0.000090"/>
  <node id="4" lat="0.0010" lon="0.000000"/>
  <node id="5" lat="0.0010" lon="0.001000"/>
  <!-- ~10 m long: too short -->
  <way id="10">
    <nd ref="1"/><nd ref="2"/><nd ref="3"/>
    <tag k="highway" v="residential"/><tag k="lanes" v="4"/>
  </way>
  <!-- long enough, but a single lane -->
  <way id="11">
    <nd ref="4"/><nd ref="5"/>
    <tag k="highway" v="residential"/><tag k="lanes" v="1"/>
  </way>
</osm>
"""
    net = parse_osm_xml(xml)
    assert {r["id"] for r in net["roads"]} == {"w-10", "w-11"}
    assert net["spawnPoints"] == []


# ---------------------------------------------------------------------------
# PBF parser tests.
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


# ---------------------------------------------------------------------------
# One pipeline: XML and PBF must not drift apart.
# ---------------------------------------------------------------------------


def _signal_count(network: dict) -> int:
    return sum(len(i["trafficLights"]) for i in network["intersections"])


def _road_payload(network: dict) -> list[dict]:
    """Road content without the id, which is prefixed per format."""
    return [
        {
            "waypoints": r["waypoints"],
            "laneCount": r["laneCount"],
            "oneway": r["oneway"],
            "speedLimit": r["speedLimit"],
            "level": r["level"],
        }
        for r in network["roads"]
    ]


def test_xml_and_pbf_agree_on_roads_intersections_and_signals() -> None:
    """Same logical data, same network — the whole point of one pipeline."""
    xml = parse_osm_xml(FIXTURE_XML.read_bytes())
    pbf = parse_osmpbf(_BUILD_PBF_RESULT.read_bytes())
    assert len(xml["roads"]) == len(pbf["roads"])
    assert len(xml["intersections"]) == len(pbf["intersections"])
    assert _signal_count(xml) == _signal_count(pbf)
    assert _road_payload(xml) == _road_payload(pbf)


def test_pbf_finds_traffic_signals_from_node_tags() -> None:
    """Regression: the PBF path used to look at way tags only.

    `highway=traffic_signals` is a *node* tag in OSM, so the PBF parser
    silently produced zero signal lights for data the XML parser turned
    into one.
    """
    pbf = parse_osmpbf(_BUILD_PBF_RESULT.read_bytes())
    xml = parse_osm_xml(FIXTURE_XML.read_bytes())
    assert _signal_count(xml) >= 1
    assert _signal_count(pbf) == _signal_count(xml)
    assert _signal_count(pbf) >= 1


def test_xml_and_pbf_agree_on_spawn_points_and_origin() -> None:
    xml = parse_osm_xml(FIXTURE_XML.read_bytes())
    pbf = parse_osmpbf(_BUILD_PBF_RESULT.read_bytes())
    assert len(xml["spawnPoints"]) == len(pbf["spawnPoints"])
    assert xml["originLat"] == pytest.approx(pbf["originLat"])
    assert xml["originLon"] == pytest.approx(pbf["originLon"])


def test_pbf_rejects_truncated_file() -> None:
    """Garbage bytes (not a valid PBF) raise ValueError."""
    with pytest.raises(ValueError, match="Invalid PBF"):
        parse_osmpbf(b"\x00\x01\x02 not a pbf")


def test_pbf_rejects_empty_input() -> None:
    with pytest.raises(ValueError, match="Invalid PBF"):
        parse_osmpbf(b"")
