"""The traffic lights of a junction: one per axis group, axis from the geometry.

The rule under test:

* a signalised junction (an OSM node tagged ``highway=traffic_signals``)
  carries **one light per axis group** among its connected roads;
* the axis of an approach is the road's **local tangent where it meets the
  junction** — not the road's whole extent, and not a guess about the
  junction's first road;
* the two axis groups are driven in opposition (one green, one red).

The junction used to carry **at most one** light, whose axis came from the
end-to-end delta of the junction's *first* road. On the Shenzhen extract
that produced 51 lights — every one of them ``ew`` — and left the
perpendicular approach governed by nothing at all.
"""

from __future__ import annotations

from app.apps.maps.osm_parser import (
    _approach_axis,
    _road_polyline_axis,
    parse_osm_xml,
)


def _build_osm(
    nodes: dict[int, tuple[float, float]],
    ways: list[list[int]],
    signal_nodes: set[int],
) -> bytes:
    """A minimal OSM XML document.

    ``nodes`` maps a node id to ``(lat, lon)``; ``ways`` are lists of node
    ids; the ids in ``signal_nodes`` carry ``highway=traffic_signals``.
    """
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<osm version="0.6" generator="light-test">',
    ]
    for node_id, (lat, lon) in nodes.items():
        if node_id in signal_nodes:
            parts.append(
                f'  <node id="{node_id}" lat="{lat}" lon="{lon}">'
                '    <tag k="highway" v="traffic_signals" />\n  </node>'
            )
        else:
            parts.append(f'  <node id="{node_id}" lat="{lat}" lon="{lon}" />')
    for index, refs in enumerate(ways, start=1):
        nds = "".join(f'    <nd ref="{ref}" />\n' for ref in refs)
        parts.append(
            f'  <way id="{index}">\n{nds}' '    <tag k="highway" v="residential" />\n' "  </way>"
        )
    parts.append("</osm>")
    return ("\n".join(parts)).encode("utf-8")


def _lights_of(net: dict, index: int = 0) -> list[dict]:
    """The lights of the junction that carries them."""
    for inter in net["intersections"]:
        if inter["trafficLights"]:
            return inter["trafficLights"]
    return []


# ---------------------------------------------------------------------------
# one light per axis group
# ---------------------------------------------------------------------------


def test_crossroads_gets_one_light_per_axis() -> None:
    """A 4-way crossroads: the north–south road and the east–west road are
    two axis groups, so the junction carries two lights."""
    nodes = {
        1: (0.0, -0.001),  # south arm
        2: (0.0, 0.0),  # the junction
        3: (0.0, 0.001),  # north arm
        4: (-0.001, 0.0),  # west arm
        5: (0.001, 0.0),  # east arm
    }
    ways = [
        [1, 2, 3],  # north–south road
        [4, 2, 5],  # east–west road
    ]
    net = parse_osm_xml(_build_osm(nodes, ways, {2}))

    lights = _lights_of(net)
    assert len(lights) == 2
    assert sorted(light["axis"] for light in lights) == ["ew", "ns"]
    # The two groups are driven in opposition.
    assert sorted(light["phase"] for light in lights) == ["green", "red"]


def test_junction_with_one_axis_gets_exactly_one_light() -> None:
    """Both arms of this junction run east-west: one axis group, one light.

    A junction needs two ways to exist at all, so the east-west road is
    split into a west arm and an east arm (which is how OSM carries a
    crossing anyway).
    """
    nodes = {
        1: (0.0, -0.001),  # west arm
        2: (0.0, 0.0),  # the junction
        3: (0.0, 0.001),  # east arm
    }
    ways = [[1, 2], [2, 3]]
    net = parse_osm_xml(_build_osm(nodes, ways, {2}))

    lights = _lights_of(net)
    assert len(lights) == 1
    assert lights[0]["axis"] == "ew"


def test_junction_without_the_signal_tag_has_no_light() -> None:
    nodes = {
        1: (0.0, -0.001),
        2: (0.0, 0.0),
        3: (0.0, 0.001),
        4: (-0.001, 0.0),
        5: (0.001, 0.0),
    }
    ways = [[1, 2, 3], [4, 2, 5]]
    net = parse_osm_xml(_build_osm(nodes, ways, set()))

    assert _lights_of(net) == []


