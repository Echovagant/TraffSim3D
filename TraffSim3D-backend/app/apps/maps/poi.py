"""Real-world points of interest, fetched and placed on the scene's map.

The road network says where the STREETS are; the points of interest say
what is ALONG them — the petrol station at the corner, the hospital,
the school.

Where the POIs come from
------------------------
**OpenStreetMap**, through the public **Overpass** API. Three reasons,
and they decided the design:

1. **No key, no quota, no bill.** A commercial provider's Web-service
   API needs a key that belongs to whoever runs the deployment, and
   its free tier is limited to personal research — a product cannot
   depend on that.
2. **The same datum as the roads.** OSM is WGS84 and the scene's roads
   are WGS84, so a POI needs **no datum conversion at all** — only the
   parser's own projection around the scene's origin. (A Chinese
   provider's data is GCJ-02, which needs an inverse conversion first,
   and the offset is hundreds of metres.)
3. **The coverage is there.** Measured on the project's own city
   (Shenzhen Futian, one district, overpass): `amenity` 4 516, `shop`
   807, `tourism` 501, `leisure` 2 193, `public_transport` 3 146
   elements — with Chinese names (沃尔玛, 华润万家, 必胜客, 味千拉面).
   A quarter of them carry no name at all.

The price of (1) and (2) is (3)'s caveat: **Overpass is a
volunteer-run public service**. It is slow (measured: 65–73 s for a
scene-sized rectangle) and it refuses when it is busy (502/504, and
the same query answered 200, then 502, then 504 within a minute).
So the fetch tries several instances in turn, caches the answer on disk
(`overpass_cache.py`), and the browser's timeout is generous.

Licence: OSM's data is ODbL — the attribution the UI already shows
must stay.

What is NOT fetched
-------------------
**Ways and relations** — a POI mapped as a polygon (a school campus,
a shopping mall) is skipped, because the output limit is filled by
the plain nodes first anyway (measured: the node-only query and the
node+way query returned the *same* 300 elements, byte for byte). The
POIs that reach the scene are therefore the point-like ones: the
shops, the clinics, the bus stops, the schools' entrances.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from .overpass_cache import OVERPASS_ENDPOINTS, cached_overpass_fetch

#: The OSM tags the scene draws points for. These are the tags that
#: mean "a place a person goes to" — the roads and the buildings are
#: the road network's business, not the POI layer's.
DEFAULT_POI_TAGS: tuple[str, ...] = (
    "amenity",
    "shop",
    "tourism",
    "leisure",
    "office",
    "healthcare",
    "historic",
    "public_transport",
    "sport",
)

#: The most POIs the endpoint returns. The browser's marker layer
#: holds 512 instances, so this stays well below it.
MAX_POI_LIMIT = 200

#: The per-instance timeout for the Overpass fetch (s).
#:
#: Overpass answers a scene-sized rectangle in 50–73 s when it is
#: busy, so the first instance needs a generous budget.
POI_OVERPASS_TIMEOUT_S = 75.0

#: The TOTAL the whole instance chain may take (s).
#:
#: The alternative instances are unreachable from some networks
#: (measured: both timed out after 90 s), so the chain shares one
#: budget — a mirror that cannot be reached must not multiply the
#: wait threefold.
POI_OVERPASS_BUDGET_S = 100.0

#: The Overpass query's own timeout (s) — the server gives up before
#: the client does, so the error message is the server's.
POI_OVERPASS_QUERY_TIMEOUT_S = 90

#: The regex characters that must be escaped in an Overpass name
#: filter. Overpass matches with an ECMAScript-style engine, where
#: these are the metacharacters.
_REGEX_METACHARACTERS = "\\^$.|?*+()[]{}"


@dataclass
class PoiQuery:
    """What to fetch: a rectangle on the map, in the scene's datum."""

    #: The rectangle in WGS84 degrees.
    south: float
    west: float
    north: float
    east: float
    #: The scene's origin — the POIs are projected around it.
    origin_lat: float
    origin_lon: float
    #: The OSM tags to fetch (comma-separated). Empty = the default set.
    tags: str = ""
    #: A free-text filter — only the POIs whose NAME contains it.
    keywords: str = ""
    #: How many POIs to ask for.
    limit: int = 25

    def bbox(self) -> str:
        """The rectangle in Overpass's own order: `(south, west, north, east)`.

        A swapped pair silently returns a wrong rectangle (and a query
        for the wrong city), so the order is spelled out here once.
        """
        return f"{self.south:.6f},{self.west:.6f},{self.north:.6f},{self.east:.6f}"

    def wanted_tags(self) -> tuple[str, ...]:
        """The OSM tags this query asks for."""
        if not self.tags.strip():
            return DEFAULT_POI_TAGS
        wanted = tuple(
            part.strip()
            for part in self.tags.split(",")
            if part.strip() and part.strip().isidentifier()
        )
        return wanted or DEFAULT_POI_TAGS


class PoiUnavailableError(RuntimeError):
    """The POI source could not be reached, or refused the request."""


