"""OSM XML / PBF -> RoadNetwork JSON parser.

Returns the network shape directly aligned with the frontend
SerializedScene (schemaVersion 6) — the frontend's own scene format.
Used by the POST /api/v1/maps/parse-osm and /parse-pbf endpoints.

One pipeline, two front-ends
-----------------------------
`parse_osm_xml` and `parse_osmpbf` differ only in how they *extract* raw
OSM objects (ElementTree vs. a libosmium stream). Everything downstream —
clipping, projection, way -> road conversion, intersection detection,
traffic-signal placement, spawn-point generation — happens in one shared
function (`_build_network`).

That is not tidiness for its own sake. The two implementations used to be
~95% copy-paste, and they had already drifted: the PBF path only looked
for `highway=traffic_signals` on *ways*, while the XML path looked at
*node* tags, so the very same data yielded one signal light from XML and
zero from PBF. A single pipeline removes the possibility of that drift.

Clipping happens at way level
-----------------------------
A bbox selects *ways*, not nodes. A way that touches the region is kept
whole — its geometry is never cut at the region border, so an imported map
has no road that ends in the middle of nowhere — and a way entirely
outside is dropped whole. The default `MAX_BBOX_DEG` square around the
projection origin keeps its memory-safety meaning: far-away ways are
still discarded.

Levels
------
A way's vertical level is its OSM `layer` tag: `layer=1` is one level
above the ground, `layer=-1` one below, `layer=0` is the ground. The
value is taken verbatim — it is an integer level, not a boolean
"above/below" flag, and real data uses `layer=2` for a viaduct that
crosses another viaduct and `layer=-3` for a deep underpass.

When a way carries no `layer` tag, the level falls back to the
convention every renderer implements: a bridge sits one level up
(`bridge=yes` and friends), a tunnel one level down (`tunnel=yes`).

A waypoint's height is decided by the *node* it belongs to, not by the
way that owns it: when a node is used by ways on different levels, the
node takes the level closest to the ground. That is what lets a bridge
or tunnel meet the surface road network at its endpoints instead of
floating above it as an isolated island.

Direction
---------
`oneway` is read from the tag, and `oneway=-1` flips the way so that
"forward" is the direction cars actually travel. A `junction=roundabout`
way is one-way even when it carries no `oneway` tag — OSM *implies*
`oneway=yes` for it — and OSM draws roundabout ring ways in the
direction of traffic flow, so the digitisation direction already is the
travel direction and must not be flipped.
"""

from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from collections import Counter
from collections.abc import Sequence
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

# Meters per level step. One `level` step is this many metres, so an OSM
# `layer=2` lands 8 m above the ground and `layer=-3` lands 12 m below it.
# The *step* (not the number of levels) is what has to match the frontend's
# LEVEL_HEIGHT; the frontend has no shared constant for it — only a local
# literal in its demo scene — so the two are kept in step by hand.
LEVEL_HEIGHT = 4.0

# Default clip half-extent in degrees (~55 km at mid-latitudes).
# This is a *memory-safety* cap for oversized `.osm` files, NOT simulation-area
# clipping: 55 km is orders of magnitude larger than any scene this project
# simulates. Pass an explicit `bbox` to actually clip to an area of interest.
MAX_BBOX_DEG = 0.5

BBox = tuple[float, float, float, float]  # (south, west, north, east)

# A spawn point is only worth emitting on a road that can hold a car and
# has more than the single lane a one-way road ends up with.
SPAWN_MIN_ROAD_LENGTH_M = 20.0
SPAWN_MIN_LANES = 2

# OSM `oneway` values meaning "traffic runs along the digitisation direction".
_ONEWAY_FORWARD = frozenset({"yes", "true", "1"})
# OSM `oneway` values meaning "traffic runs against the digitisation direction".
_ONEWAY_REVERSE = frozenset({"-1", "reverse"})

# Tag values that mean "yes" / "no" for tags that are not bare booleans.
_TAG_TRUE = frozenset({"yes", "true", "1"})
_TAG_FALSE = frozenset({"no", "false", "0"})

# `junction` values that describe a one-way circulating ring.
#
# `junction=roundabout` *implies* `oneway=yes` (OSM wiki,
# Tag:junction=roundabout: "|implies=* oneway=yes"), and its ways "must be
# drawn in the direction of traffic flow" — so the digitisation direction
# already IS the travel direction and must not be flipped.
#
# `junction=circular` (a rotary) *requires* an explicit `oneway` tag; without
# one the ring is one-way too, and an explicit `oneway=no` is honoured
# because bi-directional circular junctions do exist.
#
# `junction=mini_roundabout` is not an OSM value (a mini roundabout is
# `highway=mini_roundabout`), but it appears in the wild and means the same.
_IMPLICIT_ONEWAY_JUNCTIONS = frozenset({"roundabout", "circular", "mini_roundabout"})


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


