"""The POI fetcher — parsing, datum conversion and the scene projection.

What is pinned here:

1. **The provider's answer is parsed** — the documented shape (`pois`
   array, `location` as "lon,lat", `typecode`, `type`, `address`).
2. **GCJ-02 → WGS84 → local metres**: a POI lands on the corner of the
   roads it belongs to. The projection is the PARSER's formula around
   the SCENE's origin — a different formula would put the POIs a few
   metres off, which on a 5 m lane is the wrong side of the road.
3. **The key is resolved in the documented order** (the request's own,
   then the deployment's) and its absence is an explicit error.
4. **The provider's refusal is surfaced**, not swallowed: a bad key or
   an unreachable provider must not look like "no POIs here".
"""

from __future__ import annotations

import math
from typing import Any

import httpx2 as httpx
import pytest

from app.apps.maps.poi import (
    AMAP_POLYGON_URL,
    PoiQuery,
    PoiUnavailableError,
    fetch_amap_pois,
    parse_amap_poi,
    project_to_scene,
    resolve_amap_key,
)

#: The scene's origin (the parser centres the map here) — in **WGS84**,
#: the datum the scene's roads live in. The provider's POIs are GCJ-02,
#: so a POI whose GCJ coordinates are close to these numbers lands
#: hundreds of metres away — which is the whole point of the
#: conversion (and of the test that pins it).
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


#: A provider POI in the documented shape.
AMAP_POI = {
    "id": "B0FFH1234",
    "name": "示例咖啡",
    "type": "餐饮服务;咖啡厅",
    "typecode": "050100",
    "address": "东城区示例路 1 号",
    "location": "116.3976000,39.9088000",
    "rating": "4.6",
}


def test_a_provider_poi_becomes_a_scene_poi() -> None:
    poi = parse_amap_poi(AMAP_POI, _query())
    assert poi is not None
    assert poi["id"] == "B0FFH1234"
    assert poi["name"] == "示例咖啡"
    assert poi["address"] == "东城区示例路 1 号"
    assert poi["typeCode"] == "050100"
    # The category is the provider's leading code group.
    assert poi["category"] == "餐饮"
    # The datum WAS converted: the provider's GCJ-02 lon differs from
    # the WGS84 lon by ~0.0058 degrees here (the datum offset itself),
    # so the converted value is a few hundred metres away from the
    # input. Without the conversion the POI would sit ~520 m from the
    # scene's origin — visibly off the road it belongs to.
    assert abs(poi["lon"] - 116.3976) > 0.003
    assert abs(poi["x"]) < 1000.0
    assert abs(poi["z"]) < 1000.0
    # And the projection puts it where the parser would put a node at
    # that WGS84 coordinate.
    expected_x, expected_z = project_to_scene(poi["lon"], poi["lat"], ORIGIN_LAT, ORIGIN_LON)
    assert poi["x"] == pytest.approx(expected_x)
    assert poi["z"] == pytest.approx(expected_z)


def test_the_projection_is_the_parsers_own_formula() -> None:
    """The POI's scene position must use the SAME formula the roads
    were projected with — otherwise the POIs sit beside their roads."""
    lon, lat = 116.3990, 39.9100
    x, z = project_to_scene(lon, lat, ORIGIN_LAT, ORIGIN_LON)
    cos_lat = math.cos(ORIGIN_LAT * math.pi / 180.0)
    assert x == pytest.approx((lon - ORIGIN_LON) * 111000.0 * cos_lat)
    assert z == pytest.approx((lat - ORIGIN_LAT) * 111000.0)


def test_a_malformed_poi_is_skipped_not_fatal() -> None:
    assert parse_amap_poi({"name": "no location"}, _query()) is None
    assert parse_amap_poi({"location": "not-a-pair"}, _query()) is None
    assert parse_amap_poi("not a dict", _query()) is None


def test_the_key_comes_from_the_request_then_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TRAFFIC_AMAP_KEY", "env-key")
    assert resolve_amap_key("request-key") == "request-key"
    assert resolve_amap_key("") == "env-key"
    assert resolve_amap_key(None) == "env-key"
    monkeypatch.delenv("TRAFFIC_AMAP_KEY")
    with pytest.raises(PoiUnavailableError, match="no AMap key"):
        resolve_amap_key("")


def test_the_polygon_parameter_is_the_rectangle() -> None:
    query = _query()
    polygon = query.polygon()
    assert polygon.count(";") == 3
    for vertex in polygon.split(";"):
        lon_text, lat_text = vertex.split(",")
        assert 116.39 <= float(lon_text) <= 116.41
        assert 39.90 <= float(lat_text) <= 39.92


def _stub_client(payload: dict[str, Any], status_code: int = 200) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json=payload)

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_the_fetch_parses_the_provider_s_answer() -> None:
    payload = {"status": "1", "count": "1", "info": "OK", "pois": [AMAP_POI]}
    with _stub_client(payload) as client:
        pois = fetch_amap_pois("key", _query(), client=client)
    assert len(pois) == 1
    assert pois[0]["name"] == "示例咖啡"


def test_a_refused_request_is_an_error_not_an_empty_list() -> None:
    payload = {"status": "0", "info": "INVALID_USER_KEY"}
    with _stub_client(payload) as client:
        with pytest.raises(PoiUnavailableError, match="INVALID_USER_KEY"):
            fetch_amap_pois("bad-key", _query(), client=client)


def test_an_unreachable_provider_is_an_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(PoiUnavailableError, match="unreachable"):
            fetch_amap_pois("key", _query(), client=client)


def test_the_rectangle_search_uses_the_polygon_endpoint() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"status": "1", "pois": []})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        fetch_amap_pois("key", _query(), client=client)
    assert str(seen["url"]).startswith(AMAP_POLYGON_URL)
    assert "polygon=" in str(seen["url"])


def test_a_keyword_search_uses_the_text_endpoint() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"status": "1", "pois": []})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        fetch_amap_pois("key", _query(keywords="咖啡"), client=client)
    assert "/v3/place/text" in str(seen["url"])
    assert "keywords=" in str(seen["url"])
