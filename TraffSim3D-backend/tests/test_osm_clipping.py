"""Configurable map clipping (只加载仿真区域).

The parser used to hardcode `MAX_BBOX_DEG = 0.5` (~55 km) as a
memory-safety cap on oversized `.osm` files. That is not clipping: 55 km is
vastly larger than any simulation scene, the bound is not user-configurable,
and nothing in the API or UI can narrow it to the area actually being
simulated.

Clipping now takes an explicit bbox (degrees). The safety cap remains as the
default so an un-cropped call keeps behaving exactly as before.

The clip works on the **geometry**: a way that crosses the region is cut
where it leaves it, so both of its endpoints sit on the border, and a way
that lies entirely outside is dropped. A cut point is not an OSM node, so
the border never becomes a junction — only a node shared by two surviving
ways does.
"""

from __future__ import annotations

import math

import pytest

from app.apps.maps import osm_parser as p


def _projected_region(
    net: dict, bbox: tuple[float, float, float, float]
) -> tuple[float, float, float, float]:
    """The bbox as a rectangle in the network's own projection."""
    south, west, north, east = bbox
    origin_lat = float(net["originLat"])
    origin_lon = float(net["originLon"])
    cos_lat = math.cos(origin_lat * math.pi / 180.0)
    return (
        (west - origin_lon) * 111000.0 * cos_lat,
        (south - origin_lat) * 111000.0,
        (east - origin_lon) * 111000.0 * cos_lat,
        (north - origin_lat) * 111000.0,
    )


# Three east-west roads at clearly separated latitudes, so a bbox can select
# between them unambiguously (no shared boundary nodes):
#   w-10 at lat 0.00   (west band)
#   w-11 at lat 0.05   (middle band)
#   w-12 at lat 0.09   (far band — inside the default 0.5 deg safety cap)
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

# Keeps only w-10 (lat band 0.00); w-11 / w-12 are north of it.
BBOX_SOUTH_ONLY = (-0.01, -0.01, 0.01, 0.02)
# Keeps w-10 and w-11, drops w-12.
BBOX_SOUTH_AND_MIDDLE = (-0.01, -0.01, 0.06, 0.02)


def test_default_clip_keeps_everything_small() -> None:
    """No bbox argument => the historical 0.5 deg safety cap applies."""
    net = p.parse_osm_xml(GRID_XML)
    assert {r["id"] for r in net["roads"]} == {"w-10", "w-11", "w-12"}


def test_explicit_bbox_drops_far_ways() -> None:
    """A tight bbox around the origin must exclude the distant ways."""
    net = p.parse_osm_xml(GRID_XML, bbox=BBOX_SOUTH_AND_MIDDLE)
    assert {r["id"] for r in net["roads"]} == {"w-10", "w-11"}


def test_explicit_bbox_can_return_an_empty_network() -> None:
    """A bbox matching nothing yields an empty, still well-formed network."""
    net = p.parse_osm_xml(GRID_XML, bbox=(50.0, 50.0, 50.01, 50.01))
    assert net["roads"] == []
    assert net["intersections"] == []


def test_bbox_zero_extent_keeps_nothing() -> None:
    """A box with no area contains no road.

    The old expectation was the opposite: a way that merely *touched* the
    region was kept **whole**, so a zero-extent box still returned it. That
    is gone — the clip works on the geometry now, and a zero-extent box is a
    line, not an area. A line has no length inside the region either, so
    nothing survives it.

    The box here is a single point (south == north, west == east).
    """
    net = p.parse_osm_xml(GRID_XML, bbox=(0.0, 0.0, 0.0, 0.0))
    assert net["roads"] == []
    assert net["intersections"] == []
    assert net["spawnPoints"] == []


def test_a_tiny_region_keeps_only_the_stub_inside_it() -> None:
    """A region of (almost) no size still cuts the geometry.

    The western way starts on the box's corner, so it survives — but only
    as the stub between the corner and the border. Under the old way-level
    rule the whole 1.1 km way was returned; now the road is 0.1 mm long.
    """
    net = p.parse_osm_xml(GRID_XML, bbox=(-1e-9, -1e-9, 1e-9, 1e-9))
    assert {r["id"] for r in net["roads"]} == {"w-10"}
    road = net["roads"][0]
    assert len(road["waypoints"]) == 2
    xmin, zmin, xmax, zmax = _projected_region(net, (-1e-9, -1e-9, 1e-9, 1e-9))
    extent = max(wp["x"] for wp in road["waypoints"]) - min(wp["x"] for wp in road["waypoints"])
    assert 0.0 < extent <= (xmax - xmin) + 1e-9
    for wp in road["waypoints"]:
        assert xmin - 1e-9 <= wp["x"] <= xmax + 1e-9
        assert zmin - 1e-9 <= wp["z"] <= zmax + 1e-9