@dataclass
class _RawWay:
    way_id: int
    node_refs: list[int]
    tags: dict[str, str]


def _resolve_center(
    raw_nodes: dict[int, tuple[float, float]],
    center: tuple[float, float] | None,
) -> tuple[float, float]:
    """Projection origin. Defaults to the input's centroid."""
    if center is not None:
        return float(center[0]), float(center[1])
    if not raw_nodes:
        return 0.0, 0.0
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


def _segment_hits_rect(
    p0: tuple[float, float],
    p1: tuple[float, float],
    rect: BBox,
) -> bool:
    """Liang-Barsky clip test: does the segment p0->p1 touch the lat/lon rect?

    Coordinates are (lon, lat); `rect` is (south, west, north, east).
    Touching the border counts as a hit — a road running exactly along the
    edge of the region belongs to that region.
    """
    south, west, north, east = rect
    x0, y0 = p0
    x1, y1 = p1
    dx = x1 - x0
    dy = y1 - y0
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, x0 - west), (dx, east - x0), (-dy, y0 - south), (dy, north - y0)):
        if p == 0.0:
            if q < 0.0:
                return False  # parallel to this edge and outside it
            continue
        r = q / p
        if p < 0.0:
            if r > t1:
                return False
            t0 = max(t0, r)
        else:
            if r < t0:
                return False
            t1 = min(t1, r)
    return True


def _way_touches_rect(
    nodes: dict[int, _Node],
    refs: Sequence[int],
    rect: BBox,
) -> bool:
    """Does this way touch the clip region at all?

    A way counts as inside when one of its vertices is inside, or when one
    of its segments crosses the region — the latter is what keeps a road
    that starts outside and runs through the region from being dropped.
    """
    south, west, north, east = rect
    previous: _Node | None = None
    for ref in refs:
        node = nodes[ref]
        if south <= node.lat <= north and west <= node.lon <= east:
            return True
        if previous is not None and _segment_hits_rect(
            (previous.lon, previous.lat), (node.lon, node.lat), rect
        ):
            return True
        previous = node
    return False


def _parse_layer(tags: dict[str, str]) -> int | None:
    """The `layer` tag as an integer, or None when it is absent/unusable.

    `layer` is OSM's vertical-ordering tag. The OSM wiki keeps it in the
    range -5..5 and says "all ways without an explicit value are assumed to
    have layer 0"; it also notes that "many map rendering and Quality
    Assurance services assume that bridges and tunnels are at layers +1 and
    -1 respectively". Both rules are implemented here — the tag first, the
    bridge/tunnel convention as the fallback.
    """
    raw = tags.get("layer")
    if raw is None:
        return None
    try:
        return int(raw.strip())
    except ValueError:
        return None


def _is_bridge(tags: dict[str, str]) -> bool:
    """Is this way a bridge?

    `bridge=yes` is the common form, but `bridge=viaduct` (and `movable`,
    `proposed`, …) are bridges too — only an explicit negation
    (`bridge=no`) means "not a bridge". A `bridge` value that is not
    `yes` used to be ignored entirely, which left every viaduct on the
    ground.
    """
    value = tags.get("bridge")
    if value is None:
        return False
    return value.strip().lower() not in _TAG_FALSE


def _is_tunnel(tags: dict[str, str]) -> bool:
    """Is this way a tunnel?

    Only `tunnel=yes` (and its synonyms). `tunnel=building_passage` is a
    cut through a building and `tunnel=culvert` is a short drain
    crossing — neither moves the road to another level. When such a way
    really is below ground it carries `layer=-1`, which `_way_level`
    reads first.
    """
    value = tags.get("tunnel")
    if value is None:
        return False
    return value.strip().lower() in _TAG_TRUE


def _way_level(tags: dict[str, str]) -> int:
    """Vertical level of a way: the `layer` tag, else the bridge/tunnel default.

    `layer` is authoritative when present — it is an integer level, so
    `layer=2` is two levels up, not "somewhere above the ground". Only
    when the way has no usable `layer` tag do the bridge/tunnel defaults
    apply: a bridge one level up, a tunnel one level down, ground
    otherwise.
    """
    layer = _parse_layer(tags)
    if layer is not None:
        return layer
    if _is_bridge(tags):
        return 1
    if _is_tunnel(tags):
        return -1
    return 0


