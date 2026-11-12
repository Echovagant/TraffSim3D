"""OSM parser HTTP endpoints (XML + PBF).

Both parse endpoints accept an optional bbox
(south, west, north, east) so a user can load only the area they intend to
simulate. The parser capability already existed (`osm_parser.parse_osm_xml`
/ `parse_osmpbf` take a `bbox`); this module only wires it through.
"""

from __future__ import annotations

import asyncio
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from app.apps.maps.osm_parser import (
    BBox,
    attach_traffic_signals,
    parse_osm_xml,
    parse_osmpbf,
)
from app.apps.maps.overpass_cache import cached_overpass_fetch, list_cached_queries
from app.apps.maps.poi import (
    PoiQuery,
    PoiUnavailableError,
    fetch_osm_pois,
)

router = APIRouter()

# Field order is the bbox tuple order; also the order FastAPI reports in 422
# payloads, so it doubles as the user-facing hint.
_BBOX_FIELDS = ("south", "west", "north", "east")

# ---------------------------------------------------------------------------
# The city that ships with the backend
# ---------------------------------------------------------------------------

# The Shenzhen Futian extract, committed to the repo. The path follows the
# same rule as the Overpass cache (`parents[3]/geojson`).
SAMPLE_OSM_FILE = Path(__file__).resolve().parents[3] / "geojson" / "福田中心(深圳).osm"

# (south, west, north, east) — the 4.4 km × 4.7 km core of Futian. It is
# the same rectangle the Smart City basemap fetches (the frontend's
# `DEFAULT_BBOX`), so the drawn city and the simulated city cover one
# area instead of two that merely look alike.
#
# The eastern edge reaches the **春风隧道** (the Chunfeng tunnel), which
# is signed `maxheight=3.5` — the one place in the extract where a
# height limit bites. Including its western mouth is what puts a bus
# somewhere it cannot go, and a height bar on the screen.
#
# The edge is at the tunnel's mouth rather than at its far end on
# purpose: the whole tunnel would add 1 170 roads (the city would more
# than double) and stretch the rectangle into a 9 km strip, for two
# more segments of the same tunnel. Measured (2026-11-12):
#
#   east edge   size        roads   height-limited
#   114.08865   4.4 × 4.0   988     0   (the old rectangle)
#   114.09500   4.4 × 4.7   1 115   2   ← this one
#   114.13865   4.4 × 9.0   2 160   6   (the whole tunnel)
SAMPLE_BBOX: BBox = (22.52297, 114.04865, 22.56297, 114.09500)

# The projection origin: the centre of the clipped area. The frontend
# falls back to the same point for a network that carries no origin, so
# the simulation overlay and the basemap share one anchor.
SAMPLE_CENTER: tuple[float, float] = (
    (SAMPLE_BBOX[0] + SAMPLE_BBOX[2]) / 2,
    (SAMPLE_BBOX[1] + SAMPLE_BBOX[3]) / 2,
)

# The parsed sample network. Built on the first request, then kept.
_sample_network: dict[str, Any] | None = None


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


# ---------------------------------------------------------------------------
# The sample city's traffic signals
# ---------------------------------------------------------------------------

#: The signal nodes of the sample area, as (lat, lon) pairs. Filled from
#: Overpass on the first request and kept in memory afterwards.
_sample_signal_nodes: list[tuple[float, float]] | None = None
#: Whether the cached network has had the signals attached. The attach
#: is idempotent, but a cache hit should not pay for it again.
_sample_signals_attached = False


def _signal_nodes_query(bbox: BBox) -> str:
    """The Overpass query for the traffic-signal nodes of a rectangle.

    Both spellings are needed: a signal is a NODE in most of the world
    and a WAY (the pole) in the rest — and the way's first node is where
    the light stands.
    """
    south, west, north, east = bbox
    return f"""[out:json][timeout:60];
(
  node["highway"="traffic_signals"]({south},{west},{north},{east});
  way["highway"="traffic_signals"]({south},{west},{north},{east});
);
out body;"""


