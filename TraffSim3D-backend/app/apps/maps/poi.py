"""Real-world points of interest, fetched and placed on the scene's map.

The road network says where the STREETS are; the points of interest say
what is ALONG them — the petrol station at the corner, the hospital, the
school. For a Chinese user the OSM data is often thin, so the POIs come
from a Chinese map provider instead (高德 / AMap), whose data is
**GCJ-02** ("火星坐标", the state-mandated offset datum).

Why the backend fetches
-----------------------
The provider's Web-service API needs an API key, and the key belongs to
whoever runs the deployment (the quota and the bill are theirs). The
browser also cannot be relied on to reach the provider directly (the
API's CORS behaviour is not documented, and a page served from another
origin may simply fail). So the FastAPI process proxies the call, the
same shape as the existing Overpass proxy (`overpass_cache.py`).

The key
-------
Two sources, in this order:

1. the request's own `key` — a user who brought their own key (the
   panel stores it in the browser and sends it along);
2. `TRAFFIC_AMAP_KEY` in the environment — the deployment's key.

With neither, the endpoint refuses with 400 and a message that says
what is missing, rather than calling the provider with an empty key and
reporting its cryptic error.

The coordinates
---------------
The provider's POIs are GCJ-02; the scene is WGS84 in local metres.
Two steps, in this order (the reverse would place the POIs hundreds of
metres off):

1. `coord_transform.to_wgs84` — the GCJ-02 → WGS84 inverse;
2. the **same projection the parser uses** — the roads' own
   `(lon - origin_lon) · 111000 · cos_lat` easting and
   `(lat - origin_lat) · 111000` northing, around the SAME origin.
   A different projection (or a different origin) would put the POIs
   a few metres to tens of metres away from the roads they belong to.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from typing import Any

import httpx2 as httpx  # project uses the httpx2 fork (starlette 1.3+ TestClient)

from .coord_transform import to_wgs84

#: The AMap place-search endpoints (documented at
#: https://lbs.amap.com/api/webservice/guide/api/search).
AMAP_POLYGON_URL = "https://restapi.amap.com/v3/place/polygon"
AMAP_TEXT_URL = "https://restapi.amap.com/v3/place/text"

#: The provider's timeout (s).
AMAP_TIMEOUT_S = 15.0

#: The environment variable holding the deployment's AMap Web-service key.
AMAP_KEY_ENV = "TRAFFIC_AMAP_KEY"

#: The provider's own status code for a well-formed answer.
AMAP_STATUS_OK = "1"


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
    #: The provider's category filter (its `types` codes, pipe-separated).
    types: str = ""
    #: A free-text filter (the provider's `keywords`).
    keywords: str = ""
    #: How many POIs to ask for (the provider's `offset`/`page`).
    limit: int = 25

    def polygon(self) -> str:
        """The rectangle as the provider's `polygon` parameter.

        The provider wants the vertices separated by `;` and each vertex
        as `lon,lat`. The order is the corners' order — clockwise from
        the south-west.
        """
        corners = [
            (self.west, self.south),
            (self.east, self.south),
            (self.east, self.north),
            (self.west, self.north),
        ]
        return ";".join(f"{lon:.6f},{lat:.6f}" for lon, lat in corners)


class PoiUnavailableError(RuntimeError):
    """The provider could not be reached, or refused the request."""


def resolve_amap_key(requested: str | None) -> str:
    """The key to call the provider with.

    The request's own key wins (a user who brought their own); the
    deployment's environment key is the fallback. With neither, the
    caller gets a message that says what is missing.
    """
    key = (requested or "").strip()
    if key:
        return key
    env_key = os.environ.get(AMAP_KEY_ENV, "").strip()
    if env_key:
        return env_key
    raise PoiUnavailableError(
        "no AMap key: send one in the request, or set the "
        f"{AMAP_KEY_ENV} environment variable (a Web-service key from "
        "https://lbs.amap.com/api/webservice/guide/create-key)"
    )


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
    """
    cos_lat = math.cos(origin_lat * math.pi / 180.0)
    x = (lon - origin_lon) * 111000.0 * cos_lat
    z = (lat - origin_lat) * 111000.0
    return (x, z)