def _oneway_direction(tags: dict[str, str]) -> str:
    """Which way traffic runs: "forward", "reverse" or "both".

    An explicit `oneway` tag always wins — including `oneway=no`, because
    the OSM wiki states that bi-directional circular junctions exist and
    "should be tagged with `oneway=no`".

    Only when the tag is absent does the implicit junction rule apply: a
    `junction=roundabout` / `circular` ring is one-way. The direction is
    "forward" because OSM draws roundabout ring ways in the direction of
    traffic flow.
    """
    raw = tags.get("oneway")
    if raw is None:
        junction = tags.get("junction", "").strip().lower()
        if junction in _IMPLICIT_ONEWAY_JUNCTIONS:
            return "forward"
        return "both"
    value = raw.strip().lower()
    if value in _ONEWAY_FORWARD:
        return "forward"
    if value in _ONEWAY_REVERSE:
        return "reverse"
    return "both"


def _pick_level(counter: Counter) -> int:
    """The level a shared node should sit at.

    Ground wins outright, then the most frequently used level, then the
    tunnel over the bridge (a tunnel node reaching the surface is the
    common case; a bridge node reaching it is not).
    """
    return min(counter, key=lambda level: (abs(level), -counter[level], level))


def _polyline_length(waypoints: Sequence[dict[str, Any]]) -> float:
    total = 0.0
    for a, b in zip(waypoints, waypoints[1:], strict=False):
        total += math.dist(
            (float(a.get("x", 0.0)), float(a.get("y", 0.0)), float(a.get("z", 0.0))),
            (float(b.get("x", 0.0)), float(b.get("y", 0.0)), float(b.get("z", 0.0))),
        )
    return total


def _empty_network(origin_lat: float, origin_lon: float) -> dict[str, Any]:
    return {
        "roads": [],
        "intersections": [],
        "vehicles": [],
        "spawnPoints": [],
        "originLat": origin_lat,
        "originLon": origin_lon,
    }


