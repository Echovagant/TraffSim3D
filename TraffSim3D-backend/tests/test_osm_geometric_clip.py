"""Geometric clipping: the region bounds the *geometry*, not just the ways.

The old rule kept a way that touched the region **whole**. That made the
promise the UI makes (「只加载仿真区域」) untrue: on the Shenzhen extract a
2.2 km request came back with a 7.9 km network, because one arterial way
that merely touched the region stretched the whole map.

The rule now: the geometry is cut at the region border.

* a way that crosses the region ends where it leaves it — both of its
  endpoints sit exactly on the border;
* a way that lies entirely inside keeps its geometry and its id untouched;
* a way that lies entirely outside is dropped;
* a way that enters the region, leaves it and comes back becomes **two**
  roads: `w-<id>` and `w-<id>-2`;
* every waypoint of every road lies inside the requested rectangle.

All the fixtures are projected around an explicit origin of (0, 0), so
the numbers are exact: `x = lon * 111000` (cos(0) == 1) and
`z = lat * 111000`.
"""

from __future__ import annotations

import pytest

from app.apps.maps.osm_parser import LEVEL_HEIGHT, parse_osm_xml

# The region under test: 0.01 deg of longitude by 0.02 deg of latitude.
REGION = (0.0, 0.0, 0.02, 0.01)  # (south, west, north, east)
REGION_X = (0.0, 1110.0)  # metres
REGION_Z = (0.0, 2220.0)  # metres
ORIGIN = (0.0, 0.0)

# A way crossing the region west to east, a way entirely inside it, and
# two ways entirely outside it (one east, one north).
MIXED_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="0.01" lon="-0.01"/>
  <node id="2" lat="0.01" lon="0.005"/>
  <node id="3" lat="0.01" lon="0.02"/>
  <way id="10">
    <nd ref="1"/><nd ref="2"/><nd ref="3"/>
    <tag k="highway" v="residential"/>
  </way>

  <node id="4" lat="0.01" lon="0.002"/>
  <node id="5" lat="0.01" lon="0.008"/>
  <way id="20">
    <nd ref="4"/><nd ref="5"/>
    <tag k="highway" v="residential"/>
  </way>

  <node id="6" lat="0.01" lon="0.05"/>
  <node id="7" lat="0.01" lon="0.06"/>
  <way id="30">
    <nd ref="6"/><nd ref="7"/>
    <tag k="highway" v="residential"/>
  </way>

  <node id="8" lat="0.05" lon="0.005"/>
  <node id="9" lat="0.05" lon="0.01"/>
  <way id="40">
    <nd ref="8"/><nd ref="9"/>
    <tag k="highway" v="residential"/>
  </way>
</osm>
"""

# One way that enters the region, leaves it and comes back.
REENTRY_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="0.01" lon="0.002"/>
  <node id="2" lat="0.01" lon="0.030"/>
  <node id="3" lat="0.01" lon="0.008"/>
  <way id="10">
    <nd ref="1"/><nd ref="2"/><nd ref="3"/>
    <tag k="highway" v="residential"/>
  </way>
</osm>
"""

# Two ways that meet exactly ON the border: their crossing point is a cut
# point, not a shared OSM node, so the border must not become a junction.
BORDER_CROSS_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="0.01" lon="0.005"/>
  <node id="2" lat="0.01" lon="0.015"/>
  <node id="3" lat="0.005" lon="0.01"/>
  <node id="4" lat="0.015" lon="0.01"/>
  <way id="10">
    <nd ref="1"/><nd ref="2"/>
    <tag k="highway" v="residential"/>
  </way>
  <way id="20">
    <nd ref="3"/><nd ref="4"/>
    <tag k="highway" v="residential"/>
  </way>
</osm>
"""

# An interior cross: the two ways share an OSM node inside the region.
INTERIOR_CROSS_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="0.005" lon="0.005"/>
  <node id="2" lat="0.015" lon="0.005"/>
  <node id="3" lat="0.005" lon="0.015"/>
  <way id="10">
    <nd ref="1"/><nd ref="2"/>
    <tag k="highway" v="residential"/>
  </way>
  <way id="20">
    <nd ref="1"/><nd ref="3"/>
    <tag k="highway" v="residential"/>
  </way>
</osm>
"""