def _regex_literal(text: str) -> str:
    """The text as a literal for Overpass's name filter.

    The filter is a regular expression on the server, so a keyword
    containing a metacharacter (`(`, `+`, `.`) must not be allowed to
    change the query's meaning. The escape is the ECMAScript one,
    which is what Overpass's engine understands.
    """
    return "".join(f"\\{char}" if char in _REGEX_METACHARACTERS else char for char in text)


def build_overpass_query(query: PoiQuery) -> str:
    """The Overpass QL for this query.

    Only **nodes** are asked for (see the module docstring): the
    output limit is filled by them first, so adding ways would cost
    the same time and change nothing.

    The keyword filter is a **second filter on the same element**, not
    a second statement: Overpass's union syntax (`(a; b;)`) ORs the
    statements, so a separate name filter would WIDEN the query
    (every POI, plus every POI whose name matches) instead of
    narrowing it. Chained filters (`node["amenity"]["name"~"…"]`) are
    the AND.
    """
    bbox = query.bbox()
    limit = max(1, min(MAX_POI_LIMIT, query.limit))
    keyword = query.keywords.strip()
    name_filter = f'["name"~"{_regex_literal(keyword)}",i]' if keyword else ""
    body = "".join(f'node["{tag}"]{name_filter}({bbox});' for tag in query.wanted_tags())
    return f"[out:json][timeout:{POI_OVERPASS_QUERY_TIMEOUT_S}];" f"({body});" f"out {limit};"


def project_to_scene(
    lon: float,
    lat: float,
    origin_lat: float,
    origin_lon: float,
) -> tuple[float, float]:
    """A WGS84 coordinate as local scene metres (x east, z south).

    The formula is the parser's own (`osm_parser._build_network`):
    `(lon - origin_lon) · 111000 · cos_lat` easting and
    `(lat - origin_lat) · 111000` northing. **The same formula and the
    same origin** — a POI projected differently from its road would sit
    a few metres away from the corner it belongs to.

    An OSM coordinate needs no conversion before this: OSM is WGS84,
    which is the datum the scene's roads are in.
    """
    cos_lat = math.cos(origin_lat * math.pi / 180.0)
    x = (lon - origin_lon) * 111000.0 * cos_lat
    z = (lat - origin_lat) * 111000.0
    return (x, z)


def fetch_osm_pois(query: PoiQuery) -> list[dict[str, Any]]:
    """The POIs inside `query`'s rectangle, as the scene's shape.

    The POIs come back **WGS84 in local scene metres**, ready to be
    rendered.

    Raises:
        PoiUnavailableError: Overpass was unreachable or refused.
    """
    overpass_query = build_overpass_query(query)
    try:
        payload = cached_overpass_fetch(
            overpass_query,
            endpoints=OVERPASS_ENDPOINTS,
            timeout_s=POI_OVERPASS_TIMEOUT_S,
            budget_s=POI_OVERPASS_BUDGET_S,
        )
    except Exception as e:  # noqa: BLE001 - the endpoint turns it into a 502
        raise PoiUnavailableError(f"Overpass is unreachable: {e}") from e

    elements = payload.get("elements")
    if not isinstance(elements, list):
        raise PoiUnavailableError("Overpass answered with no elements")
    pois = [poi for poi in (parse_osm_poi(item, query) for item in elements) if poi is not None]
    return _closest_first(pois, query)


def _closest_first(pois: list[dict[str, Any]], query: PoiQuery) -> list[dict[str, Any]]:
    """The POIs nearest the scene's origin, the rest behind them.

    Overpass returns its elements in its own order, which has nothing
    to do with where they are on the map — so the list is sorted by
    the distance from the origin (the scene's centre) instead.
    """

    def distance(poi: dict[str, Any]) -> float:
        return math.hypot(poi["x"], poi["z"])

    return sorted(pois, key=distance)


def parse_osm_poi(element: Any, query: PoiQuery) -> dict[str, Any] | None:
    """One Overpass element as the scene's shape.

    An Overpass node carries its `lat`/`lon` directly, in **WGS84** —
    the same datum as the scene's roads, so there is no conversion
    here. (A provider's GCJ-02 coordinates would need the inverse
    first; that step is what put a POI hundreds of metres off its
    road when it was missed.)
    """
    if not isinstance(element, dict):
        return None
    element_type = str(element.get("type", "") or "")
    element_id = element.get("id")
    if element_type != "node" or element_id is None:
        return None
    try:
        lon = float(element["lon"])
        lat = float(element["lat"])
    except (KeyError, TypeError, ValueError):
        return None

    tags = element.get("tags")
    tags = tags if isinstance(tags, dict) else {}
    x, z = project_to_scene(lon, lat, query.origin_lat, query.origin_lon)
    tag_key, tag_value = _primary_tag(tags)
    return {
        "id": f"osm-{element_type}-{element_id}",
        "name": str(tags.get("name", "") or ""),
        "type": f"{tag_key}={tag_value}" if tag_key else "",
        "typeCode": tag_key,
        "category": _category_of(tags, tag_key, tag_value),
        "address": _address_of(tags),
        "lon": lon,
        "lat": lat,
        "x": x,
        "z": z,
    }