def _build_spawn_points(roads: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """One spawn point per road that can actually hold a car.

    The shape is part of the cross-end contract:
    `{id, roadId, laneIndex, s, occupiedBy}`, where `laneIndex` counts
    lanes in the direction of travel and `s` is the distance along the road
    from its start.
    """
    spawn_points: list[dict[str, Any]] = []
    for road in roads:
        if int(road.get("laneCount", 0)) < SPAWN_MIN_LANES:
            continue
        if _polyline_length(road["waypoints"]) < SPAWN_MIN_ROAD_LENGTH_M:
            continue
        road_id = str(road["id"])
        spawn_points.append(
            {
                "id": f"sp-{road_id}-0",
                "roadId": road_id,
                "laneIndex": 0,
                "s": 0.0,
                "occupiedBy": None,
            }
        )
    return spawn_points


# ---------------------------------------------------------------------------
# Extraction: format-specific, deliberately tiny.
# ---------------------------------------------------------------------------


def _extract_osm_xml(
    xml_bytes: bytes,
) -> tuple[dict[int, tuple[float, float]], list[_RawWay], set[int]]:
    """Pull raw nodes, highway ways and traffic-signal nodes out of an OSM XML tree."""
    root = ET.fromstring(xml_bytes)

    raw_nodes: dict[int, tuple[float, float]] = {}
    signal_node_ids: set[int] = set()
    for element in root.iter("node"):
        try:
            node_id = int(element.attrib["id"])
            lat = float(element.attrib["lat"])
            lon = float(element.attrib["lon"])
        except (KeyError, ValueError):
            continue
        raw_nodes[node_id] = (lat, lon)
        tags = {t.attrib["k"]: t.attrib["v"] for t in element.iter("tag")}
        # `highway=traffic_signals` is a *node* tag in OSM.
        if tags.get("highway") == "traffic_signals":
            signal_node_ids.add(node_id)

    raw_ways: list[_RawWay] = []
    for element in root.iter("way"):
        tags = {t.attrib["k"]: t.attrib["v"] for t in element.iter("tag")}
        highway = tags.get("highway")
        if highway not in DEFAULT_HIGHWAY_TYPES and highway != "traffic_signals":
            continue
        try:
            way_id = int(element.attrib["id"])
        except (KeyError, ValueError):
            continue
        refs: list[int] = []
        for nd in element.iter("nd"):
            try:
                refs.append(int(nd.attrib["ref"]))
            except (KeyError, ValueError):
                continue
        raw_ways.append(_RawWay(way_id, refs, tags))

    return raw_nodes, raw_ways, signal_node_ids


def _extract_osm_pbf(
    pbf_bytes: bytes,
) -> tuple[dict[int, tuple[float, float]], list[_RawWay], set[int]]:
    """Pull the same three things out of a PBF stream using libosmium."""
    import osmium

    class _Handler(osmium.SimpleHandler):
        def __init__(self) -> None:
            super().__init__()
            self.raw_nodes: dict[int, tuple[float, float]] = {}
            self.raw_ways: list[_RawWay] = []
            self.signal_node_ids: set[int] = set()

        def node(self, n: osmium.osm.Node) -> None:
            self.raw_nodes[n.id] = (n.location.lat, n.location.lon)
            tags = {t.k: t.v for t in n.tags}
            # `highway=traffic_signals` is a *node* tag in OSM — the PBF path
            # used to look at ways only, and silently produced zero signals.
            if tags.get("highway") == "traffic_signals":
                self.signal_node_ids.add(n.id)

        def way(self, w: osmium.osm.Way) -> None:
            tags = {t.k: t.v for t in w.tags}
            highway = tags.get("highway")
            if highway not in DEFAULT_HIGHWAY_TYPES and highway != "traffic_signals":
                return
            self.raw_ways.append(_RawWay(w.id, [nd.ref for nd in w.nodes], tags))

    handler = _Handler()
    try:
        # osmium 4.x: SimpleHandler.apply_buffer(buffer, format, locations).
        # We pass 'pbf' explicitly so osmium doesn't need to sniff from
        # file extension (we're passing bytes, not a path).
        handler.apply_buffer(pbf_bytes, "pbf", locations=True)
    except Exception as e:
        raise ValueError(f"Invalid PBF: {e}") from e

    return handler.raw_nodes, handler.raw_ways, handler.signal_node_ids


# ---------------------------------------------------------------------------
# Shared pipeline: raw OSM objects -> RoadNetwork.
# ---------------------------------------------------------------------------


def _build_network(
    raw_nodes: dict[int, tuple[float, float]],
    raw_ways: Sequence[_RawWay],
    traffic_signal_node_ids: set[int],
    bbox: BBox | None = None,
    center: tuple[float, float] | None = None,
    *,
    road_id_prefix: str = "w-",
    intersection_id_prefix: str = "i-osm-",
) -> dict[str, Any]:
    """The one and only way->road->intersection pipeline.

    `raw_nodes`: node id -> (lat, lon)
    `raw_ways`: ways with their node references and tags
    `traffic_signal_node_ids`: nodes carrying `highway=traffic_signals`
    """
    origin_lat, origin_lon = _resolve_center(raw_nodes, center)
    if not raw_nodes:
        return _empty_network(origin_lat, origin_lon)
    if bbox is not None:
        _validate_bbox(bbox)

    # ---- 1) Project every node to world meters (centered) ----
    cos_lat = math.cos(origin_lat * math.pi / 180.0)
    nodes: dict[int, _Node] = {
        node_id: _Node(
            id=node_id,
            lat=lat,
            lon=lon,
            x=(lon - origin_lon) * 111000.0 * cos_lat,
            z=(lat - origin_lat) * 111000.0,
        )
        for node_id, (lat, lon) in raw_nodes.items()
    }

    # ---- 2) Clip at way level: a touching way is kept whole ----
    region: BBox = (
        bbox
        if bbox is not None
        else (
            origin_lat - MAX_BBOX_DEG,
            origin_lon - MAX_BBOX_DEG,
            origin_lat + MAX_BBOX_DEG,
            origin_lon + MAX_BBOX_DEG,
        )
    )
    kept: list[_RawWay] = []
    for way in raw_ways:
        if way.tags.get("highway") not in DEFAULT_HIGHWAY_TYPES:
            continue
        refs = [ref for ref in way.node_refs if ref in nodes]
        if len(refs) < 2:
            continue
        if not _way_touches_rect(nodes, refs, region):
            continue
        kept.append(_RawWay(way.way_id, refs, way.tags))

    # ---- 3) One height per node, so shared nodes really are shared ----
    node_levels: dict[int, Counter] = {}
    for way in kept:
        level = _way_level(way.tags)
        for ref in way.node_refs:
            counter = node_levels.setdefault(ref, Counter())
            counter[level] += 1
    node_level = {ref: _pick_level(counter) for ref, counter in node_levels.items()}

    # ---- 4) Ways -> roads ----
    roads: list[dict[str, Any]] = []
    for way in kept:
        level = _way_level(way.tags)
        direction = _oneway_direction(way.tags)
        oneway = direction != "both"
        refs = list(way.node_refs)
        if direction == "reverse":
            # Traffic runs against the digitisation direction: flip the way so
            # "forward" means the direction cars actually travel.
            refs.reverse()
        try:
            lanes = max(1, int(way.tags.get("lanes", "2")))
        except ValueError:
            lanes = 2
        if oneway:
            lanes = max(1, lanes // 2)
        waypoints = [
            {
                "x": nodes[ref].x,
                "y": node_level.get(ref, level) * LEVEL_HEIGHT,
                "z": nodes[ref].z,
            }
            for ref in refs
        ]
        roads.append(
            {
                "id": f"{road_id_prefix}{way.way_id}",
                "startNode": waypoints[0],
                "endNode": waypoints[-1],
                "waypoints": waypoints,
                "laneCount": lanes,
                "oneway": oneway,
                "speedLimit": HIGHWAY_SPEED_LIMIT[way.tags["highway"]],
                "level": level,
            }
        )

    # ---- 5) Traffic signals marked on a way rather than on a node ----
    # Legacy behaviour of the PBF path, now applied to both formats.
    signal_node_ids = set(traffic_signal_node_ids)
    for way in raw_ways:
        if way.tags.get("highway") == "traffic_signals" and way.node_refs:
            signal_node_ids.add(way.node_refs[0])

    # ---- 6) Intersections: OSM nodes shared by two or more ways ----
    node_to_ways: dict[int, list[int]] = {}
    for index, way in enumerate(kept):
        for ref in way.node_refs:
            bucket = node_to_ways.setdefault(ref, [])
            if index not in bucket:
                bucket.append(index)

    intersections: list[dict[str, Any]] = []
    inter_counter = 0
    for ref, way_indices in node_to_ways.items():
        if len(way_indices) < 2:
            continue
        node = nodes[ref]
        height = node_level.get(ref, 0) * LEVEL_HEIGHT
        inter_id = f"{intersection_id_prefix}{inter_counter}"
        inter_counter += 1
        traffic_lights: list[dict[str, Any]] = []
        if ref in signal_node_ids:
            # Heuristic axis: pick the first two-way pair's "primary" road.
            primary_road = roads[way_indices[0]]
            # axis from waypoints: EW if dx > dz, else NS.
            dx = primary_road["endNode"]["x"] - primary_road["startNode"]["x"]
            axis = "ew" if abs(dx) > 0.1 else "ns"
            traffic_lights.append(
                {
                    "id": f"tl-{inter_counter}-{axis}",
                    "position": {
                        "x": node.x - 3 if axis == "ew" else node.x,
                        "y": height,
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
                "position": {"x": node.x, "y": height, "z": node.z},
                "trafficLights": traffic_lights,
                "connectedRoads": [roads[i]["id"] for i in way_indices],
                "intersectionRadius": 8,
            }
        )

    return {
        "roads": roads,
        "intersections": intersections,
        "vehicles": [],
        "spawnPoints": _build_spawn_points(roads),
        "originLat": origin_lat,
        "originLon": origin_lon,
    }


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
    raw_nodes, raw_ways, signal_node_ids = _extract_osm_xml(xml_bytes)
    return _build_network(
        raw_nodes,
        raw_ways,
        signal_node_ids,
        bbox=bbox,
        center=center,
        road_id_prefix="w-",
        intersection_id_prefix="i-osm-",
    )


def parse_osmpbf(
    pbf_bytes: bytes,
    bbox: BBox | None = None,
    center: tuple[float, float] | None = None,
) -> dict[str, Any]:
    """Streaming PBF parser using libosmium. Same return shape as
    parse_osm_xml — frontend's `loadNetwork` accepts either.

    `bbox` / `center` behave exactly as in `parse_osm_xml`, and the two
    formats run through the same pipeline, so the same logical data yields
    the same geometry, lanes and traffic lights either way.

    Raises ValueError on malformed PBF (e.g. invalid magic, corrupt
    block, missing required fields).
    """
    raw_nodes, raw_ways, signal_node_ids = _extract_osm_pbf(pbf_bytes)
    return _build_network(
        raw_nodes,
        raw_ways,
        signal_node_ids,
        bbox=bbox,
        center=center,
        road_id_prefix="w-pbf-",
        intersection_id_prefix="i-pbf-",
    )
