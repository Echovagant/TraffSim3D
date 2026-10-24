"""OSM parser unit tests (XML + PBF)."""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from app.apps.maps.osm_parser import (
    INTERSECTION_CLEARANCE_M,
    MAX_INTERSECTION_OFFSET_M,
    ROAD_LANE_WIDTH,
    _project_intersection_on_road,
    _project_onto_polyline,
    _spawn_arc_length,
    junction_radius,
    parse_osm_xml,
    parse_osmpbf,
)

FIXTURE_DIR = Path(__file__).parent / "fixtures"
FIXTURE_XML = FIXTURE_DIR / "sample-4way.osm"
FIXTURE_PBF = FIXTURE_DIR / "sample-4way.osm.pbf"

# The longest vehicle in the fleet (the 9 m bus). Its nose may overhang
# the stop line by half its length, because the stop rule acts on the
# vehicle's centre — which is what the clearance is for.
LONGEST_VEHICLE_M = 9.0


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
    lengths = {r["id"]: _road_length(r) for r in sample_network["roads"]}
    spawn_points = sample_network["spawnPoints"]
    assert spawn_points, "no spawn points were generated"
    for sp in spawn_points:
        assert sp["roadId"] in road_ids
        assert sp["id"] == f"sp-{sp['roadId']}-{sp['laneIndex']}"
        assert sp["laneIndex"] == 0
        # The spawn point is on the road, and it is not at the travel end:
        # the simulation treats a road as a loop, so a car that starts at
        # the travel end is teleported straight back to s ≈ 0.
        assert 0.0 <= sp["s"] < lengths[sp["roadId"]]
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


# ---------------------------------------------------------------------------
# Where the junction is, and where the cars appear.
#
# The regression these lock down: the backend hard-coded every spawn point
# at `s = 0` (the road's start) and had no way to know where a junction sat
# on the road. Both are wrong for an imported OSM map — a junction is an OSM
# node *shared* by two ways, so it sits at a way **endpoint**, and `s = 0`
# is therefore usually right inside the junction.
# ---------------------------------------------------------------------------

REAL_OSM_FIXTURE = Path(__file__).parent.parent / "geojson" / "福田中心(深圳).osm"


def _road_length(road: dict) -> float:
    """The road's polyline length, computed the way the parser does."""
    total = 0.0
    for a, b in zip(road["waypoints"], road["waypoints"][1:], strict=False):
        total += math.dist((a["x"], a["y"], a["z"]), (b["x"], b["y"], b["z"]))
    return total


def _spawn_point_for(network: dict, road_id: str) -> dict:
    matches = [sp for sp in network["spawnPoints"] if sp["roadId"] == road_id]
    assert matches, f"no spawn point was generated for {road_id}"
    return matches[0]


def _straight_road(x0: float, x1: float) -> dict:
    """A 2-waypoint road running east from `x0` to `x1` (metres)."""
    return {
        "id": "w-1",
        "waypoints": [
            {"x": x0, "y": 0.0, "z": 0.0},
            {"x": x1, "y": 0.0, "z": 0.0},
        ],
    }


def test_projection_returns_the_arc_length_on_a_polyline() -> None:
    """An L-shaped road: the result is the *path* length, not the
    straight-line distance to the junction."""
    road = {
        "id": "w-1",
        "waypoints": [
            {"x": 0.0, "y": 0.0, "z": 0.0},
            {"x": 100.0, "y": 0.0, "z": 0.0},
            {"x": 100.0, "y": 0.0, "z": 100.0},
        ],
    }
    s, distance = _project_onto_polyline(road["waypoints"], 100.0, 50.0)
    assert distance == pytest.approx(0.0)
    assert s == pytest.approx(150.0)  # 100 m east + 50 m north


def test_projection_picks_the_segment_with_the_smallest_perpendicular() -> None:
    """Not the first segment — the closest one."""
    road = {
        "id": "w-1",
        "waypoints": [
            {"x": 0.0, "y": 0.0, "z": 0.0},
            {"x": 100.0, "y": 0.0, "z": 0.0},
            {"x": 100.0, "y": 0.0, "z": 100.0},
        ],
    }
    # (90, 90) is 90 m off the first segment but only 10 m off the second.
    s, distance = _project_onto_polyline(road["waypoints"], 90.0, 90.0)
    assert distance == pytest.approx(10.0)
    assert s == pytest.approx(190.0)  # 100 m east + 90 m north


