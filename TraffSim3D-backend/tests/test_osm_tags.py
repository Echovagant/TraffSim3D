"""OSM tag fidelity: `layer` levels and implicit one-way roundabouts.

Two OSM rules the parser used to ignore:

1. **`layer`** is OSM's vertical-ordering tag. It is an *integer* level
   (`layer=1` is one level above the ground, `layer=-1` one below), not a
   boolean "above/below" flag — real data uses `layer=2` for a viaduct that
   crosses another viaduct and `layer=-3` for a deep underpass. The parser
   only looked at `bridge=yes` / `tunnel=yes`, so every `layer` value was
   thrown away.

2. **`junction=roundabout`** implies `oneway=yes` (OSM wiki,
   Tag:junction=roundabout: "|implies=* oneway=yes"), and roundabout ring
   ways "must be drawn in the direction of traffic flow". A roundabout
   without an `oneway` tag was therefore treated as a two-way road — cars
   could drive against the ring.

The OSM wiki sources are quoted in `app/apps/maps/osm_parser.py`.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.apps.maps.osm_parser import LEVEL_HEIGHT, parse_osm_xml, parse_osmpbf


def _way_xml(way_id: int, tags: list[tuple[str, str]], nodes: str = "1,2,3") -> bytes:
    """A 3-node east-west way with the given tags.

    Nodes are laid out west -> east, so the digitisation direction is
    "increasing x".
    """
    refs = "".join(f'<nd ref="{n}"/>' for n in nodes.split(","))
    tag_xml = "".join(f'<tag k="{k}" v="{v}"/>' for k, v in tags)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="0.0000" lon="0.0000"/>
  <node id="2" lat="0.0000" lon="0.0005"/>
  <node id="3" lat="0.0000" lon="0.0010"/>
  <way id="{way_id}">{refs}{tag_xml}</way>
</osm>
""".encode()


def _road(xml: bytes) -> dict:
    net = parse_osm_xml(xml)
    assert len(net["roads"]) == 1, net["roads"]
    return net["roads"][0]


# ---------------------------------------------------------------------------
# `layer` — the vertical level
# ---------------------------------------------------------------------------


def test_layer_tag_alone_sets_the_level() -> None:
    """`layer` alone decides the level — no bridge/tunnel tag needed."""
    assert _road(_way_xml(10, [("highway", "residential"), ("layer", "1")]))["level"] == 1
    assert _road(_way_xml(11, [("highway", "residential"), ("layer", "-1")]))["level"] == -1


def test_layer_is_an_integer_level_not_a_boolean_flag() -> None:
    """`layer=2` is two levels up, `layer=-3` three levels down."""
    road = _road(_way_xml(10, [("highway", "residential"), ("layer", "2")]))
    assert road["level"] == 2
    assert road["waypoints"][0]["y"] == pytest.approx(2 * LEVEL_HEIGHT)

    road = _road(_way_xml(11, [("highway", "residential"), ("layer", "-3")]))
    assert road["level"] == -3
    assert road["waypoints"][0]["y"] == pytest.approx(-3 * LEVEL_HEIGHT)


def test_layer_zero_is_the_ground() -> None:
    assert _road(_way_xml(10, [("highway", "residential"), ("layer", "0")]))["level"] == 0


def test_layer_overrides_the_bridge_and_tunnel_default() -> None:
    """The tag is authoritative: `bridge=yes layer=2` is two levels up."""
    road = _road(_way_xml(10, [("highway", "residential"), ("bridge", "yes"), ("layer", "2")]))
    assert road["level"] == 2
    road = _road(_way_xml(11, [("highway", "residential"), ("tunnel", "yes"), ("layer", "-2")]))
    assert road["level"] == -2


def test_bridge_without_layer_implies_one_level_up() -> None:
    """OSM's fallback for a bridge with no `layer` tag: level +1."""
    road = _road(_way_xml(10, [("highway", "residential"), ("bridge", "yes")]))
    assert road["level"] == 1
    assert road["waypoints"][0]["y"] == pytest.approx(LEVEL_HEIGHT)


