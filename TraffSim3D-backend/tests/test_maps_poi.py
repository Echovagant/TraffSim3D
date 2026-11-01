"""The POI fetcher — parsing, the projection and the Overpass query.

What is pinned here:

1. **The datum is NOT converted** — OSM is WGS84 and the scene's
   roads are WGS84, so a POI's coordinates go into the projection
   unchanged. That is the whole reason the source is OSM: a POI lands
   on the corner of the roads it belongs to because both are in the
   same datum AND projected with the parser's own formula around the
   scene's origin.
2. **The Overpass query is built correctly** — the rectangle in
   Overpass's own order, the drawn tags, and the keyword filter as an
   AND (a second statement would be a UNION and would WIDEN the
   query instead of narrowing it).
3. **The category comes from the tag's value** — `amenity=restaurant`
   is 餐饮, `amenity=hospital` is 医疗, an unlisted `shop=*` is 购物.
4. **Overpass's refusal is surfaced**, not swallowed: an unreachable
   source must not look like "no POIs here".
"""

from __future__ import annotations

import math
from typing import Any

import pytest

from app.apps.maps.poi import (
    DEFAULT_POI_TAGS,
    MAX_POI_LIMIT,
    PoiQuery,
    PoiUnavailableError,
    _closest_first,
    build_overpass_query,
    fetch_osm_pois,
    parse_osm_poi,
    project_to_scene,
)

#: The scene's origin (the parser centres the map here) — in **WGS84**,
#: the datum the scene's roads live in, and the datum OSM's data is in.
ORIGIN_LAT = 39.90625
ORIGIN_LON = 116.39170


def _query(**overrides: Any) -> PoiQuery:
    base = {
        "south": 39.90,
        "west": 116.39,
        "north": 39.92,
        "east": 116.41,
        "origin_lat": ORIGIN_LAT,
        "origin_lon": ORIGIN_LON,
    }
    base.update(overrides)
    return PoiQuery(**base)


#: An Overpass node in the documented shape.
OSM_NODE = {
    "type": "node",
    "id": 123456789,
    "lat": 39.9088,
    "lon": 116.3976,
    "tags": {
        "name": "示例咖啡",
        "amenity": "cafe",
    },
}


def test_an_osm_node_becomes_a_scene_poi() -> None:
    poi = parse_osm_poi(OSM_NODE, _query())
    assert poi is not None
    assert poi["id"] == "osm-node-123456789"
    assert poi["name"] == "示例咖啡"
    assert poi["category"] == "餐饮"
    assert poi["typeCode"] == "amenity"
    assert poi["type"] == "amenity=cafe"


def test_the_datum_is_not_converted() -> None:
    """OSM is WGS84 and the scene's roads are WGS84.

    So the POI's coordinates are the ones Overpass gave — no inverse
    conversion, no offset. (A provider's GCJ-02 data needed one, and
    the offset is hundreds of metres: a POI that was not converted
    landed ~520 m from its own corner.)
    """
    poi = parse_osm_poi(OSM_NODE, _query())
    assert poi is not None
    assert poi["lon"] == pytest.approx(116.3976)
    assert poi["lat"] == pytest.approx(39.9088)


def test_the_projection_is_the_parsers_own_formula() -> None:
    """The POI's scene position must use the SAME formula the roads
    were projected with — otherwise the POIs sit beside their roads."""
    lon, lat = 116.3990, 39.9100
    x, z = project_to_scene(lon, lat, ORIGIN_LAT, ORIGIN_LON)
    cos_lat = math.cos(ORIGIN_LAT * math.pi / 180.0)
    assert x == pytest.approx((lon - ORIGIN_LON) * 111000.0 * cos_lat)
    assert z == pytest.approx((lat - ORIGIN_LAT) * 111000.0)

    poi = parse_osm_poi(OSM_NODE, _query())
    assert poi is not None
    expected_x, expected_z = project_to_scene(poi["lon"], poi["lat"], ORIGIN_LAT, ORIGIN_LON)
    assert poi["x"] == pytest.approx(expected_x)
    assert poi["z"] == pytest.approx(expected_z)


def test_a_malformed_element_is_skipped_not_fatal() -> None:
    assert parse_osm_poi({"type": "node", "id": 1}, _query()) is None  # no coordinates
    assert parse_osm_poi({"type": "node", "lat": 1.0, "lon": 2.0}, _query()) is None  # no id
    assert parse_osm_poi({"type": "way", "id": 1, "center": {}}, _query()) is None
    assert parse_osm_poi("not a dict", _query()) is None


def test_the_category_comes_from_the_tags_value() -> None:
    def category_of(tags: dict[str, str]) -> str:
        element = {"type": "node", "id": 1, "lat": 39.9, "lon": 116.4, "tags": tags}
        poi = parse_osm_poi(element, _query())
        assert poi is not None
        return poi["category"]

    assert category_of({"amenity": "restaurant"}) == "餐饮"
    assert category_of({"amenity": "cafe"}) == "餐饮"
    assert category_of({"amenity": "hospital"}) == "医疗"
    assert category_of({"amenity": "school"}) == "教育"
    assert category_of({"amenity": "fuel"}) == "交通设施"
    assert category_of({"amenity": "bank"}) == "生活服务"
    assert category_of({"shop": "convenience"}) == "购物"
    assert category_of({"shop": "car_repair"}) == "汽车服务"
    assert category_of({"tourism": "hotel"}) == "住宿"
    assert category_of({"tourism": "museum"}) == "景点"
    assert category_of({"leisure": "park"}) == "休闲"
    assert category_of({"office": "company"}) == "商务"
    assert category_of({"healthcare": "hospital"}) == "医疗"
    assert category_of({"public_transport": "platform"}) == "交通设施"
    # A POI whose value is not listed falls back to its tag's category.
    assert category_of({"amenity": "bench"}) == "生活服务"