def test_projection_is_invariant_to_the_z_sign_convention() -> None:
    """The backend's Z is north-positive, the frontend's north-negative.

    The projection is invariant under `z -> -z`: the perpendicular
    distance is a square, and the segment parameter is a product of two
    factors that flip sign together. The same junction therefore projects
    onto the same arc length in either frame — no sign fix-up is needed
    (a *signed* along-road offset would need one; nothing here is signed).
    """
    road = _straight_road(0.0, 100.0)
    s_north, d_north = _project_onto_polyline(road["waypoints"], 30.0, 5.0)
    s_south, d_south = _project_onto_polyline(road["waypoints"], 30.0, -5.0)
    assert s_north == pytest.approx(30.0)
    assert d_north == pytest.approx(5.0)
    assert s_north == pytest.approx(s_south)
    assert d_north == pytest.approx(d_south)


def test_projection_rejects_an_intersection_further_than_the_threshold() -> None:
    """Beyond `MAX_INTERSECTION_OFFSET_M` the road midpoint is used.

    The road is deliberately asymmetric (0..200 m) so the fallback (the
    midpoint, 100 m) cannot be confused with the projection (10 m).

    The distances below are **literals on purpose** — a test that derived
    its own case from the constant would still pass when the constant is
    mutated, and the threshold would then be untested.
    """
    road = _straight_road(0.0, 200.0)
    inside = {"position": {"x": 10.0, "y": 0.0, "z": 20.0}, "connectedRoads": ["w-1"]}
    outside = {"position": {"x": 10.0, "y": 0.0, "z": 100.0}, "connectedRoads": ["w-1"]}
    s, projected = _project_intersection_on_road(road, inside)
    assert projected is True
    assert s == pytest.approx(10.0)

    s, projected = _project_intersection_on_road(road, outside)
    assert projected is False
    assert s == pytest.approx(100.0)  # the road midpoint, not the projection


def test_the_projection_threshold_matches_the_frontend() -> None:
    """The backend and the frontend must reject the same projections.

    `MAX_INTERSECTION_OFFSET_M` mirrors the frontend's constant of the
    same name (`TraffSim3D-frontend/src/domain/services/laneGeometry.ts`).
    If the two drifted apart, the frontend would place a stop line where
    the backend believes there is no junction.
    """
    assert MAX_INTERSECTION_OFFSET_M == 30.0


def test_degenerate_geometry_falls_back_instead_of_dividing_by_zero() -> None:
    """Empty, single-point and duplicated-waypoint roads."""
    # Nothing to project onto.
    assert _project_onto_polyline([], 10.0, 10.0) == (0.0, math.inf)
    assert _project_onto_polyline([{"x": 0.0, "y": 0.0, "z": 0.0}], 10.0, 10.0) == (0.0, math.inf)

    # A duplicated waypoint in the middle of the polyline: the degenerate
    # segment is skipped, the real one still projects.
    waypoints = [
        {"x": 0.0, "y": 0.0, "z": 0.0},
        {"x": 0.0, "y": 0.0, "z": 0.0},
        {"x": 100.0, "y": 0.0, "z": 0.0},
    ]
    s, distance = _project_onto_polyline(waypoints, 40.0, 0.0)
    assert s == pytest.approx(40.0)
    assert distance == pytest.approx(0.0)

    # A road of zero length cannot carry a junction.
    flat = {"id": "w-1", "waypoints": [{"x": 0.0, "y": 0.0, "z": 0.0}] * 2}
    junction = {"position": {"x": 0.0, "y": 0.0, "z": 0.0}, "connectedRoads": ["w-1"]}
    assert _project_intersection_on_road(flat, junction) == (0.0, False)
    assert _spawn_arc_length(flat, [junction]) == 0.0