def _fetch_signal_nodes(bbox: BBox) -> list[tuple[float, float]]:
    """The signal nodes of a rectangle, from Overpass (disk-cached).

    The bundled extract was generated from a roads-only GeoJSON, so the
    signal nodes were never in the file: the parsed city had 1 264
    junctions and 16 of them signalised. This puts the lights back.

    The budget is 15 s (not the 60 s the query itself asks Overpass
    for): the endpoint that calls this one serves the WHOLE city, and a
    city that arrives 90 seconds late is worse than a city without its
    extra lights. The response for the bundled rectangle is committed
    to the repository (50 kB), so the demo and the CI never wait for
    Overpass at all — the network is the fallback, not the plan.
    """
    from app.apps.maps.overpass_cache import cached_overpass_fetch

    try:
        data = cached_overpass_fetch(_signal_nodes_query(bbox), timeout_s=15.0, budget_s=20.0)
    except Exception:
        # Overpass is often slow or busy. The city still loads without
        # the extra lights — a missing signal is not a broken map.
        return []
    elements = data.get("elements") or []
    # The nodes, indexed by their id.
    #
    # A signal is a NODE in most of the world and a WAY (the pole) in
    # the rest — and the way's first node is where the light stands.
    # Finding that node used to mean scanning the WHOLE element list
    # once per way: O(ways × elements). The Shenzhen response has
    # ~2 000 elements, so the scan was ~2 000 comparisons per way.
    # One index turns it into a lookup.
    by_id: dict[Any, dict[str, Any]] = {
        element.get("id"): element for element in elements if element.get("type") == "node"
    }
    nodes: list[tuple[float, float]] = []
    for element in elements:
        if element.get("type") == "node":
            lat, lon = element.get("lat"), element.get("lon")
            if lat is not None and lon is not None:
                nodes.append((float(lat), float(lon)))
        elif element.get("type") == "way":
            for ref in element.get("nodes", [])[:1]:
                node = by_id.get(ref)
                if node is None:
                    continue
                lat, lon = node.get("lat"), node.get("lon")
                if lat is not None and lon is not None:
                    nodes.append((float(lat), float(lon)))
                break
    return nodes


@router.get("/maps/signal-nodes", tags=["maps"])
def signal_nodes(
    south: float = Query(..., ge=-90, le=90),
    west: float = Query(..., ge=-180, le=180),
    north: float = Query(..., ge=-90, le=90),
    east: float = Query(..., ge=-180, le=180),
) -> dict[str, Any]:
    """The traffic-signal nodes inside a rectangle (WGS84)."""
    bbox = (south, west, north, east)
    nodes = _fetch_signal_nodes(bbox)
    return {"count": len(nodes), "nodes": [{"lat": lat, "lon": lon} for lat, lon in nodes]}


def _sample_city_network() -> dict[str, Any]:
    """The bundled city, parsed once and kept in memory.

    Shared by `parse-sample` (which hands the whole network out) and
    `sample-stats` (which only counts it) — so both describe the same
    city, and the second one costs nothing after the first.
    """
    global _sample_network, _sample_signal_nodes, _sample_signals_attached
    if _sample_network is None:
        if not SAMPLE_OSM_FILE.exists():
            raise HTTPException(
                status_code=500,
                detail=f"sample map missing from the backend: {SAMPLE_OSM_FILE.name}",
            )
        raw = SAMPLE_OSM_FILE.read_bytes()
        try:
            _sample_network = parse_osm_xml(raw, bbox=SAMPLE_BBOX, center=SAMPLE_CENTER)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"sample parse failed: {e}") from e

    # The lights the source file dropped. They are attached to the
    # CACHED network every time (the geometry is untouched), so the
    # first load that finds the cache and every later one agree.
    # The attach is idempotent but not free (~0.1-0.3 s of distance
    # matching plus geometry rebuilds for every lit junction) — on a
    # cache hit it was pure repetition. Attach ONCE per process.
    if not _sample_signals_attached:
        if _sample_signal_nodes is None:
            _sample_signal_nodes = _fetch_signal_nodes(SAMPLE_BBOX)
        if _sample_signal_nodes:
            attach_traffic_signals(_sample_network, _sample_signal_nodes)
        _sample_signals_attached = True
    return _sample_network