def fetch_amap_pois(
    key: str,
    query: PoiQuery,
    *,
    client: httpx.Client | None = None,
) -> list[dict[str, Any]]:
    """Fetch the POIs inside `query`'s rectangle.

    The provider answers GCJ-02; the POIs come back **WGS84 in local
    scene metres**, ready to be rendered.

    Raises:
        PoiUnavailableError: the provider was unreachable or refused.
    """
    if query.keywords:
        url = AMAP_TEXT_URL
        params: dict[str, str | int] = {
            "key": key,
            "keywords": query.keywords,
            "city": query.keywords,
            "offset": max(1, min(25, query.limit)),
            "page": 1,
        }
        if query.types:
            params["types"] = query.types
    else:
        url = AMAP_POLYGON_URL
        params = {
            "key": key,
            "polygon": query.polygon(),
            "offset": max(1, min(25, query.limit)),
            "page": 1,
        }
        if query.types:
            params["types"] = query.types

    try:
        if client is None:
            with httpx.Client(timeout=AMAP_TIMEOUT_S) as owned:
                response = owned.get(url, params=params)
        else:
            response = client.get(url, params=params)
    except httpx.HTTPError as e:
        raise PoiUnavailableError(f"the POI provider is unreachable: {e}") from e

    if response.status_code != 200:
        raise PoiUnavailableError(f"the POI provider answered {response.status_code}")
    try:
        payload = response.json()
    except ValueError as e:
        raise PoiUnavailableError("the POI provider answered with no JSON") from e

    status = str(payload.get("status", ""))
    if status != AMAP_STATUS_OK:
        info = str(payload.get("info", "")).strip()
        raise PoiUnavailableError(f"the POI provider refused the request: {info}")

    pois = payload.get("pois")
    if not isinstance(pois, list):
        return []
    return [poi for poi in (parse_amap_poi(item, query) for item in pois) if poi is not None]


def parse_amap_poi(item: Any, query: PoiQuery) -> dict[str, Any] | None:
    """One provider POI as the scene's shape.

    The provider's `location` is "lon,lat" (documented: 经度在前). The
    POI's own datum is GCJ-02, so it goes through the inverse before
    the projection.
    """
    if not isinstance(item, dict):
        return None
    location = item.get("location")
    if not isinstance(location, str) or "," not in location:
        return None
    lon_text, lat_text = location.split(",", 1)
    try:
        lon = float(lon_text)
        lat = float(lat_text)
    except ValueError:
        return None

    wgs_lat, wgs_lon = to_wgs84(lat, lon, "gcj02")
    x, z = project_to_scene(wgs_lon, wgs_lat, query.origin_lat, query.origin_lon)
    type_code = str(item.get("typecode", "") or "")
    return {
        "id": str(item.get("id", "") or ""),
        "name": str(item.get("name", "") or ""),
        "type": str(item.get("type", "") or ""),
        "typeCode": type_code,
        "category": _category_of(type_code, str(item.get("type", "") or "")),
        "address": str(item.get("address", "") or ""),
        "lon": wgs_lon,
        "lat": wgs_lat,
        "x": x,
        "z": z,
    }


#: The provider's type-code GROUPS and their plain-language names.
#:
#: The provider codes a POI with six digits whose first THREE carry the
#: group (050100 is 餐饮服务 / 咖啡厅 — the group is 050). The groups the
#: scene names are below; anything else falls back to the provider's own
#: `type` string, whose first segment ("餐饮服务") is already a good
#: human name.
_CATEGORY_NAMES: tuple[tuple[str, str], ...] = (
    ("010", "汽车服务"),
    ("020", "汽车销售"),
    ("030", "汽车维修"),
    ("040", "摩托车服务"),
    ("050", "餐饮"),
    ("060", "购物"),
    ("070", "生活服务"),
    ("080", "体育休闲"),
    ("090", "医疗"),
    ("100", "教育"),
    ("110", "交通设施"),
    ("120", "商务"),
    ("130", "住宿"),
    ("140", "风景名胜"),
    ("150", "商务住宅"),
    ("160", "汽车养护"),
    ("170", "美食"),
    ("180", "出行"),
    ("190", "公司企业"),
    ("200", "休闲娱乐"),
    ("220", "公共设施"),
)


def _category_of(type_code: str, type_path: str = "") -> str:
    """The plain-language category of a provider POI.

    The type code's leading three digits carry the group. When the code
    is missing, the provider's `type` path's first segment
    ("餐饮服务") is the name.
    """
    for prefix, name in _CATEGORY_NAMES:
        if type_code.startswith(prefix):
            return name
    if type_path:
        first = type_path.split(";")[0].strip()
        if first:
            return first
    return "POI"
