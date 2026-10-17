"""Plan 041 + 046: OSM parser HTTP endpoints (XML + PBF).

M3 follow-up: both parse endpoints accept an optional bbox
(south, west, north, east) so a user can load only the area they intend to
simulate. The parser capability already existed (`osm_parser.parse_osm_xml`
/ `parse_osmpbf` take a `bbox`); this module only wires it through.
"""
from __future__ import annotations

import xml.etree.ElementTree as ET
from typing import Any

from fastapi import APIRouter, File, HTTPException, Query, UploadFile

from app.apps.maps.osm_parser import BBox, parse_osm_xml, parse_osmpbf
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


@router.post("/maps/parse-osm", tags=["maps"])
async def parse_osm(
    file: UploadFile = File(...),
    south: float | None = Query(default=None, ge=-90, le=90),  # noqa: B008
    west: float | None = Query(default=None, ge=-180, le=180),  # noqa: B008
    north: float | None = Query(default=None, ge=-90, le=90),  # noqa: B008
    east: float | None = Query(default=None, ge=-180, le=180),  # noqa: B008
) -> dict[str, Any]:
    """Parse an uploaded .osm file into a RoadNetwork dict.

    Optional bbox query params (south, west, north, east) clip the map to an
    area of interest; omit them all to keep the parser's default
    ~55 km memory-safety cap. The response shape is identical either way.
    """
    bbox = _resolve_bbox(south, west, north, east)
    raw = await file.read()
    try:
        # The `bbox is None` branch stays a bare positional call so the
        # no-bbox response cannot drift from the pre-bbox behaviour.
        return parse_osm_xml(raw) if bbox is None else parse_osm_xml(raw, bbox=bbox)
    except ET.ParseError as e:
        raise HTTPException(
            status_code=400, detail=f"Invalid OSM XML: {e}"
        ) from e
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"OSM parse failed: {e}"
        ) from e


@router.post("/maps/parse-pbf", tags=["maps"])
async def parse_pbf(
    file: UploadFile = File(...),
    south: float | None = Query(default=None, ge=-90, le=90),  # noqa: B008
    west: float | None = Query(default=None, ge=-180, le=180),  # noqa: B008
    north: float | None = Query(default=None, ge=-90, le=90),  # noqa: B008
    east: float | None = Query(default=None, ge=-180, le=180),  # noqa: B008
) -> dict[str, Any]:
    """Parse an uploaded .osm.pbf file into a RoadNetwork dict.

    Same return shape as /maps/parse-osm. Uses libosmium (osmium Python
    bindings) to stream the binary PBF. Real-world city files (Shenzhen
    ~20MB, Guangdong ~200MB) use this format.

    Takes the same optional bbox query params as /maps/parse-osm.
    """
    bbox = _resolve_bbox(south, west, north, east)
    raw = await file.read()
    try:
        return parse_osmpbf(raw) if bbox is None else parse_osmpbf(raw, bbox=bbox)
    except ValueError as e:
        # parse_osmpbf wraps libosmium errors as ValueError.
        raise HTTPException(
            status_code=400, detail=f"Invalid OSM PBF: {e}"
        ) from e
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"PBF parse failed: {e}"
        ) from e



@router.get("/maps/overpass", tags=["maps"])
async def overpass(query: str = Query(..., min_length=10)) -> dict[str, Any]:
    """Plan 056: cached Overpass proxy.

    The smart-city view (Plan 055) used to call Overpass directly,
    which fails in China (overpass-api.de is blocked) and re-fetches
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
    """Plan 056: list cached Overpass queries (debug UI)."""
    return {"cached": list_cached_queries()}