@router.post("/maps/parse-sample", tags=["maps"])
async def parse_sample() -> dict[str, Any]:
    """Parse the city that ships with the backend into a RoadNetwork dict.

    The repository carries a 7.4 MB OSM extract of 深圳福田中心
    (`geojson/福田中心(深圳).osm`). This endpoint parses the 4.4 km ×
    4.1 km core of it — the same rectangle the Smart City basemap draws
    — so the command centre can show a real city with cars driving on
    its roads, without an upload and without Overpass.

    The projection origin is the centre of that rectangle, which is also
    the frontend's fallback tangent origin (`DEFAULT_TANGENT_ORIGIN`):
    the simulation and the basemap therefore describe one place.

    The parse costs ~2 s the first time; the result is cached in memory
    and every later call returns the same network.

    The parse runs in a WORKER THREAD. It is a couple of seconds of
    blocking CPU, and an `async def` endpoint that does it inline
    freezes the whole event loop for that time: the health check, the
    RL status and every other request wait behind the parse. That was
    measurable — a client that asked for the city and for the RL
    capabilities at the same moment lost the second one to its
    timeout.
    """
    return await asyncio.to_thread(_sample_city_network)


@router.get("/maps/sample-stats", tags=["maps"])
async def sample_stats() -> dict[str, Any]:
    """The size of the bundled city — without shipping the whole network.

    A page that states a number ("1 115 roads") should be able to CHECK
    it, and the check should not cost a megabyte of network. This
    endpoint counts the very same city `parse-sample` serves: the same
    file, the same rectangle, the same cached parse — so the numbers
    here describe the city the Smart City view actually drives on.

    The first call pays the parse (in a worker thread — see
    `parse-sample`); every later one is free.
    """
    network = await asyncio.to_thread(_sample_city_network)
    intersections = network.get("intersections") or []
    traffic_lights = sum(len(i.get("trafficLights") or []) for i in intersections)
    return {
        "source": SAMPLE_OSM_FILE.name,
        "roads": len(network.get("roads") or []),
        "intersections": len(intersections),
        "trafficLights": traffic_lights,
        "spawnPoints": len(network.get("spawnPoints") or []),
        "signalsAttached": _sample_signals_attached,
        "bbox": list(SAMPLE_BBOX),
    }


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
    #: The OSM tags to fetch (comma-separated). Empty = the default set.
    tags: str = ""
    #: A free-text filter — only the POIs whose name contains it.
    keywords: str = ""
    #: How many POIs to ask for.
    limit: int = Field(default=25, ge=1, le=200)


@router.post("/maps/poi", tags=["maps"])
def fetch_pois(req: PoiRequest) -> dict[str, Any]:
    """Fetch the real-world points of interest inside a rectangle.

    The POIs come from **OpenStreetMap** (through the public Overpass
    API), whose data is WGS84 — the same datum as the scene's roads —
    so they are only projected around the scene's origin, and a POI
    lands on the corner of the roads it belongs to.

    There is no key: the source is a public, volunteer-run service.

    Errors:
      - 502: Overpass was unreachable or refused
    """
    query = PoiQuery(
        south=req.south,
        west=req.west,
        north=req.north,
        east=req.east,
        origin_lat=req.origin_lat,
        origin_lon=req.origin_lon,
        tags=req.tags,
        keywords=req.keywords,
        limit=req.limit,
    )
    try:
        pois = fetch_osm_pois(query)
    except PoiUnavailableError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {
        "source": "osm",
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