# The same crossing way, one level up (a bridge).
BRIDGE_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="0.01" lon="-0.01"/>
  <node id="2" lat="0.01" lon="0.005"/>
  <node id="3" lat="0.01" lon="0.02"/>
  <way id="10">
    <nd ref="1"/><nd ref="2"/><nd ref="3"/>
    <tag k="highway" v="residential"/>
    <tag k="bridge" v="yes"/>
  </way>
</osm>
"""

# A one-way that runs against its digitisation direction: the way is drawn
# east to west, and the traffic runs west to east.
REVERSED_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="0.01" lon="0.02"/>
  <node id="2" lat="0.01" lon="0.005"/>
  <node id="3" lat="0.01" lon="-0.01"/>
  <way id="10">
    <nd ref="1"/><nd ref="2"/><nd ref="3"/>
    <tag k="highway" v="residential"/>
    <tag k="oneway" v="-1"/>
  </way>
</osm>
"""


def _parse(xml: bytes, bbox: tuple[float, float, float, float] | None = REGION) -> dict:
    return parse_osm_xml(xml, bbox=bbox, center=ORIGIN)


def _road(network: dict, road_id: str) -> dict:
    matches = [r for r in network["roads"] if r["id"] == road_id]
    assert matches, f"no road {road_id} in {[r['id'] for r in network['roads']]}"
    return matches[0]


def _xs(road: dict) -> list[float]:
    return [float(wp["x"]) for wp in road["waypoints"]]


def _zs(road: dict) -> list[float]:
    return [float(wp["z"]) for wp in road["waypoints"]]


# ---------------------------------------------------------------------------
# The cut itself.
# ---------------------------------------------------------------------------


def test_a_way_crossing_the_border_is_cut_at_it() -> None:
    """Both endpoints of the cut road sit exactly on the border.

    The way runs from x = -1110 m to x = +2220 m through a region that
    spans x ∈ [0, 1110] m, so the clipped road starts on the western edge
    and ends on the eastern one — and its extent along x is the region's.
    """
    net = _parse(MIXED_XML)
    road = _road(net, "w-10")
    xs = _xs(road)
    assert xs[0] == pytest.approx(REGION_X[0], abs=1e-6)
    assert xs[-1] == pytest.approx(REGION_X[1], abs=1e-6)
    assert max(xs) - min(xs) == pytest.approx(REGION_X[1] - REGION_X[0], abs=1e-6)
    # The interior vertex survived untouched.
    assert xs[1] == pytest.approx(555.0, abs=1e-6)


def test_a_way_entirely_inside_is_untouched() -> None:
    """Same waypoints, same id — the clip does not touch it."""
    clipped = _parse(MIXED_XML)
    full = parse_osm_xml(MIXED_XML, center=ORIGIN)
    clipped_road = _road(clipped, "w-20")
    full_road = _road(full, "w-20")
    assert clipped_road["waypoints"] == full_road["waypoints"]
    assert clipped_road["startNode"] == full_road["startNode"]
    assert clipped_road["endNode"] == full_road["endNode"]
    assert clipped_road["laneCount"] == full_road["laneCount"]


def test_a_way_entirely_outside_is_dropped() -> None:
    """A road that never reaches the region does not survive it."""
    net = _parse(MIXED_XML)
    ids = {r["id"] for r in net["roads"]}
    assert "w-30" not in ids  # east of the region
    assert "w-40" not in ids  # north of the region


def test_a_way_that_leaves_and_comes_back_becomes_two_roads() -> None:
    """Enter, leave, re-enter: two roads, numbered in travel order."""
    net = _parse(REENTRY_XML)
    ids = [r["id"] for r in net["roads"]]
    assert ids == ["w-10", "w-10-2"]

    first = _road(net, "w-10")
    second = _road(net, "w-10-2")
    # The first fragment runs from the node inside the region to the
    # eastern border; the second runs back from that border into it.
    assert _xs(first)[0] == pytest.approx(222.0, abs=1e-6)
    assert _xs(first)[-1] == pytest.approx(REGION_X[1], abs=1e-6)
    assert _xs(second)[0] == pytest.approx(REGION_X[1], abs=1e-6)
    assert _xs(second)[-1] == pytest.approx(888.0, abs=1e-6)


