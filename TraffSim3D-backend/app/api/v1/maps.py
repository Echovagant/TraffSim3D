"""OSM parser HTTP endpoints (XML + PBF).

Both parse endpoints accept an optional bbox
(south, west, north, east) so a user can load only the area they intend to
simulate. The parser capability already existed (`osm_parser.parse_osm_xml`
/ `parse_osmpbf` take a `bbox`); this module only wires it through.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from typing import Any

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from app.apps.maps.osm_parser import BBox, parse_osm_xml, parse_osmpbf
from app.apps.maps.poi import (
    PoiQuery,
    PoiUnavailableError,
    fetch_amap_pois,
    resolve_amap_key,
)
from app.apps.maps.overpass_cache import cached_overpass_fetch, list_cached_queries

router = APIRouter()

# Field order is the bbox tuple order; also the order FastAPI reports in 422
# payloads, so it doubles as the user-facing hint.
_BBOX_FIELDS = ("south", "west", "north", "east")


def _resolve_bbox(
    south: float | None,
    west: float | None,
    north: float | None,
    east: float | None,
) -> BBox | None:
    """Validate the four optional bbox query params into a parser bbox.

    Returns `None` when every param is omitted, which keeps the historical
    behaviour byte-for-byte: the parser then applies its own
    `MAX_BBOX_DEG = 0.5` memory-safety cap.

    Raises:
        HTTPException: 422 when the bbox is partially supplied, inverted, or
            out of the valid lat/lon range (the range itself is enforced by
            the `Query` bounds, so it never reaches here).
    """
    supplied = (south, west, north, east)
    if all(value is None for value in supplied):
        return None
    if any(value is None for value in supplied):
        missing = [
            name for name, value in zip(_BBOX_FIELDS, supplied, strict=True) if value is None
        ]
        raise HTTPException(
            status_code=422,
            detail=(
                "bbox requires all four of south, west, north and east "
                f"(in that order) — missing: {', '.join(missing)}"
            ),
        )
    if south > north:
        raise HTTPException(
            status_code=422,
            detail=f"bbox south must be <= north, got south={south} north={north}",
        )
    if west > east:
        raise HTTPException(
            status_code=422,
            detail=f"bbox west must be <= east, got west={west} east={east}",
        )
    return (south, west, north, east)


def _resolve_coord(coord: str) -> str:
    """Validate the `coord` query param into a supported datum name.

    The parser speaks WGS84; a file exported from 高德 (GCJ-02) or 百度
    (BD-09) has to be converted BEFORE anything reads its coordinates —
    an unknown datum must refuse loudly, because silently treating it
    as WGS84 places the map 300-600 m off with no signal at all.
    """
    from app.apps.maps.coord_transform import SUPPORTED_DATUMS

    if coord not in SUPPORTED_DATUMS:
        raise HTTPException(
            status_code=422,
            detail=f"unknown coord datum {coord!r} — expected one of {', '.join(SUPPORTED_DATUMS)}",
        )
    return coord


@router.post("/maps/parse-osm", tags=["maps"])
async def parse_osm(
    file: UploadFile = File(...),
    south: float | None = Query(default=None, ge=-90, le=90),  # noqa: B008
    west: float | None = Query(default=None, ge=-180, le=180),  # noqa: B008
    north: float | None = Query(default=None, ge=-90, le=90),  # noqa: B008
    east: float | None = Query(default=None, ge=-180, le=180),  # noqa: B008
    coord: str = Query(default="wgs84"),  # noqa: B008
) -> dict[str, Any]:
    """Parse an uploaded .osm file into a RoadNetwork dict.

    Optional bbox query params (south, west, north, east) clip the map to an
    area of interest; omit them all to keep the parser's default
    ~55 km memory-safety cap. `coord` names the datum the FILE's
    coordinates are in (`wgs84` — the default — / `gcj02` / `bd09`);
    anything else is refused with 422. The response shape is identical
    either way.
    """
    datum = _resolve_coord(coord)
    bbox = _resolve_bbox(south, west, north, east)
    raw = await file.read()
    try:
        # The `bbox is None` branch stays a bare positional call so the
        # no-bbox response cannot drift from the pre-bbox behaviour.
        return (
            parse_osm_xml(raw, bbox=bbox, coord_datum=datum)
            if bbox is not None
            else parse_osm_xml(raw, coord_datum=datum)
        )
    except ET.ParseError as e:
        raise HTTPException(status_code=400, detail=f"Invalid OSM XML: {e}") from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OSM parse failed: {e}") from e


@router.post("/maps/parse-pbf", tags=["maps"])
async def parse_pbf(
    file: UploadFile = File(...),
    south: float | None = Query(default=None, ge=-90, le=90),  # noqa: B008
    west: float | None = Query(default=None, ge=-180, le=180),  # noqa: B008
    north: float | None = Query(default=None, ge=-90, le=90),  # noqa: B008
    east: float | None = Query(default=None, ge=-180, le=180),  # noqa: B008
    coord: str = Query(default="wgs84"),  # noqa: B008
) -> dict[str, Any]:
    """Parse an uploaded .osm.pbf file into a RoadNetwork dict.

    Same return shape as /maps/parse-osm. Uses libosmium (osmium Python
    bindings) to stream the binary PBF. Real-world city files (city-scale
    ~20MB, province-scale ~200MB) use this format.

    Takes the same optional bbox and `coord` query params as
    /maps/parse-osm.
    """
    datum = _resolve_coord(coord)
    bbox = _resolve_bbox(south, west, north, east)
    raw = await file.read()
    try:
        return (
            parse_osmpbf(raw, bbox=bbox, coord_datum=datum)
            if bbox is not None
            else parse_osmpbf(raw, coord_datum=datum)
        )
    except ValueError as e:
        # parse_osmpbf wraps libosmium errors as ValueError.
        raise HTTPException(status_code=400, detail=f"Invalid OSM PBF: {e}") from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PBF parse failed: {e}") from e


class PoiRequest(BaseModel):
    """What to fetch: the POIs inside a rectangle of the loaded map.

    The rectangle is in **WGS84 degrees** — the same datum the scene's
    roads are in — and the POIs come back in the scene's local metres.
    """

    #: The rectangle on the map.
    south: float = Field(..., ge=-90, le=90)
    west: float = Field(..., ge=-180, le=180)
    north: float = Field(..., ge=-90, le=90)
    east: float = Field(..., ge=-180, le=180)
    #: The scene's origin (the roads were projected around it).
    origin_lat: float = Field(..., ge=-90, le=90)
    origin_lon: float = Field(..., ge=-180, le=180)
    #: The provider's category filter (its own type codes).
    types: str = ""
    #: A free-text filter.
    keywords: str = ""
    #: How many POIs to ask for.
    limit: int = Field(default=25, ge=1, le=25)
    #: The provider's Web-service key. Optional: the deployment's
    #: `TRAFFIC_AMAP_KEY` is the fallback.
    key: str = ""


@router.post("/maps/poi", tags=["maps"])
def fetch_pois(req: PoiRequest) -> dict[str, Any]:
    """Fetch the real-world points of interest inside a rectangle.

    The POIs come from 高德 (AMap) — whose data is GCJ-02 — and are
    converted to WGS84 and projected around the scene's origin, so a POI
    lands on the corner of the roads it belongs to.

    Errors:
      - 400: no key (neither in the request nor in the environment)
      - 502: the provider was unreachable or refused
    """
    try:
        key = resolve_amap_key(req.key)
    except PoiUnavailableError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    query = PoiQuery(
        south=req.south,
        west=req.west,
        north=req.north,
        east=req.east,
        origin_lat=req.origin_lat,
        origin_lon=req.origin_lon,
        types=req.types,
        keywords=req.keywords,
        limit=req.limit,
    )
    try:
        pois = fetch_amap_pois(key, query)
    except PoiUnavailableError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {
        "source": "amap",
        "count": len(pois),
        "pois": pois,
    }


@router.get("/maps/overpass", tags=["maps"])
async def overpass(query: str = Query(..., min_length=10)) -> dict[str, Any]:
    """Cached Overpass proxy.

    The smart-city view used to call Overpass directly,
    which is unreachable from some networks (overpass-api.de is blocked) and re-fetches
    on every page load. This endpoint forwards the query to Overpass
    once, caches the response to `geojson/cache/<hash>.json`, and
    serves subsequent identical queries from disk.

    Query param:
      `query` — the full Overpass QL string (e.g. `[out:json][timeout:60]; ...`)

    Returns:
      The raw Overpass JSON dict (`{ version, generator, elements }`).
    """
    try:
        return cached_overpass_fetch(query)
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Overpass fetch failed: {e}",
        ) from e


@router.get("/maps/overpass/cache", tags=["maps"])
async def overpass_cache_list() -> dict[str, Any]:
    """List cached Overpass queries (debug UI)."""
    return {"cached": list_cached_queries()}
