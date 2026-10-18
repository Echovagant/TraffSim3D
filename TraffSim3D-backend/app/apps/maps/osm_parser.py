"""OSM XML -> RoadNetwork JSON parser. Plan 041.

Returns the network shape directly aligned with the frontend
SerializedScene (schemaVersion 6) — see ADR-006 for
the full plan. Used by the POST /api/v1/maps/parse-osm endpoint.

MVP scope:
- XML only (PBF deferred)
- highway tags only (buildings/relations deferred)
- simple lat/lon -> meters projection (WGS84/WM deferred)
- stateless (no PostGIS)
"""

from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Any

# m/s. Keys match OSM highway=* tag values.
HIGHWAY_SPEED_LIMIT: dict[str, float] = {
    "motorway": 33.3,
    "motorway_link": 22.2,
    "trunk": 27.8,
    "trunk_link": 16.7,
    "primary": 22.2,
    "primary_link": 13.89,
    "secondary": 19.4,
    "secondary_link": 11.11,
    "tertiary": 16.7,
    "tertiary_link": 9.72,
    "residential": 13.89,
    "service": 8.33,
    "unclassified": 13.89,
}
DEFAULT_HIGHWAY_TYPES = frozenset(HIGHWAY_SPEED_LIMIT.keys())

# Meters per level step — must match frontend LEVEL_HEIGHT in simulation constants.
LEVEL_HEIGHT = 4.0

# Default clip half-extent in degrees (~55 km at mid-latitudes).
# This is a *memory-safety* cap for oversized `.osm` files, NOT simulation-area
# clipping: 55 km is orders of magnitude larger than any scene this project
# simulates. Pass an explicit `bbox` to actually clip to an area of interest.
MAX_BBOX_DEG = 0.5

BBox = tuple[float, float, float, float]  # (south, west, north, east)


def _resolve_center(
    raw_nodes: dict[int, tuple[float, float]],
    center: tuple[float, float] | None,
) -> tuple[float, float]:
    """Projection origin. Defaults to the input's centroid."""
    if center is not None:
        return float(center[0]), float(center[1])
    return (
        sum(n[0] for n in raw_nodes.values()) / len(raw_nodes),
        sum(n[1] for n in raw_nodes.values()) / len(raw_nodes),
    )


def _validate_bbox(bbox: BBox) -> None:
    south, west, north, east = bbox
    if south > north:
        raise ValueError(f"bbox south must be <= north, got south={south} north={north}")
    if west > east:
        raise ValueError(f"bbox west must be <= east, got west={west} east={east}")


def _project_nodes(
    raw_nodes: dict[int, tuple[float, float]],
    center: tuple[float, float] | None = None,
    bbox: BBox | None = None,
) -> tuple[dict[int, _Node], float, float]:
    """lat/lon -> world meters, dropping anything outside `bbox`.

    Shared by the XML and PBF pipelines so the clip semantics cannot drift
    apart between them. Returns `(nodes, center_lat, center_lon)`.
    """
    if bbox is not None:
        _validate_bbox(bbox)
    center_lat, center_lon = _resolve_center(raw_nodes, center)
    cos_lat = math.cos(center_lat * math.pi / 180.0)

    half = None if bbox is not None else MAX_BBOX_DEG
    south = west = north = east = None
    if bbox is not None:
        south, west, north, east = bbox

    nodes: dict[int, _Node] = {}
    for nid, (lat, lon) in raw_nodes.items():
        if half is not None:
            # Centred square safety cap around the projection origin.
            if abs(lat - center_lat) > half or abs(lon - center_lon) > half:
                continue
        else:
            assert south is not None and west is not None
            assert north is not None and east is not None
            if not (south <= lat <= north and west <= lon <= east):
                continue
        x = (lon - center_lon) * 111000.0 * cos_lat
        z = (lat - center_lat) * 111000.0
        nodes[nid] = _Node(id=nid, lat=lat, lon=lon, x=x, z=z)
    return nodes, center_lat, center_lon


@dataclass(frozen=True)
class LatLon:
    lat: float
    lon: float