def test_spawn_goes_to_the_far_end_when_the_junction_is_at_the_road_start() -> None:
    """The junction is a node shared by two ways — here node 1, which is
    also the *start* of w-10. The car must not appear there."""
    xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="0.0000" lon="0.0000"/>
  <node id="2" lat="0.0000" lon="0.0010"/>
  <node id="3" lat="0.0010" lon="0.0000"/>
  <way id="10">
    <nd ref="1"/><nd ref="2"/>
    <tag k="highway" v="residential"/><tag k="lanes" v="4"/>
  </way>
  <way id="11">
    <nd ref="1"/><nd ref="3"/>
    <tag k="highway" v="residential"/><tag k="lanes" v="4"/>
  </way>
</osm>
"""
    net = parse_osm_xml(xml)
    assert len(net["intersections"]) == 1
    road = next(r for r in net["roads"] if r["id"] == "w-10")
    sp = _spawn_point_for(net, "w-10")
    length = _road_length(road)

    # The junction is at s = 0, so the car must not be there.
    assert sp["s"] > 0
    # It is also not at the travel end: the simulation treats a road as a
    # loop and teleports a car that starts at the travel end straight back
    # to s ≈ 0 — which is the junction. The spawn point has to be clear
    # of both.
    assert sp["s"] < length - 1e-6
    # And it is clear of the junction's box.
    radius = float(net["intersections"][0]["intersectionRadius"])
    assert sp["s"] > radius
    # The shape of the spawn point did not change.
    assert sp["id"] == "sp-w-10-0"
    assert sp["laneIndex"] == 0
    assert sp["occupiedBy"] is None


def test_spawn_stays_at_zero_when_the_junction_is_in_the_middle() -> None:
    """A junction in the middle of the road: the spawn point goes to the
    open ground on one side of it, never into the junction's box."""
    xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="0.0000" lon="0.0000"/>
  <node id="2" lat="0.0000" lon="0.0005"/>
  <node id="3" lat="0.0000" lon="0.0010"/>
  <node id="4" lat="0.0005" lon="0.0005"/>
  <way id="10">
    <nd ref="1"/><nd ref="2"/><nd ref="3"/>
    <tag k="highway" v="residential"/><tag k="lanes" v="4"/>
  </way>
  <way id="11">
    <nd ref="2"/><nd ref="4"/>
    <tag k="highway" v="residential"/><tag k="lanes" v="4"/>
  </way>
</osm>
"""
    net = parse_osm_xml(xml)
    assert len(net["intersections"]) == 1
    road = next(r for r in net["roads"] if r["id"] == "w-10")
    sp = _spawn_point_for(net, "w-10")
    inter = net["intersections"][0]
    js, _ = _project_intersection_on_road(road, inter)
    radius = float(inter["intersectionRadius"])
    # Clear of the junction's box …
    assert abs(sp["s"] - js) - radius >= 0
    # … and not at the travel end.
    assert sp["s"] < _road_length(road) - 1e-6


def test_spawn_avoids_both_junctions_when_the_road_has_one_at_each_end() -> None:
    """A road with a junction at **both** ends.

    This is the common shape in a real network (1,187 of the 7,320 roads
    in the Shenzhen fixture): the way is a street between two
    crossroads. Neither end is usable, so the spawn point has to go to
    the middle of the road — and it must not land on the travel end,
    because the simulation treats a road as a loop and would teleport
    the car straight back to `s ≈ 0`.
    """
    xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="0.0000" lon="0.0000"/>
  <node id="2" lat="0.0000" lon="0.0010"/>
  <node id="3" lat="0.0000" lon="0.0020"/>
  <node id="4" lat="0.0010" lon="0.0000"/>
  <way id="10">
    <nd ref="1"/><nd ref="2"/><nd ref="3"/>
    <tag k="highway" v="residential"/><tag k="lanes" v="4"/>
  </way>
  <way id="11">
    <nd ref="1"/><nd ref="4"/>
    <tag k="highway" v="residential"/><tag k="lanes" v="4"/>
  </way>
  <way id="12">
    <nd ref="3"/><nd ref="4"/>
    <tag k="highway" v="residential"/><tag k="lanes" v="4"/>
  </way>
</osm>
"""
    net = parse_osm_xml(xml)
    road = next(r for r in net["roads"] if r["id"] == "w-10")
    length = _road_length(road)
    sp = _spawn_point_for(net, "w-10")

    # Clear of both ends' junctions …
    assert sp["s"] > 8
    assert sp["s"] < length - 8
    # … and not at the travel end, so the travel-end wrap does not fire.
    assert sp["s"] < length - 1e-6