def test_tunnel_without_layer_implies_one_level_down() -> None:
    """OSM's fallback for a tunnel with no `layer` tag: level -1."""
    road = _road(_way_xml(10, [("highway", "residential"), ("tunnel", "yes")]))
    assert road["level"] == -1
    assert road["waypoints"][0]["y"] == pytest.approx(-LEVEL_HEIGHT)


def test_bridge_viaduct_is_a_bridge() -> None:
    """`bridge=viaduct` is a bridge; only `bridge=no` says it is not."""
    assert _road(_way_xml(10, [("highway", "residential"), ("bridge", "viaduct")]))["level"] == 1
    assert _road(_way_xml(11, [("highway", "residential"), ("bridge", "no")]))["level"] == 0


def test_building_passage_is_not_a_tunnel() -> None:
    """A cut through a building stays on the ground; `layer` decides otherwise."""
    road = _road(_way_xml(10, [("highway", "residential"), ("tunnel", "building_passage")]))
    assert road["level"] == 0
    road = _road(
        _way_xml(11, [("highway", "residential"), ("tunnel", "building_passage"), ("layer", "-1")])
    )
    assert road["level"] == -1


def test_unusable_layer_falls_back_to_the_bridge_and_tunnel_default() -> None:
    """A malformed `layer` value must not swallow the bridge/tunnel rule."""
    road = _road(_way_xml(10, [("highway", "residential"), ("bridge", "yes"), ("layer", "abc")]))
    assert road["level"] == 1


def test_a_high_level_endpoint_meets_the_ground_network() -> None:
    """A level-2 way that ends on a ground way shares the ground node.

    The node's level is the one closest to the ground, so the viaduct
    ramps down to the surface instead of floating.
    """
    xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="0.0000" lon="0.0000"/>
  <node id="2" lat="0.0000" lon="0.0010"/>
  <node id="3" lat="0.0000" lon="0.0020"/>
  <way id="10">
    <nd ref="1"/><nd ref="2"/>
    <tag k="highway" v="residential"/><tag k="layer" v="2"/>
  </way>
  <way id="11">
    <nd ref="2"/><nd ref="3"/>
    <tag k="highway" v="residential"/>
  </way>