def test_the_name_is_optional() -> None:
    """A quarter of the POIs carry no name at all (measured)."""
    element = {"type": "node", "id": 7, "lat": 39.9, "lon": 116.4, "tags": {"amenity": "cafe"}}
    poi = parse_osm_poi(element, _query())
    assert poi is not None
    assert poi["name"] == ""
    assert poi["category"] == "餐饮"


def test_the_address_is_composed_from_what_osm_has() -> None:
    element = {
        "type": "node",
        "id": 8,
        "lat": 39.9,
        "lon": 116.4,
        "tags": {
            "amenity": "cafe",
            "addr:city": "北京市",
            "addr:street": "示例路",
            "addr:housenumber": "1号",
        },
    }
    poi = parse_osm_poi(element, _query())
    assert poi is not None
    assert poi["address"] == "北京市示例路1号"


def test_the_rectangle_is_in_overpasss_own_order() -> None:
    bbox = _query().bbox()
    assert bbox == "39.900000,116.390000,39.920000,116.410000"
    south, west, north, east = (float(part) for part in bbox.split(","))
    assert south < north
    assert west < east


def test_the_query_asks_for_the_drawn_tags() -> None:
    query = build_overpass_query(_query())
    for tag in DEFAULT_POI_TAGS:
        assert f'node["{tag}"]' in query
    assert query.endswith("out 25;")
    # Only nodes: the output limit is filled by them first, so asking
    # for ways as well would cost the same time and change nothing.
    assert "way[" not in query
    assert "relation[" not in query


def test_the_keyword_is_an_and_not_an_or() -> None:
    """Overpass's union syntax ORs statements.

    A separate name statement would WIDEN the query (every POI, plus
    every POI whose name matches) instead of narrowing it — so the
    name filter has to be chained onto the SAME statement.
    """
    query = build_overpass_query(_query(keywords="咖啡"))
    assert '["name"~"咖啡",i]' in query
    # One statement per tag, each carrying the name filter.
    statements = [part for part in query.split(";") if 'node["' in part]
    assert len(statements) == len(DEFAULT_POI_TAGS)
    for statement in statements:
        assert '["name"~"咖啡",i]' in statement


def test_the_keyword_is_escaped() -> None:
    """A metacharacter in the keyword must not change the query."""
    query = build_overpass_query(_query(keywords="a+b(c)"))
    assert '["name"~"a\\+b\\(c\\)",i]' in query


def test_the_tag_filter_is_honoured() -> None:
    query = build_overpass_query(_query(tags="amenity,shop"))
    assert 'node["amenity"]' in query
    assert 'node["shop"]' in query
    assert 'node["tourism"]' not in query
    # A nonsense tag falls back to the default set rather than asking
    # for nothing.
    assert 'node["amenity"]' in build_overpass_query(_query(tags="not a tag!"))


def test_the_limit_is_capped() -> None:
    assert build_overpass_query(_query(limit=1000)).endswith(f"out {MAX_POI_LIMIT};")
    assert build_overpass_query(_query(limit=0)).endswith("out 1;")


def test_the_pois_come_back_nearest_the_scene_first() -> None:
    """Overpass's order has nothing to do with the map."""
    elements = [
        {"type": "node", "id": 1, "lat": 39.92, "lon": 116.41, "tags": {"amenity": "cafe"}},
        {"type": "node", "id": 2, "lat": 39.901, "lon": 116.391, "tags": {"amenity": "cafe"}},
        {"type": "node", "id": 3, "lat": 39.91, "lon": 116.40, "tags": {"amenity": "cafe"}},
    ]
    pois = [parse_osm_poi(element, _query()) for element in elements]
    assert all(poi is not None for poi in pois)
    ordered = _closest_first([poi for poi in pois if poi is not None], _query())
    assert [poi["id"] for poi in ordered] == ["osm-node-2", "osm-node-3", "osm-node-1"]


def test_an_unreachable_source_is_an_error_not_an_empty_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Overpass's refusal must not look like "no POIs here"."""

    def broken(*args: Any, **kwargs: Any) -> dict[str, Any]:
        raise RuntimeError("connection timed out")

    monkeypatch.setattr("app.apps.maps.poi.cached_overpass_fetch", broken)
    with pytest.raises(PoiUnavailableError, match="unreachable"):
        fetch_osm_pois(_query())


def test_the_fetch_parses_the_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_fetch(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"version": 0.6, "elements": [OSM_NODE]}

    monkeypatch.setattr("app.apps.maps.poi.cached_overpass_fetch", fake_fetch)
    pois = fetch_osm_pois(_query())
    assert len(pois) == 1
    assert pois[0]["name"] == "示例咖啡"