def test_spawn_clears_the_junction_box_not_just_its_centre() -> None:
    """The spawn point has to clear the junction **box**, not only its
    centre.

    A junction with a wide box (a big intersection) reaches much further
    along the road than its centre does. Measuring the clearance to the
    centre would put the car inside the very box the intersection
    occupies — and the box is the area the traffic light governs.

    The fixture is built directly (rather than parsed from OSM) because
    the parser emits the same radius for every junction, and the point of
    this test is that the radius makes a difference.

    The geometry is chosen so the two ways of measuring the clearance
    disagree: a small junction at the start (radius 8) and a WIDE one at
    s = 60 (radius 50) on a 120 m road. Measured to the **box edge**,
    the stretch after the wide junction is the only clear ground, so the
    spawn point goes to s = 90. Measured to the junction **centre**,
    the midpoint between the two junctions (s = 30) looks attractive —
    and it is exactly the middle of the wide junction's box.
    """
    road = {
        "id": "w-1",
        "waypoints": [
            {"x": 0.0, "y": 0.0, "z": 0.0},
            {"x": 0.0, "y": 0.0, "z": 60.0},
            {"x": 0.0, "y": 0.0, "z": 120.0},
        ],
        "laneCount": 2,
        "speedLimit": 16.67,
        "level": 0,
    }
    intersections = [
        {
            "id": "i-small",
            "position": {"x": 0.0, "y": 0.0, "z": 0.0},
            "connectedRoads": ["w-1"],
            "intersectionRadius": 8,
        },
        {
            "id": "i-wide",
            "position": {"x": 0.0, "y": 0.0, "z": 60.0},
            "connectedRoads": ["w-1"],
            "intersectionRadius": 50,
        },
    ]

    s = _spawn_arc_length(road, intersections)

    # Clear of BOTH boxes — in particular not in the wide one, whose box
    # spans s ∈ [10, 110].
    for inter in intersections:
        radius = float(inter["intersectionRadius"])
        centre = 0.0 if inter["id"] == "i-small" else 60.0
        assert abs(s - centre) - radius >= 0, (
            f"spawn point {s} is inside the box of {inter['id']} "
            f"(centre {centre}, radius {radius})"
        )
    # And it is not the far end either.
    assert s < _road_length(road) - 1e-6


def test_spawn_never_lands_on_the_travel_end() -> None:
    """The spawn point is never the road's travel end.

    The simulation treats a road as a loop: a car that starts exactly at
    the travel end is teleported back to the start of the road on its
    first tick — which is where a junction usually is. The spawn point
    is therefore always strictly inside the road.
    """
    road = {
        "id": "w-1",
        "waypoints": [
            {"x": 0.0, "y": 0.0, "z": 0.0},
            {"x": 0.0, "y": 0.0, "z": 100.0},
        ],
        "laneCount": 2,
        "speedLimit": 16.67,
        "level": 0,
    }
    # A wide junction at the start covers s ∈ [0, 90]; the only open
    # ground is s ∈ (90, 100].
    intersections = [
        {
            "id": "i-wide",
            "position": {"x": 0.0, "y": 0.0, "z": 0.0},
            "connectedRoads": ["w-1"],
            "intersectionRadius": 90,
        }
    ]

    s = _spawn_arc_length(road, intersections)

    # Inside the open stretch …
    assert s > 90
    # … and strictly before the travel end.
    assert s < 100 - 1e-6


def test_spawn_stays_at_zero_on_a_road_without_any_junction() -> None:
    """No junction on the road → unchanged behaviour."""
    xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="0.0000" lon="0.0000"/>
  <node id="2" lat="0.0000" lon="0.0010"/>
  <way id="10">
    <nd ref="1"/><nd ref="2"/>
    <tag k="highway" v="residential"/><tag k="lanes" v="4"/>
  </way>