</osm>
"""
    roads = {r["id"]: r for r in parse_osm_xml(xml)["roads"]}
    assert roads["w-10"]["level"] == 2
    assert roads["w-11"]["level"] == 0
    # The shared node (id 2) sits on the ground for both ways.
    assert roads["w-10"]["waypoints"][1]["y"] == pytest.approx(0.0)
    assert roads["w-11"]["waypoints"][0]["y"] == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# `junction=roundabout` — the implicit one-way
# ---------------------------------------------------------------------------


def test_roundabout_without_oneway_is_one_way() -> None:
    """`junction=roundabout` implies `oneway=yes`."""
    road = _road(_way_xml(10, [("highway", "residential"), ("junction", "roundabout")]))
    assert road["oneway"] is True


def test_roundabout_keeps_its_digitisation_direction() -> None:
    """OSM draws the ring in the direction of traffic — do not flip it.

    The way is digitised west -> east, so "forward" (increasing x) is the
    travel direction and the waypoints must keep that order.
    """
    road = _road(_way_xml(10, [("highway", "residential"), ("junction", "roundabout")]))
    assert road["waypoints"][0]["x"] < road["waypoints"][-1]["x"]
    assert road["startNode"]["x"] < road["endNode"]["x"]


def test_circular_junction_without_oneway_is_one_way() -> None:
    """A rotary (`junction=circular`) is a one-way ring too."""
    road = _road(_way_xml(10, [("highway", "residential"), ("junction", "circular")]))
    assert road["oneway"] is True


def test_explicit_oneway_no_beats_the_roundabout_rule() -> None:
    """An explicit tag wins — bi-directional circular junctions exist."""
    road = _road(
        _way_xml(10, [("highway", "residential"), ("junction", "circular"), ("oneway", "no")])
    )
    assert road["oneway"] is False


def test_roundabout_with_oneway_reverse_is_flipped() -> None:
    """`oneway=-1` still reverses the way, exactly like any other road."""
    road = _road(
        _way_xml(10, [("highway", "residential"), ("junction", "roundabout"), ("oneway", "-1")])
    )
    assert road["oneway"] is True
    assert road["waypoints"][0]["x"] > road["waypoints"][-1]["x"]


def test_roundabout_lane_count_is_halved_like_any_one_way() -> None:
    """A one-way road carries half the lanes of a two-way road."""
    road = _road(
        _way_xml(10, [("highway", "residential"), ("junction", "roundabout"), ("lanes", "4")])
    )
    assert road["oneway"] is True
    assert road["laneCount"] == 2


def test_a_plain_way_without_oneway_stays_two_way() -> None:
    """The roundabout rule must not leak onto ordinary roads."""
    road = _road(_way_xml(10, [("highway", "residential")]))
    assert road["oneway"] is False
    assert road["laneCount"] == 2


def test_explicit_oneway_yes_still_works() -> None:
    road = _road(_way_xml(10, [("highway", "residential"), ("oneway", "yes")]))
    assert road["oneway"] is True


def test_junction_intersection_is_not_a_one_way_signal() -> None:
    """`junction=intersection` describes the topology, not the direction."""
    road = _road(_way_xml(10, [("highway", "residential"), ("junction", "intersection")]))
    assert road["oneway"] is False


# ---------------------------------------------------------------------------
# XML and PBF must not drift apart on the new tags either.
# ---------------------------------------------------------------------------


def _build_pbf(xml: bytes, tmp_path: Path) -> bytes:
    """Write the XML to disk and convert it to PBF with libosmium."""
    import osmium

    xml_path = tmp_path / "case.osm"
    pbf_path = tmp_path / "case.osm.pbf"
    xml_path.write_bytes(xml)

    fw = osmium.ForwardReferenceWriter(
        outfile=str(pbf_path),
        ref_src=str(xml_path),
        overwrite=True,
    )

    class _Reader(osmium.SimpleHandler):
        def node(self, n):  # noqa: ANN001, ANN202
            fw.add_node(n)

        def way(self, w):  # noqa: ANN001, ANN202
            fw.add_way(w)

    reader = _Reader()
    reader.apply_file(str(xml_path), locations=True)
    fw.close()
    return pbf_path.read_bytes()


def test_xml_and_pbf_agree_on_layers_and_roundabouts(tmp_path: Path) -> None:
    """The same tags must produce the same network in both formats."""
    xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="0.0000" lon="0.0000"/>
  <node id="2" lat="0.0000" lon="0.0005"/>
  <node id="3" lat="0.0000" lon="0.0010"/>
  <node id="4" lat="0.0001" lon="0.0000"/>
  <node id="5" lat="0.0001" lon="0.0010"/>
  <way id="10">
    <nd ref="1"/><nd ref="2"/><nd ref="3"/>
    <tag k="highway" v="residential"/><tag k="layer" v="2"/>
  </way>
  <way id="11">
    <nd ref="4"/><nd ref="5"/>
    <tag k="highway" v="residential"/><tag k="junction" v="roundabout"/>
  </way>
</osm>
"""
    from_xml = parse_osm_xml(xml)
    from_pbf = parse_osmpbf(_build_pbf(xml, tmp_path))

    def payload(net: dict) -> list[dict]:
        return [
            {
                "level": r["level"],
                "oneway": r["oneway"],
                "laneCount": r["laneCount"],
                "waypoints": r["waypoints"],
            }
            for r in net["roads"]
        ]

    assert payload(from_xml) == payload(from_pbf)
    levels = sorted(r["level"] for r in from_xml["roads"])
    assert levels == [0, 2]
    assert any(r["oneway"] for r in from_xml["roads"])