@dataclass
class _Node:
    id: int
    lat: float
    lon: float
    x: float  # meters east of center
    z: float  # meters south of center (lat increase = z increase)


def parse_osm_xml(
    xml_bytes: bytes,
    bbox: BBox | None = None,
    center: tuple[float, float] | None = None,
) -> dict[str, Any]:
    """Parse an OSM XML byte payload into a RoadNetwork dict.

    Returned shape matches the frontend SerializedScene (no schemaVersion
    wrapper) so the frontend can call `loadNetwork(parsed)` directly.

    `bbox` (south, west, north, east) in degrees clips the map to an area of
    interest. Omitting it keeps the historical ~55 km safety cap, so existing
    callers are unaffected.
    """
    root = ET.fromstring(xml_bytes)

    # ---- 1) Parse all nodes with lat/lon ----
    raw_nodes: dict[int, tuple[float, float]] = {}
    for n in root.iter("node"):
        nid = int(n.attrib["id"])
        try:
            lat = float(n.attrib["lat"])
            lon = float(n.attrib["lon"])
        except (KeyError, ValueError):
            continue
        raw_nodes[nid] = (lat, lon)

    if not raw_nodes:
        return {"roads": [], "intersections": [], "vehicles": [], "spawnPoints": []}

    # ---- 2) Project to world coords (meters, centered), clipped ----
    nodes, center_lat, center_lon = _project_nodes(raw_nodes, center, bbox)

    # ---- 3) Parse ways -> roads ----
    roads: list[dict[str, Any]] = []
    way_node_ids: list[list[int]] = []  # parallel to roads; raw node id sequence
    traffic_signal_node_ids: set[int] = set()
    used_node_ids: set[int] = set()

    for w in root.iter("way"):
        tags = {t.attrib["k"]: t.attrib["v"] for t in w.iter("tag")}
        highway = tags.get("highway")
        if highway not in DEFAULT_HIGHWAY_TYPES:
            continue

        nd_refs = [int(nd.attrib["ref"]) for nd in w.iter("nd")]
        nd_refs = [nid for nid in nd_refs if nid in nodes]
        if len(nd_refs) < 2:
            continue

        used_node_ids.update(nd_refs)
        way_node_ids.append(nd_refs)

        if tags.get("bridge") == "yes":
            level = 1
        elif tags.get("tunnel") == "yes":
            level = -1
        else:
            level = 0

        waypoints = [
            {"x": nodes[nid].x, "y": level * LEVEL_HEIGHT, "z": nodes[nid].z} for nid in nd_refs
        ]
        a, b = waypoints[0], waypoints[-1]

        # Tag-derived attributes
        try:
            lanes = max(1, int(tags.get("lanes", "2")))
        except ValueError:
            lanes = 2
        oneway = tags.get("oneway", "no").lower() in ("yes", "true", "1")
        if oneway:
            lanes = max(1, lanes // 2)

        speed_limit = HIGHWAY_SPEED_LIMIT[highway]
        way_id = f"w-{w.attrib['id']}"
        roads.append(
            {
                "id": way_id,
                "startNode": a,
                "endNode": b,
                "waypoints": waypoints,
                "laneCount": lanes,
                "speedLimit": speed_limit,
                "level": level,
            }
        )

    # ---- 4) Traffic signal nodes -> bucket for intersection step ----
    for n in root.iter("node"):
        tags = {t.attrib["k"]: t.attrib["v"] for t in n.iter("tag")}
        if tags.get("highway") == "traffic_signals":
            try:
                nid = int(n.attrib["id"])
            except (KeyError, ValueError):
                continue
            if nid in nodes:
                traffic_signal_node_ids.add(nid)

    # ---- 5) Find intersections (shared nodes between >= 2 ways) ----
    node_to_ways: dict[int, list[int]] = {}
    for ridx, nids in enumerate(way_node_ids):
        for nid in nids:
            node_to_ways.setdefault(nid, []).append(ridx)

    intersections: list[dict[str, Any]] = []
    used_intersection_node_ids: set[int] = set()
    inter_counter = 0
    for nid, way_idxs in node_to_ways.items():
        if len(way_idxs) < 2:
            continue
        if nid not in used_node_ids:
            continue
        node = nodes[nid]
        inter_id = f"i-osm-{inter_counter}"
        inter_counter += 1
        traffic_lights: list[dict[str, Any]] = []
        if nid in traffic_signal_node_ids:
            # Heuristic axis: pick the first two-way pair's "primary" road.
            primary_road = roads[way_idxs[0]]
            # axis from waypoints: EW if dx > dz, else NS.
            dx = primary_road["endNode"]["x"] - primary_road["startNode"]["x"]
            axis = "ew" if abs(dx) > 0.1 else "ns"
            traffic_lights.append(
                {
                    "id": f"tl-{inter_counter}-{axis}",
                    "position": {
                        "x": node.x - 3 if axis == "ew" else node.x,
                        "y": 0.0,
                        "z": node.z if axis == "ew" else node.z - 3,
                    },
                    "phase": "green" if axis == "ns" else "red",
                    "phaseRemaining": 30,
                    "cycleSeconds": 63,
                    "axis": axis,
                }
            )
        intersections.append(
            {
                "id": inter_id,
                "position": {"x": node.x, "y": 0.0, "z": node.z},
                "trafficLights": traffic_lights,
                "connectedRoads": [roads[i]["id"] for i in way_idxs],
                "intersectionRadius": 8,
            }
        )
        used_intersection_node_ids.add(nid)

    return {
        "roads": roads,
        "intersections": intersections,
        "vehicles": [],
        "spawnPoints": [],
    }


# ---------------------------------------------------------------------------
# Plan 046: OSM PBF parser (.osm.pbf -> RoadNetwork).
#
# Uses libosmium (osmium Python bindings) for streaming PBF parsing.
# The shared projection + way-to-road + intersection logic is the
# same as parse_osm_xml; we extract the intermediate (raw_nodes,
# raw_ways, traffic_signal_node_ids) from the PBF stream and feed
# it through the same pipeline.
# ---------------------------------------------------------------------------


def _build_network(
    raw_nodes: dict[int, tuple[float, float]],
    raw_ways: list[tuple[int, list[int], dict[str, str]]],
    traffic_signal_node_ids: set[int],
    bbox: BBox | None = None,
    center: tuple[float, float] | None = None,
) -> dict[str, Any]:
    """Shared pipeline: project + ways -> roads + intersections.

    `raw_nodes`: node id -> (lat, lon)
    `raw_ways`: list of (way_id, [node_id, ...], {tag_k: tag_v, ...})
    `traffic_signal_node_ids`: node ids with highway=traffic_signals
    """
    if not raw_nodes:
        return {"roads": [], "intersections": [], "vehicles": [], "spawnPoints": []}

    # ---- 2) Project to world coords (meters, centered), clipped ----
    nodes, center_lat, center_lon = _project_nodes(raw_nodes, center, bbox)

    # ---- 3) Ways -> roads (same logic as XML pipeline) ----
    roads: list[dict[str, Any]] = []
    way_node_ids: list[list[int]] = []
    used_node_ids: set[int] = set()

    for way_id, nd_refs, tags in raw_ways:
        highway = tags.get("highway")
        if highway not in DEFAULT_HIGHWAY_TYPES:
            continue
        nd_refs = [nid for nid in nd_refs if nid in nodes]
        if len(nd_refs) < 2:
            continue

        used_node_ids.update(nd_refs)
        way_node_ids.append(nd_refs)

        if tags.get("bridge") == "yes":
            level = 1
        elif tags.get("tunnel") == "yes":
            level = -1
        else:
            level = 0

        waypoints = [
            {"x": nodes[nid].x, "y": level * LEVEL_HEIGHT, "z": nodes[nid].z} for nid in nd_refs
        ]
        a, b = waypoints[0], waypoints[-1]

        try:
            lanes = max(1, int(tags.get("lanes", "2")))
        except ValueError:
            lanes = 2
        oneway = tags.get("oneway", "no").lower() in ("yes", "true", "1")
        if oneway:
            lanes = max(1, lanes // 2)

        speed_limit = HIGHWAY_SPEED_LIMIT[highway]
        road_id = f"w-pbf-{way_id}"
        roads.append(
            {
                "id": road_id,
                "startNode": a,
                "endNode": b,
                "waypoints": waypoints,
                "laneCount": lanes,
                "speedLimit": speed_limit,
                "level": level,
            }
        )

    # ---- 5) Find intersections (shared nodes between >= 2 ways) ----
    node_to_ways: dict[int, list[int]] = {}
    for ridx, nids in enumerate(way_node_ids):
        for nid in nids:
            node_to_ways.setdefault(nid, []).append(ridx)

    intersections: list[dict[str, Any]] = []
    used_intersection_node_ids: set[int] = set()
    inter_counter = 0
    for nid, way_idxs in node_to_ways.items():
        if len(way_idxs) < 2:
            continue
        if nid not in used_node_ids:
            continue
        node = nodes[nid]
        inter_id = f"i-pbf-{inter_counter}"
        inter_counter += 1
        traffic_lights: list[dict[str, Any]] = []
        if nid in traffic_signal_node_ids:
            primary_road = roads[way_idxs[0]]
            dx = primary_road["endNode"]["x"] - primary_road["startNode"]["x"]
            axis = "ew" if abs(dx) > 0.1 else "ns"
            traffic_lights.append(
                {
                    "id": f"tl-{inter_counter}-{axis}",
                    "position": {
                        "x": node.x - 3 if axis == "ew" else node.x,
                        "y": 0.0,
                        "z": node.z if axis == "ew" else node.z - 3,
                    },
                    "phase": "green" if axis == "ns" else "red",
                    "phaseRemaining": 30,
                    "cycleSeconds": 63,
                    "axis": axis,
                }
            )
        intersections.append(
            {
                "id": inter_id,
                "position": {"x": node.x, "y": 0.0, "z": node.z},
                "trafficLights": traffic_lights,
                "connectedRoads": [roads[i]["id"] for i in way_idxs],
                "intersectionRadius": 8,
            }
        )
        used_intersection_node_ids.add(nid)

    return {
        "roads": roads,
        "intersections": intersections,
        "vehicles": [],
        "spawnPoints": [],
    }


def parse_osmpbf(
    pbf_bytes: bytes,
    bbox: BBox | None = None,
    center: tuple[float, float] | None = None,
) -> dict[str, Any]:
    """Streaming PBF parser using libosmium. Same return shape as
    parse_osm_xml — frontend's `loadNetwork` accepts either.

    `bbox` / `center` behave exactly as in `parse_osm_xml`.

    Raises ValueError on malformed PBF (e.g. invalid magic, corrupt
    block, missing required fields).
    """
    import osmium  # libosmium Python bindings (already in pyproject)

    class _Handler(osmium.SimpleHandler):
        def __init__(self) -> None:
            super().__init__()
            self.raw_nodes: dict[int, tuple[float, float]] = {}
            self.raw_ways: list[tuple[int, list[int], dict[str, str]]] = []
            self.traffic_signal_node_ids: set[int] = set()

        def node(self, n: osmium.osm.Node) -> None:
            self.raw_nodes[n.id] = (n.location.lat, n.location.lon)

        def way(self, w: osmium.osm.Way) -> None:
            tags = {t.k: t.v for t in w.tags}
            self.raw_ways.append((w.id, [n.ref for n in w.nodes], tags))
            if tags.get("highway") == "traffic_signals":
                # The way's first node is the traffic-signal location
                if w.nodes:
                    self.traffic_signal_node_ids.add(w.nodes[0].ref)

    handler = _Handler()
    try:
        # osmium 4.x: SimpleHandler.apply_buffer(buffer, format, locations).
        # We pass 'pbf' explicitly so osmium doesn't need to sniff from
        # file extension (we're passing bytes, not a path).
        import osmium

        handler.apply_buffer(pbf_bytes, "pbf", locations=True)
    except Exception as e:
        raise ValueError(f"Invalid PBF: {e}") from e

    return _build_network(
        handler.raw_nodes,
        handler.raw_ways,
        handler.traffic_signal_node_ids,
        bbox=bbox,
        center=center,
    )