</osm>
"""
    net = parse_osm_xml(xml)
    assert net["intersections"] == []
    sp = _spawn_point_for(net, "w-10")
    assert sp["s"] == 0.0


def _count_spawn_points_in_junctions(network: dict, tolerance: float) -> int:
    """How many spawn points sit on top of a junction of their own road?

    The measure is the **road-frame** distance: the spawn point's arc
    length versus the projected arc length of the junction on the same
    road. That is the same coordinate the stop line lives in, so it is
    the question "is the car inside the junction the light governs?".
    """
    roads = {r["id"]: r for r in network["roads"]}
    hits = 0
    for sp in network["spawnPoints"]:
        road = roads[sp["roadId"]]
        for inter in network["intersections"]:
            if sp["roadId"] not in inter["connectedRoads"]:
                continue
            s, _ = _project_intersection_on_road(road, inter)
            if abs(sp["s"] - s) <= tolerance:
                hits += 1
                break
    return hits


@pytest.mark.skipif(
    not REAL_OSM_FIXTURE.exists(),
    reason="the real Shenzhen OSM extract is not checked in",
)
def test_real_map_spawns_fewer_cars_inside_a_junction() -> None:
    """End-to-end on the real extract: the old `s = 0` rule put a car
    into the junction on every way that started at one."""
    net = parse_osm_xml(REAL_OSM_FIXTURE.read_bytes())
    assert net["spawnPoints"], "the real map produced no spawn points"

    # The old behaviour, replayed on the same network: every spawn point
    # at the road's start.
    legacy = {
        "roads": net["roads"],
        "intersections": net["intersections"],
        "spawnPoints": [{**sp, "s": 0.0} for sp in net["spawnPoints"]],
    }
    before = _count_spawn_points_in_junctions(legacy, 5.0)
    after = _count_spawn_points_in_junctions(net, 5.0)
    assert after < before


# ---------------------------------------------------------------------------
# How big the junction box is.
#
# The regression these lock down: the backend wrote a hard-coded 8 m into
# every imported junction. That number is narrower than the carriageway of
# the road it is supposed to delimit (a 6-lane road is 21 m wide, so its
# half-width is 10.5 m) — so the outer lanes were never inside the box,
# and the intersection-occupancy rule never saw them. On top of that the
# stop rule acts on the vehicle's CENTRE, so a queued vehicle's nose may
# legitimately overhang by half its length and reach into the crossing
# carriageway.
#
# The rule (identical to the built-in scenes'):
#
#     radius = widest connected road's half-width + clearance
#     clearance = 4.5 m (half of the 9 m bus) — only where a queue can form
# ---------------------------------------------------------------------------


def test_mirrored_constants_match_the_frontend() -> None:
    """The two ends have to use the same numbers.

    `ROAD_LANE_WIDTH` is the width the frontend gives EVERY lane of EVERY
    road — imported ones included (`laneGeometry.ts` -> `lanePoint`), so
    it is the geometric truth in the app. `INTERSECTION_CLEARANCE_M` is
    half the longest vehicle (the 9 m bus), because the stop rule acts on
    the vehicle's centre and the nose may overhang by that much.

    The values are **literals on purpose**: a test that derived them from
    the constants would still pass when the constant is mutated.
    """
    assert ROAD_LANE_WIDTH == 3.5
    assert INTERSECTION_CLEARANCE_M == 4.5


def test_junction_radius_follows_the_lane_model() -> None:
    """The radius is the widest connected road's half-width (+ clearance).

    The numbers are literals on purpose — see above.
    """
    # 6 lanes x 3.5 m = 21 m wide -> half-width 10.5 m.
    assert junction_radius([6], signalised=True) == 15.0
    assert junction_radius([6], signalised=False) == 10.5
    # 4 lanes -> 14 m wide -> half-width 7 m.
    assert junction_radius([4], signalised=True) == 11.5
    assert junction_radius([4], signalised=False) == 7.0
    # 2 lanes -> 7 m wide -> half-width 3.5 m.
    assert junction_radius([2], signalised=True) == 8.0
    # 1 lane -> 3.5 m wide -> half-width 1.75 m.
    assert junction_radius([1], signalised=True) == 6.25
    # The **widest** connected road decides: the box is shared by every
    # approach, so it has to hold the widest carriageway.
    assert junction_radius([1, 6], signalised=True) == 15.0
    assert junction_radius([6, 1], signalised=True) == 15.0
    # An empty junction still has a sane box.
    assert junction_radius([], signalised=True) == INTERSECTION_CLEARANCE_M + ROAD_LANE_WIDTH / 2


def test_a_signalised_junction_adds_the_clearance() -> None:
    """The clearance is what keeps a queued nose out of the crossing
    carriageway — so it is added exactly where a queue can form."""
    with_clearance = junction_radius([4], signalised=True)
    without = junction_radius([4], signalised=False)
    assert with_clearance - without == INTERSECTION_CLEARANCE_M
    assert with_clearance > without


CROSS_OSM = b"""<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="0.00000" lon="0.00000"/>
  <node id="2" lat="0.00050" lon="0.00000"/>
  <node id="3" lat="0.00100" lon="0.00000"/>
  <node id="4" lat="0.00050" lon="-0.00050"/>
  <node id="5" lat="0.00050" lon="0.00050"/>
  <way id="10">
    <nd ref="1"/><nd ref="2"/><nd ref="3"/>
    <tag k="highway" v="residential"/><tag k="lanes" v="4"/>
  </way>
  <way id="11">
    <nd ref="4"/><nd ref="2"/><nd ref="5"/>
    <tag k="highway" v="residential"/><tag k="lanes" v="4"/>
  </way>