def test_the_regions_extent_is_honoured_by_every_waypoint() -> None:
    """Every waypoint of every road lies inside the requested rectangle.

    This is the property the product depends on: the camera frames the
    requested area, so nothing may stick out of it.
    """
    net = _parse(MIXED_XML)
    assert net["roads"]
    for road in net["roads"]:
        for x, z in zip(_xs(road), _zs(road), strict=True):
            assert REGION_X[0] - 1e-6 <= x <= REGION_X[1] + 1e-6, road["id"]
            assert REGION_Z[0] - 1e-6 <= z <= REGION_Z[1] + 1e-6, road["id"]


def test_the_network_never_reaches_further_than_the_region() -> None:
    """The whole network fits in the region — the camera's framing."""
    net = _parse(MIXED_XML)
    xs = [float(wp["x"]) for r in net["roads"] for wp in r["waypoints"]]
    zs = [float(wp["z"]) for r in net["roads"] for wp in r["waypoints"]]
    assert max(xs) - min(xs) <= REGION_X[1] - REGION_X[0] + 1e-6
    assert max(zs) - min(zs) <= REGION_Z[1] - REGION_Z[0] + 1e-6


# ---------------------------------------------------------------------------
# The border is not a junction; an interior junction still is.
# ---------------------------------------------------------------------------


def test_the_border_never_becomes_a_junction() -> None:
    """Two ways cut at the same border point share no OSM node.

    Their crossing point is a cut point — an interpolated position, not a
    node — so it must not become an intersection.
    """
    net = _parse(BORDER_CROSS_XML)
    assert len(net["roads"]) == 2
    assert net["intersections"] == []


def test_an_interior_junction_still_is_one() -> None:
    """A node shared by two ways inside the region is still a junction."""
    net = _parse(INTERIOR_CROSS_XML)
    assert len(net["roads"]) == 2
    assert len(net["intersections"]) == 1
    intersection = net["intersections"][0]
    assert set(intersection["connectedRoads"]) == {"w-10", "w-20"}
    assert intersection["position"]["x"] == pytest.approx(555.0, abs=1e-6)
    assert intersection["position"]["z"] == pytest.approx(555.0, abs=1e-6)


# ---------------------------------------------------------------------------
# The height of a cut point.
# ---------------------------------------------------------------------------


def test_a_cut_point_inherits_the_height_of_its_nearest_node() -> None:
    """A bridge stays a bridge at the border; the ground stays ground.

    The cut point is not an OSM node, so it cannot invent a level of its
    own — it takes the level of the nearest original node.
    """
    bridge = _parse(BRIDGE_XML)
    road = _road(bridge, "w-10")
    assert road["level"] == 1
    assert all(float(wp["y"]) == pytest.approx(LEVEL_HEIGHT) for wp in road["waypoints"])

    ground = _parse(MIXED_XML)
    ground_road = _road(ground, "w-10")
    assert ground_road["level"] == 0
    assert all(float(wp["y"]) == pytest.approx(0.0) for wp in ground_road["waypoints"])


# ---------------------------------------------------------------------------
# The pieces come out in travel order.
# ---------------------------------------------------------------------------


def test_a_reversed_one_way_is_cut_in_the_travel_direction() -> None:
    """`oneway=-1` is decided *before* the clip, so the road runs the
    way cars drive it.

    The way is drawn east to west, the traffic runs west to east — so the
    clipped road starts on the western border and ends on the eastern one.
    Had the clip run on the digitisation order, the two ends would be
    swapped.
    """
    net = _parse(REVERSED_XML)
    road = _road(net, "w-10")
    assert road["oneway"] is True
    assert _xs(road)[0] == pytest.approx(REGION_X[0], abs=1e-6)
    assert _xs(road)[-1] == pytest.approx(REGION_X[1], abs=1e-6)
    assert road["startNode"]["x"] == pytest.approx(REGION_X[0], abs=1e-6)
    assert road["endNode"]["x"] == pytest.approx(REGION_X[1], abs=1e-6)


# ---------------------------------------------------------------------------
# A region with no area.
# ---------------------------------------------------------------------------


def test_a_zero_area_region_yields_no_roads() -> None:
    """A zero-extent box is a line, not an area: nothing survives it."""
    net = parse_osm_xml(MIXED_XML, bbox=(0.01, 0.005, 0.01, 0.005), center=ORIGIN)
    assert net["roads"] == []
    assert net["intersections"] == []
    assert net["spawnPoints"] == []