def test_bbox_bounds_are_validated() -> None:
    for bad in ((1.0, 0.0, 0.5, 1.0), (0.0, 1.0, 1.0, 0.5)):
        with pytest.raises(ValueError, match="bbox"):
            p.parse_osm_xml(GRID_XML, bbox=bad)


def test_bbox_signature_is_south_west_north_east() -> None:
    """(south, west, north, east) — proven, not assumed.

    The three roads are separated purely by latitude, so this only holds if
    the tuple is (S, W, N, E). Under (N, W, S, E) the validator would reject it
    as south>north, and under (W, S, E, N) it would select the wrong band.
    """
    south_only = p.parse_osm_xml(GRID_XML, bbox=BBOX_SOUTH_ONLY)
    assert {r["id"] for r in south_only["roads"]} == {"w-10"}

    both = p.parse_osm_xml(GRID_XML, bbox=BBOX_SOUTH_AND_MIDDLE)
    assert {r["id"] for r in both["roads"]} == {"w-10", "w-11"}


def test_bbox_west_east_edges_are_honoured() -> None:
    """Longitudinal clipping cuts the road at the eastern edge.

    w-10 runs from lon 0.00 to lon 0.01 and therefore crosses the eastern
    edge at 0.005: it belongs to the region, and it is cut where it leaves
    it. The road ends *on* the border — it does not reach past it.
    """
    net = p.parse_osm_xml(GRID_XML, bbox=(-0.01, -0.01, 0.01, 0.005))
    assert {r["id"] for r in net["roads"]} == {"w-10"}
    road = net["roads"][0]
    assert len(road["waypoints"]) == 2
    _xmin, _zmin, xmax, _zmax = _projected_region(net, (-0.01, -0.01, 0.01, 0.005))
    assert road["waypoints"][-1]["x"] == pytest.approx(xmax, abs=1e-6)
    # The unclipped road reaches much further east — it was cut.
    full = p.parse_osm_xml(GRID_XML)
    full_road = next(r for r in full["roads"] if r["id"] == "w-10")
    assert road["waypoints"] != full_road["waypoints"]


def test_way_entirely_outside_the_bbox_is_dropped() -> None:
    """A road that never reaches the region does not survive it."""
    net = p.parse_osm_xml(GRID_XML, bbox=(-0.01, -0.01, 0.01, 0.005))
    ids = {r["id"] for r in net["roads"]}
    assert "w-11" not in ids  # lat 0.05, north of the box
    assert "w-12" not in ids  # lat 0.09, north of the box


def test_a_clipped_road_is_cut_at_the_border() -> None:
    """A clipped road carries the geometry it has *inside* the box.

    Node-level clipping dropped the waypoints outside the box, so a road
    ended in the middle of the region — a dead end with nothing attached to
    it. Way-level clipping kept the whole road, which stretched the network
    past the requested area. The cut at the border satisfies both: the road
    ends on the border, and nothing of it lies outside.
    """
    bbox = (-0.01, -0.01, 0.01, 0.005)
    net = p.parse_osm_xml(GRID_XML, bbox=bbox)
    full = p.parse_osm_xml(GRID_XML)
    road = next(r for r in net["roads"] if r["id"] == "w-10")
    full_road = next(r for r in full["roads"] if r["id"] == "w-10")
    assert road["waypoints"] != full_road["waypoints"]
    xmin, zmin, xmax, zmax = _projected_region(net, bbox)
    for wp in road["waypoints"]:
        assert xmin - 1e-6 <= wp["x"] <= xmax + 1e-6
        assert zmin - 1e-6 <= wp["z"] <= zmax + 1e-6


def test_parse_osm_xml_accepts_explicit_center() -> None:
    """Centering on the origin keeps far-from-input-center data in frame."""
    net = p.parse_osm_xml(GRID_XML, center=(0.0, 0.0))
    assert len(net["roads"]) == 3


def test_clipping_does_not_change_default_call_signature() -> None:
    """Positional call style must keep working for existing callers."""
    net = p.parse_osm_xml(GRID_XML)
    assert net["roads"]