</osm>
"""


def test_the_parsed_radius_is_derived_from_the_connected_roads() -> None:
    """End-to-end: the radius in the payload follows the lane model."""
    net = parse_osm_xml(CROSS_OSM)
    assert len(net["intersections"]) == 1
    inter = net["intersections"][0]
    lane_counts = {r["id"]: int(r["laneCount"]) for r in net["roads"]}
    widest = max(lane_counts[rid] for rid in inter["connectedRoads"])
    assert widest == 4
    # 4 lanes -> half-width 7 m, + the 4.5 m clearance.
    assert inter["intersectionRadius"] == pytest.approx(11.5)


def test_a_queued_vehicle_nose_clears_the_crossing_carriageway() -> None:
    """The geometry the radius exists for.

    The stop line sits on the box edge (`stopLineSOnRoad` =
    `centreS +/- radius`), so a vehicle waiting at it has its **centre**
    on the edge and its **nose** half a vehicle length further on. That
    nose must not reach into the crossing carriageway — otherwise the
    crossing traffic drives into the queue.

    With the old hard-coded 8 m the 9 m bus's nose reached 3.5 m into
    the 14 m wide crossing road; with the derived radius it stops exactly
    at its edge.
    """
    net = parse_osm_xml(CROSS_OSM)
    inter = net["intersections"][0]
    radius = float(inter["intersectionRadius"])
    lane_counts = {r["id"]: int(r["laneCount"]) for r in net["roads"]}
    crossing_half_width = max(
        lane_counts[rid] * ROAD_LANE_WIDTH / 2 for rid in inter["connectedRoads"]
    )

    # The forward approach of the NS road (w-10) stops `radius` before
    # the junction's centre.
    road = next(r for r in net["roads"] if r["id"] == "w-10")
    centre_s, _ = _project_intersection_on_road(road, inter)
    stop_s = centre_s - radius
    nose_s = stop_s + LONGEST_VEHICLE_M / 2  # the centre stops on the line

    # The nose has to stay outside the crossing carriageway …
    assert centre_s - nose_s >= crossing_half_width
    # … and the box has to hold the carriageway in the first place.
    assert radius >= crossing_half_width
    # The clearance is what buys that last inequality.
    assert radius == pytest.approx(crossing_half_width + INTERSECTION_CLEARANCE_M)


def test_a_road_without_any_open_stretch_gets_no_spawn_point() -> None:
    """The defined rule for a road that is covered by junction boxes.

    A wider box (sized by the lane model) reaches further along the
    road, so a short link between two junctions can end up covered from
    end to end. There is then no point on it that is outside every box,
    and a car may not start inside an intersection — so the road gets NO
    spawn point. That is a rule, not an accident: the old code parked
    the car on the box edge, i.e. inside the junction.
    """
    xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="0.00000" lon="0.00000"/>
  <node id="2" lat="0.00000" lon="0.00019"/>
  <node id="3" lat="0.00100" lon="0.00000"/>
  <node id="4" lat="0.00100" lon="0.00019"/>
  <way id="10">
    <nd ref="1"/><nd ref="2"/>
    <tag k="highway" v="residential"/><tag k="lanes" v="4"/>
  </way>
  <way id="11">
    <nd ref="1"/><nd ref="3"/>
    <tag k="highway" v="residential"/><tag k="lanes" v="4"/>
  </way>
  <way id="12">
    <nd ref="2"/><nd ref="4"/>
    <tag k="highway" v="residential"/><tag k="lanes" v="4"/>
  </way>
</osm>
"""
    net = parse_osm_xml(xml)
    road = next(r for r in net["roads"] if r["id"] == "w-10")
    length = _road_length(road)
    # The road is long enough to hold a car …
    assert length >= 20.0
    # … but both ends have a 4-lane junction, so the boxes cover it.
    radius = max(float(i["intersectionRadius"]) for i in net["intersections"])
    assert 2 * radius > length

    # No spawn point — instead of one inside a junction.
    assert not [sp for sp in net["spawnPoints"] if sp["roadId"] == "w-10"]
    # And the helper agrees: there is no legal place to start a car.
    assert _spawn_arc_length(road, net["intersections"]) is None


