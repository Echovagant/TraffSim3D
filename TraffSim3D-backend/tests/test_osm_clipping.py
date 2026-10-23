"""Configurable map clipping (只加载仿真区域).

The parser used to hardcode `MAX_BBOX_DEG = 0.5` (~55 km) as a
memory-safety cap on oversized `.osm` files. That is not clipping: 55 km is
vastly larger than any simulation scene, the bound is not user-configurable,
and nothing in the API or UI can narrow it to the area actually being
simulated.

Clipping now takes an explicit bbox (degrees). The safety cap remains as the
default so an un-cropped call keeps behaving exactly as before.

The clip works at *way* level: a way that touches the region is kept whole
(its geometry is never cut at the border, so no road ends in the middle of
the region) and a way entirely outside is dropped whole.
"""

from __future__ import annotations

import pytest

from app.apps.maps import osm_parser as p

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


def test_bbox_zero_extent_keeps_a_touching_way_whole() -> None:
    """A degenerate box still clips at way level.

    The western way starts exactly on the box's corner, so it touches the
    region and is kept — whole, not cut at the corner.
    """
    net = p.parse_osm_xml(GRID_XML, bbox=(-1e-9, -1e-9, 1e-9, 1e-9))
    assert {r["id"] for r in net["roads"]} == {"w-10"}
    assert len(net["roads"][0]["waypoints"]) == 2


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
    """Longitudinal clipping keeps the roads that reach into the box.

    w-10 runs from lon 0.00 to lon 0.01 and therefore crosses the eastern
    edge at 0.005: it belongs to the region and is kept — with its full
    geometry, not cut off at the border.
    """
    net = p.parse_osm_xml(GRID_XML, bbox=(-0.01, -0.01, 0.01, 0.005))
    assert {r["id"] for r in net["roads"]} == {"w-10"}
    assert len(net["roads"][0]["waypoints"]) == 2


def test_way_entirely_outside_the_bbox_is_dropped() -> None:
    """A road that never reaches the region is dropped whole."""
    net = p.parse_osm_xml(GRID_XML, bbox=(-0.01, -0.01, 0.01, 0.005))
    ids = {r["id"] for r in net["roads"]}
    assert "w-11" not in ids  # lat 0.05, north of the box
    assert "w-12" not in ids  # lat 0.09, north of the box


def test_clipped_roads_keep_their_full_geometry() -> None:
    """A clipped road must carry exactly the geometry it has unclipped.

    Node-level clipping dropped the waypoints outside the box, so a road
    used to end in the middle of the region — a dead end with nothing
    attached to it.
    """
    clipped = p.parse_osm_xml(GRID_XML, bbox=BBOX_SOUTH_ONLY)
    full = p.parse_osm_xml(GRID_XML)
    clipped_road = next(r for r in clipped["roads"] if r["id"] == "w-10")
    full_road = next(r for r in full["roads"] if r["id"] == "w-10")
    assert clipped_road["waypoints"] == full_road["waypoints"]
    assert clipped_road["startNode"] == full_road["startNode"]
    assert clipped_road["endNode"] == full_road["endNode"]


def test_parse_osm_xml_accepts_explicit_center() -> None:
    """Centering on the origin keeps far-from-input-center data in frame."""
    net = p.parse_osm_xml(GRID_XML, center=(0.0, 0.0))
    assert len(net["roads"]) == 3


def test_clipping_does_not_change_default_call_signature() -> None:
    """Positional call style must keep working for existing callers."""
    net = p.parse_osm_xml(GRID_XML)
    assert net["roads"]