# ---------------------------------------------------------------------------
# the axis comes from the geometry, not from a guess
# ---------------------------------------------------------------------------


def test_axis_is_the_local_tangent_not_the_road_extent() -> None:
    """The junction is the **start** of a road that first runs north and
    then turns east.

    The road's extent is east–west (it travels 111 m east and 11 m
    north), so the old rule — the end-to-end delta of the junction's
    first road — called this an ``ew`` approach. The traffic on that leg
    travels **north–south** where it meets the junction, so the approach
    is ``ns``.
    """
    nodes = {
        1: (0.0, 0.0),  # the junction (also the start of way 1)
        2: (0.0001, 0.00002),  # north, a little east
        3: (0.0001, 0.001),  # east
        4: (0.0, -0.001),  # the west arm of the crossing road
        5: (0.0, 0.002),  # the east arm
    }
    ways = [
        [1, 2, 3],  # north, then east
        [4, 1, 5],  # east–west road
    ]
    net = parse_osm_xml(_build_osm(nodes, ways, {1}))

    lights = _lights_of(net)
    assert len(lights) == 2
    assert sorted(light["axis"] for light in lights) == ["ew", "ns"]

    # The road itself: the extent says `ew`, the approach says `ns`.
    roads = {road["id"]: road for road in net["roads"]}
    turning = next(road for road in roads.values() if road["id"] == "w-1")
    junction = next(inter for inter in net["intersections"] if inter["trafficLights"])
    assert _road_polyline_axis(turning) == "ew"
    assert _approach_axis(turning, junction) == "ns"


def test_the_whole_road_extent_is_not_the_axis() -> None:
    """A road whose extent and whose approach differ — the case the rule
    exists for."""
    road = {
        "id": "w-1",
        "startNode": {"x": 0.0, "y": 0.0, "z": 0.0},
        "endNode": {"x": 111.0, "y": 0.0, "z": 11.1},
        "waypoints": [
            {"x": 0.0, "y": 0.0, "z": 0.0},
            {"x": 2.22, "y": 0.0, "z": 11.1},
            {"x": 111.0, "y": 0.0, "z": 11.1},
        ],
        "laneCount": 2,
        "speedLimit": 13.89,
        "level": 0,
    }
    # The junction sits on the first (north–south) segment.
    junction = {"position": {"x": 0.0, "y": 0.0, "z": 5.5}}
    assert _road_polyline_axis(road) == "ew"
    assert _approach_axis(road, junction) == "ns"


def test_axis_falls_back_to_the_extent_when_the_junction_is_too_far_off() -> None:
    """Beyond ``MAX_INTERSECTION_OFFSET_M`` the projection is rejected, and
    the road's extent decides — exactly like the frontend does."""
    road = {
        "id": "w-1",
        "startNode": {"x": 0.0, "y": 0.0, "z": 0.0},
        "endNode": {"x": 0.0, "y": 0.0, "z": 100.0},
        "waypoints": [
            {"x": 0.0, "y": 0.0, "z": 0.0},
            {"x": 0.0, "y": 0.0, "z": 100.0},
        ],
        "laneCount": 2,
        "speedLimit": 13.89,
        "level": 0,
    }
    near = {"position": {"x": 0.0, "y": 0.0, "z": 50.0}}
    far = {"position": {"x": 40.0, "y": 0.0, "z": 50.0}}
    assert _approach_axis(road, near) == "ns"
    assert _approach_axis(road, far) == "ns"


def test_light_ids_keep_their_shape() -> None:
    """The ids stay ``tl-<n>-<axis>``, so an id that already existed keeps
    existing; the second axis group gets the id of its own axis."""
    nodes = {
        1: (0.0, -0.001),
        2: (0.0, 0.0),
        3: (0.0, 0.001),
        4: (-0.001, 0.0),
        5: (0.001, 0.0),
    }
    ways = [[1, 2, 3], [4, 2, 5]]
    net = parse_osm_xml(_build_osm(nodes, ways, {2}))

    ids = sorted(light["id"] for light in _lights_of(net))
    assert len(ids) == 2
    assert all(light_id.startswith("tl-") for light_id in ids)
    assert sorted(light_id.rsplit("-", 1)[1] for light_id in ids) == ["ew", "ns"]