def test_a_spawn_point_never_lands_inside_a_junction_box() -> None:
    """The spawn placement rule under the wider boxes.

    Every spawn point has to be outside every junction box of its own
    road — measured to the box **edge**, which is what the traffic light
    governs.
    """
    net = parse_osm_xml(CROSS_OSM)
    roads = {r["id"]: r for r in net["roads"]}
    for sp in net["spawnPoints"]:
        road = roads[sp["roadId"]]
        for inter in net["intersections"]:
            if sp["roadId"] not in inter["connectedRoads"]:
                continue
            s, _ = _project_intersection_on_road(road, inter)
            radius = float(inter["intersectionRadius"])
            assert abs(sp["s"] - s) - radius >= 0


@pytest.mark.skipif(
    not REAL_OSM_FIXTURE.exists(),
    reason="the real Shenzhen OSM extract is not checked in",
)
def test_real_map_junction_boxes_hold_the_crossing_carriageway() -> None:
    """End-to-end on the real extract: every junction box is sized by
    the lane model, and no car starts inside one."""
    net = parse_osm_xml(REAL_OSM_FIXTURE.read_bytes())
    lane_counts = {r["id"]: int(r["laneCount"]) for r in net["roads"]}
    roads = {r["id"]: r for r in net["roads"]}

    for inter in net["intersections"]:
        widest = max(lane_counts[rid] for rid in inter["connectedRoads"] if rid in lane_counts)
        half_width = widest * ROAD_LANE_WIDTH / 2
        radius = float(inter["intersectionRadius"])
        # The box holds the crossing carriageway …
        assert radius >= half_width
        # … and leaves room for a queued nose.
        assert radius == pytest.approx(half_width + INTERSECTION_CLEARANCE_M)

    # No spawn point sits inside a junction box, and none sits at the
    # travel end (the simulation teleports such a car back to s ≈ 0).
    inside = 0
    at_end = 0
    for sp in net["spawnPoints"]:
        road = roads[sp["roadId"]]
        if sp["s"] >= _road_length(road) - 1e-6:
            at_end += 1
        for inter in net["intersections"]:
            if sp["roadId"] not in inter["connectedRoads"]:
                continue
            s, _ = _project_intersection_on_road(road, inter)
            if abs(sp["s"] - s) < float(inter["intersectionRadius"]):
                inside += 1
                break
    assert inside == 0
    assert at_end == 0