#: The tags the scene draws points for, in the order they are checked.
#: The first one a POI carries is its own tag; the others are the
#: "also carries" tags (a `shop=car` inside a `building=yes`, say).
_PRIMARY_TAGS: tuple[str, ...] = DEFAULT_POI_TAGS


def _primary_tag(tags: dict[str, Any]) -> tuple[str, str]:
    """The POI's own tag: the first of the drawn tags it carries."""
    for tag in _PRIMARY_TAGS:
        value = tags.get(tag)
        if value:
            return tag, str(value)
    return "", ""


#: The amenity values that name a category, and their plain-language
#: names — the same names the marker palette uses.
_CATEGORY_BY_AMENITY: dict[str, str] = {
    "restaurant": "餐饮",
    "cafe": "餐饮",
    "fast_food": "餐饮",
    "food_court": "餐饮",
    "bar": "餐饮",
    "pub": "餐饮",
    "bbq": "餐饮",
    "ice_cream": "餐饮",
    "hospital": "医疗",
    "clinic": "医疗",
    "doctors": "医疗",
    "pharmacy": "医疗",
    "dentist": "医疗",
    "veterinary": "医疗",
    "school": "教育",
    "kindergarten": "教育",
    "university": "教育",
    "college": "教育",
    "library": "教育",
    "fuel": "交通设施",
    "charging_station": "交通设施",
    "parking": "交通设施",
    "bus_station": "交通设施",
    "bus_stop": "交通设施",
    "taxi_station": "交通设施",
    "ferry_terminal": "交通设施",
    "car_rental": "交通设施",
    "car_repair": "汽车服务",
    "car_parts": "汽车服务",
    "car": "汽车服务",
    "car_sharing": "汽车服务",
    "bank": "生活服务",
    "atm": "生活服务",
    "post_office": "生活服务",
    "post_box": "生活服务",
    "police": "公共设施",
    "fire_station": "公共设施",
    "townhall": "公共设施",
    "courthouse": "公共设施",
    "place_of_worship": "公共设施",
    "community_centre": "公共设施",
    "public_bathroom": "公共设施",
    "theatre": "休闲",
    "cinema": "休闲",
    "nightclub": "休闲",
    "arts_centre": "休闲",
    "golf_course": "休闲",
    "swimming_pool": "休闲",
}

#: The shop values that name a category (the rest are plain 购物).
_CATEGORY_BY_SHOP: dict[str, str] = {
    "car": "汽车服务",
    "car_repair": "汽车服务",
    "car_parts": "汽车服务",
    "tyres": "汽车服务",
    "fuel": "汽车服务",
}

#: The tourism values that name a category.
_CATEGORY_BY_TOURISM: dict[str, str] = {
    "hotel": "住宿",
    "guest_house": "住宿",
    "hostel": "住宿",
    "motel": "住宿",
    "apartment": "住宿",
    "chalet": "住宿",
}

#: The category a tag falls back to when its value is not listed.
_CATEGORY_BY_TAG: dict[str, str] = {
    "amenity": "生活服务",
    "shop": "购物",
    "tourism": "景点",
    "leisure": "休闲",
    "office": "商务",
    "healthcare": "医疗",
    "historic": "景点",
    "public_transport": "交通设施",
    "sport": "休闲",
}


def _category_of(tags: dict[str, Any], tag_key: str, tag_value: str) -> str:
    """The plain-language category of an OSM POI.

    The tag's **value** decides it — `amenity=restaurant` is 餐饮,
    `amenity=hospital` is 医疗 — and the tag decides the fallback
    (`shop=*` is 购物 unless the value says otherwise).
    """
    if tag_key == "amenity" and tag_value in _CATEGORY_BY_AMENITY:
        return _CATEGORY_BY_AMENITY[tag_value]
    if tag_key == "shop" and tag_value in _CATEGORY_BY_SHOP:
        return _CATEGORY_BY_SHOP[tag_value]
    if tag_key == "tourism" and tag_value in _CATEGORY_BY_TOURISM:
        return _CATEGORY_BY_TOURISM[tag_value]
    # A POI can carry several tags — `shop=car` on a node that is also
    # `amenity=car_sharing` — so the other values get a say too.
    for key, table in (
        ("amenity", _CATEGORY_BY_AMENITY),
        ("shop", _CATEGORY_BY_SHOP),
        ("tourism", _CATEGORY_BY_TOURISM),
    ):
        value = str(tags.get(key, "") or "")
        if value in table:
            return table[value]
    if tag_key in _CATEGORY_BY_TAG:
        return _CATEGORY_BY_TAG[tag_key]
    return "POI"


def _address_of(tags: dict[str, Any]) -> str:
    """The POI's street address, when OSM has one.

    OSM's `addr:*` tags are **rare in China** (the surveyed address
    data lives with the local providers, not in OSM) — so most POIs
    come through with an empty address, and the panel says 无地址.
    """
    parts = [
        str(tags.get(key, "") or "").strip()
        for key in (
            "addr:province",
            "addr:city",
            "addr:district",
            "addr:street",
            "addr:housenumber",
        )
    ]
    return "".join(part for part in parts if part)
