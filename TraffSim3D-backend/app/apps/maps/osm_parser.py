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

Clipping happens on the geometry
------------------------------
A bbox selects an *area*, and the geometry inside it is cut at the
border. A way that crosses the region is cut where it leaves it; a way
that enters the region, leaves it and comes back becomes **two** roads.
The cut points are interpolated on the border and inherit the height of
the nearest original node; they are not OSM nodes, so the border itself
never becomes a junction — only a node shared by two surviving ways does.

The rule used to be the opposite: a way that touched the region was kept
*whole*. That made the promise the UI makes (「只加载仿真区域」) untrue. On
the Shenzhen extract, a 2.2 km request came back with a 7.9 km network,
because one arterial way that merely touched the region stretched the
whole map — and a camera framing 7.9 km puts a 4.2 m car at 0.2 px.

The default `MAX_BBOX_DEG` square around the projection origin goes
through the same path, so the memory-safety cap is a real area bound.

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

Where the junction is, and where the cars appear
-------------------------------------------------
An intersection is an OSM node shared by two or more ways; its position
is that node's projected coordinate. A junction is therefore almost never
in the *middle* of a way — it sits at one of the way's endpoints.

Both ends of the pipeline project the junction onto the road to find out
where it actually is: the backend (`_project_intersection_on_road`) and
the frontend (`projectIntersectionOnRoad` in
`TraffSim3D-frontend/src/domain/services/laneGeometry.ts`) run the same
algorithm and reject the same projections, so the stop line the frontend
draws and the spawn point the backend emits refer to the same place on
the same road.

That projection also decides where the cars appear. Spawning at `s = 0`
(the road's start) used to drop every imported car into a junction,
because the road's start is where the junction usually is. The spawn
point now goes to the end of the road that is furthest from every
junction on it (`_spawn_arc_length`).

How big the junction box is
---------------------------
The box is not a decoration: the stop line sits on its edge
(`stopLineSOnRoad` = `centreS +/- intersectionRadius`), and the
intersection-occupancy rule works on the same interval. A box that is
narrower than the road it delimits leaves the outer lanes outside the
box, so the rule never sees them.

Its radius is therefore derived from the lane model — the widest
connected road's half-width, plus the clearance a queued vehicle's nose
needs (`junction_radius`). It used to be a hard-coded 8 m, which was
narrower than a 6-lane road's 10.5 m half-width.

A wider box reaches further along the road, so a short road can end up
covered by the boxes of the junctions at both ends. Such a road gets no
spawn point at all — there is no legal place on it to start a car
(`_spawn_arc_length`).
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
#
# The cap goes through the same geometric clip as an explicit bbox, so it is
# a real area bound: a way that reaches out of the cap is cut at the cap's
# border rather than kept whole.
MAX_BBOX_DEG = 0.5

BBox = tuple[float, float, float, float]  # (south, west, north, east)

# A spawn point is only worth emitting on a road that can hold a car and
# has more than the single lane a one-way road ends up with.
SPAWN_MIN_ROAD_LENGTH_M = 20.0
SPAWN_MIN_LANES = 2

# Width of one lane (m). Mirrors the frontend's `ROAD_LANE_WIDTH`
# (`TraffSim3D-frontend/src/shared/constants/simulation.ts`), which is the
# width the frontend uses for **every** road — imported ones included
# (`laneGeometry.ts` -> `lanePoint` -> `laneOffset`). The two ends have to
# agree: the junction box is computed here, but the carriageway it has to
# contain is the one the frontend draws and the one the stop line and the
# intersection-occupancy rule work on.
ROAD_LANE_WIDTH = 3.5

# Extra radius (m) on top of the crossing road's half-width, so that a
# vehicle queued at the stop line does not stick its nose into the
# crossing carriageway. The stop rule acts on the vehicle's **centre**
# (`tick.ts` -> `distToStopLine`), so the nose may legitimately overhang
# by up to half the longest vehicle (the 9 m bus -> 4.5 m).
#
# Mirrors the frontend's `INTERSECTION_CLEARANCE_M`
# (`TraffSim3D-frontend/src/shared/constants/simulation.ts`).
INTERSECTION_CLEARANCE_M = 4.5

# How far (m) an intersection position may sit from a connected road's
# centreline and still be trusted as "this intersection is on that road".
#
# The number mirrors the frontend's `MAX_INTERSECTION_OFFSET_M`
# (`TraffSim3D-frontend/src/domain/services/laneGeometry.ts`) on purpose:
# both ends have to reject the same projections. If the backend trusted a
# projection the frontend rejects (or the other way round), the two sides
# would place the stop line and the spawn point at different spots on the
# very same road.
#
# A road that really carries the intersection touches it, so the
# perpendicular distance is ~0. Beyond the threshold the intersection
# belongs to some other road (or the projection failed), and the caller
# falls back to the road midpoint instead of inventing a position.
MAX_INTERSECTION_OFFSET_M = 30.0

# ===== signal phase durations (s) =====
#
# The browser's phase machine runs **one cycle per light**:
#
#   green -> yellow -> all-red -> red -> green
#
# with the durations below. The two axis groups of a junction start
# 36 s apart (30 green + 3 yellow + 3 all-red), so the "neither axis is
# green" gap is 6 s and the repeat period is 72 s - the same shape the
# Python training sim's timeline has (`app/apps/rl/sim_core.py`: a 30 s
# phase separated by `CLEARANCE_SECS = 6.0`).
#
# Mirrors the frontend's `GREEN_PHASE_SECS` / `YELLOW_CLEAR_SECS` /
# `ALL_RED_CLEARANCE_SECS` / `RED_PHASE_SECS` / `DEFAULT_CYCLE_SECONDS`
# (`TraffSim3D-frontend/src/shared/constants/simulation.ts`).
GREEN_PHASE_SECONDS = 30
YELLOW_CLEAR_SECONDS = 3
ALL_RED_CLEARANCE_SECONDS = 3
# The red holds the other axis' whole turn: its 30 s green plus the 6 s
# clearance. So one light's cycle is 72 s and the two axis groups of a
# junction - started half a cycle (36 s) apart - show the same timeline
# the Python training sim has (a 30 s phase separated by
# `CLEARANCE_SECS = 6.0`).
RED_PHASE_SECONDS = 36
# One light's full cycle: 30 + 3 + 3 + 36.
SIGNAL_CYCLE_SECONDS = (
    GREEN_PHASE_SECONDS + YELLOW_CLEAR_SECONDS + ALL_RED_CLEARANCE_SECONDS + RED_PHASE_SECONDS
)
# The second axis group starts this long after the first one.
SECOND_AXIS_DELAY_SECONDS = GREEN_PHASE_SECONDS + YELLOW_CLEAR_SECONDS + ALL_RED_CLEARANCE_SECONDS

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


# ---------------------------------------------------------------------------
# Geometric clipping: the region as a rectangle in projected world meters.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _Vertex:
    """One point of a way's polyline.

    `node_ref` is the OSM node the point came from, or None for a point
    the clip interpolated on the region border. `level_ref` is always an
    original node: the one whose height this point inherits.
    """

    x: float
    z: float
    node_ref: int | None
    level_ref: int


@dataclass
class _Candidate:
    """A way that survived the clip, with the runs of geometry it kept."""

    way: _RawWay
    direction: str
    runs: list[list[_Vertex]]


def _region_rect(
    region: BBox,
    origin_lat: float,
    origin_lon: float,
    cos_lat: float,
) -> tuple[float, float, float, float]:
    """The clip region as an axis-aligned rectangle in projected meters.

    `(xmin, zmin, xmax, zmax)`, using the very projection the nodes use
    (`x = (lon - originLon) * 111000 * cos(originLat)`,
    `z = (lat - originLat) * 111000`), so the rectangle in degrees maps
    onto exactly this rectangle in meters.
    """
    south, west, north, east = region
    return (
        (west - origin_lon) * 111000.0 * cos_lat,
        (south - origin_lat) * 111000.0,
        (east - origin_lon) * 111000.0 * cos_lat,
        (north - origin_lat) * 111000.0,
    )


def _clip_segment(
    p0: tuple[float, float],
    p1: tuple[float, float],
    rect: tuple[float, float, float, float],
) -> tuple[float, float] | None:
    """Liang-Barsky: the parameter interval of the part of p0->p1 in the rect.

    Returns `(t0, t1)`, the clipped part running from `p0 + t0*(p1-p0)`
    to `p0 + t1*(p1-p0)`, or None when the segment does not meet the
    rectangle. A segment that only *touches* the rectangle (`t0 == t1`)
    has no length in it and does not survive: a road may not be a point.
    """
    x0, z0 = p0
    x1, z1 = p1
    xmin, zmin, xmax, zmax = rect
    dx = x1 - x0
    dz = z1 - z0
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, x0 - xmin), (dx, xmax - x0), (-dz, z0 - zmin), (dz, zmax - z0)):
        if p == 0.0:
            if q < 0.0:
                return None  # parallel to this edge and outside it
            continue
        r = q / p
        if p < 0.0:
            if r > t1:
                return None
            t0 = max(t0, r)
        else:
            if r < t0:
                return None
            t1 = min(t1, r)
    if t1 <= t0:
        return None
    return t0, t1


def _interpolate(a: _Vertex, b: _Vertex, t: float) -> _Vertex:
    """The point at parameter `t` on the segment a->b.

    `t = 0` and `t = 1` return the endpoints **unchanged**, so a way that
    lies entirely inside the region keeps exactly the geometry it had
    unclipped. An interpolated point inherits the height of the nearest
    original node and carries no node id of its own — it is not an OSM
    node, so it must never become a junction.
    """
    if t <= 0.0:
        return a
    if t >= 1.0:
        return b
    return _Vertex(
        x=a.x + (b.x - a.x) * t,
        z=a.z + (b.z - a.z) * t,
        node_ref=None,
        level_ref=a.level_ref if t <= 0.5 else b.level_ref,
    )


def _clip_polyline(
    vertices: Sequence[_Vertex],
    rect: tuple[float, float, float, float],
) -> list[list[_Vertex]]:
    """The parts of a polyline that lie inside the rectangle.

    Every segment is clipped on its own, and the clipped pieces are
    chained back into maximal contiguous runs. Two pieces belong to the
    same run only when the polyline **stayed** inside the region between
    them: a way that enters the region, leaves it and comes back yields
    two runs — and therefore two roads.
    """
    runs: list[list[_Vertex]] = []
    current: list[_Vertex] = []
    continuous = False  # the polyline was still inside at the last vertex
    for index in range(len(vertices) - 1):
        a = vertices[index]
        b = vertices[index + 1]
        clipped = _clip_segment((a.x, a.z), (b.x, b.z), rect)
        if clipped is None:
            if len(current) >= 2:
                runs.append(current)
            current = []
            continuous = False
            continue
        t0, t1 = clipped
        if current and continuous and t0 == 0.0:
            # The two pieces share a vertex: the polyline never left.
            current.append(_interpolate(a, b, t1))
        else:
            if len(current) >= 2:
                runs.append(current)
            current = [_interpolate(a, b, t0), _interpolate(a, b, t1)]
        continuous = t1 == 1.0
    if len(current) >= 2:
        runs.append(current)
    return runs


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


def _polyline_cumulative_lengths(waypoints: Sequence[dict[str, Any]]) -> list[float]:
    """Per-segment cumulative arc length; the last entry is the total."""
    cumulative: list[float] = []
    acc = 0.0
    for a, b in zip(waypoints, waypoints[1:], strict=False):
        acc += math.dist(
            (float(a.get("x", 0.0)), float(a.get("y", 0.0)), float(a.get("z", 0.0))),
            (float(b.get("x", 0.0)), float(b.get("y", 0.0)), float(b.get("z", 0.0))),
        )
        cumulative.append(acc)
    return cumulative


def _polyline_length(waypoints: Sequence[dict[str, Any]]) -> float:
    cumulative = _polyline_cumulative_lengths(waypoints)
    return cumulative[-1] if cumulative else 0.0


def _project_onto_polyline(
    waypoints: Sequence[dict[str, Any]],
    x: float,
    z: float,
) -> tuple[float, float]:
    """Project a world position onto a polyline.

    Returns `(s, distance)`: the arc length of the closest point on the
    polyline (measured from the first waypoint) and the perpendicular
    distance (m) from the world position to that point.

    This is the backend twin of the frontend's `worldToCenterlineS`
    (`TraffSim3D-frontend/src/domain/services/laneGeometry.ts`): every
    segment is projected onto separately and the segment with the smallest
    perpendicular distance wins. The two implementations must agree — the
    frontend places the stop line from the projection and the backend
    places the spawn point from it, and a drifting pair would put a car
    into a junction the other end believes is elsewhere.

    Frame note: the backend's Z is north-positive (`z = (lat - origin_lat)
    * 111000`), the frontend's Z is north-negative. The projection is
    invariant under `z -> -z`:
      * the perpendicular distance uses `(z - pz) ** 2` — a square, so the
        sign cancels;
      * the segment parameter `((z - az) * dz) / |d|^2` is a product of
        two factors that flip sign together — the product is unchanged;
      * the arc length is a distance.
    So the `s` and the `distance` returned here are numerically identical
    in either frame and no sign fix-up is needed. (A *signed* along-road
    offset would need one; nothing here is signed.)
    """
    cumulative = _polyline_cumulative_lengths(waypoints)
    if not cumulative or len(waypoints) < 2:
        return 0.0, math.inf

    best_s = 0.0
    best_perp_sq = math.inf
    for index in range(len(waypoints) - 1):
        a = waypoints[index]
        b = waypoints[index + 1]
        ax = float(a.get("x", 0.0))
        az = float(a.get("z", 0.0))
        dx = float(b.get("x", 0.0)) - ax
        dz = float(b.get("z", 0.0)) - az
        flat_len = math.hypot(dx, dz)
        if flat_len < 1e-6:
            # Degenerate segment (duplicate waypoint) — no tangent to
            # project onto. Skipped, exactly like the frontend does.
            continue
        seg_start = cumulative[index - 1] if index > 0 else 0.0
        seg_len_3d = cumulative[index] - seg_start
        # Parameter of the closest point on the segment, clamped to [0, 1].
        t = ((x - ax) * dx + (z - az) * dz) / (flat_len * flat_len)
        t = max(0.0, min(1.0, t))
        px = ax + dx * t
        pz = az + dz * t
        perp_sq = (x - px) ** 2 + (z - pz) ** 2
        if perp_sq < best_perp_sq:
            best_perp_sq = perp_sq
            best_s = seg_start + t * seg_len_3d

    total = cumulative[-1]
    return max(0.0, min(total, best_s)), math.sqrt(best_perp_sq)


def _project_intersection_on_road(
    road: dict[str, Any],
    intersection: dict[str, Any],
) -> tuple[float, bool]:
    """Where an intersection sits on a road — `(s, projected)`.

    The intersection's world position is projected onto the road's
    centreline; the resulting arc length is the single source of truth for
    where the junction is on that road.

    When the projection cannot be trusted — the intersection is further
    than `MAX_INTERSECTION_OFFSET_M` from the road, or the road is
    degenerate — the **road midpoint** is returned with `projected = False`.
    That is the same degradation the frontend applies
    (`projectIntersectionOnRoad`), so both ends fall back to the same
    place and a bad projection can never move a spawn point to a nonsense
    location.
    """
    waypoints = road.get("waypoints") or []
    length = _polyline_length(waypoints)
    if length < 1e-6:
        return 0.0, False
    position = intersection.get("position") or {}
    x = float(position.get("x", 0.0))
    z = float(position.get("z", 0.0))
    s, distance = _project_onto_polyline(waypoints, x, z)
    if not math.isfinite(distance) or distance > MAX_INTERSECTION_OFFSET_M:
        return length / 2.0, False
    return s, True


def _polyline_tangent(
    waypoints: Sequence[dict[str, Any]],
    s: float,
) -> tuple[float, float] | None:
    """The unit tangent (in XZ) at arc length `s` along the polyline.

    The backend twin of the frontend's `roadForward`
    (`TraffSim3D-frontend/src/domain/services/laneGeometry.ts`): the
    segment that contains `s` is found by the same cumulative-length rule,
    and the tangent is that segment's direction.

    `None` when the polyline is degenerate — a zero-length segment at `s`,
    or no segment at all. The caller then falls back to the road's extent.
    """
    cumulative = _polyline_cumulative_lengths(waypoints)
    if not cumulative or len(waypoints) < 2:
        return None
    total = cumulative[-1]
    s_clamped = max(0.0, min(total, s))
    index = len(cumulative) - 1
    for i, cum in enumerate(cumulative):
        if s_clamped <= cum:
            index = i
            break
    seg_start = cumulative[index - 1] if index > 0 else 0.0
    seg_len_3d = cumulative[index] - seg_start
    if seg_len_3d < 1e-6:
        return None
    a = waypoints[index]
    b = waypoints[index + 1]
    dx = float(b.get("x", 0.0)) - float(a.get("x", 0.0))
    dz = float(b.get("z", 0.0)) - float(a.get("z", 0.0))
    return dx / seg_len_3d, dz / seg_len_3d


def _road_polyline_axis(road: dict[str, Any]) -> str:
    """The axis of a road's **whole extent** — `ns` or `ew`.

    The backend twin of the frontend's `roadPolylineAxis`
    (`TraffSim3D-frontend/src/domain/services/approachAxis.ts`): the
    distance the road travels along X is compared with the distance it
    travels along Z (the per-segment |dx| / |dz| are summed, so a curved
    road is judged by its real extent and not by its end-to-end chord).
    """
    waypoints = road.get("waypoints") or []
    if len(waypoints) >= 2:
        points = list(waypoints)
    else:
        points = [road.get("startNode") or {}, road.get("endNode") or {}]
    dx = 0.0
    dz = 0.0
    for a, b in zip(points, points[1:], strict=False):
        dx += abs(float(b.get("x", 0.0)) - float(a.get("x", 0.0)))
        dz += abs(float(b.get("z", 0.0)) - float(a.get("z", 0.0)))
    return "ns" if dz > dx else "ew"


def _approach_axis(road: dict[str, Any], intersection: dict[str, Any]) -> str:
    """The axis of the road's **travel direction at the junction**.

    The backend twin of the frontend's `approachAxis`
    (`TraffSim3D-frontend/src/domain/services/approachAxis.ts`).

    The tangent is taken where the junction projects onto the road's
    polyline; the axis is `ns` when that tangent runs more along Z than
    along X. That is the direction the traffic travels **at the junction**,
    which is what a traffic light governs.

    When the projection is rejected — the junction is further than
    `MAX_INTERSECTION_OFFSET_M` from the road, so it is not really on it
    — the road's **whole extent** decides the axis, exactly like the
    frontend does.
    """
    s, projected = _project_intersection_on_road(road, intersection)
    if not projected:
        return _road_polyline_axis(road)
    tangent = _polyline_tangent(road.get("waypoints") or [], s)
    if tangent is None:
        return _road_polyline_axis(road)
    ux, uz = tangent
    if abs(ux) < 1e-9 and abs(uz) < 1e-9:
        return _road_polyline_axis(road)
    return "ns" if abs(uz) > abs(ux) else "ew"


def _build_traffic_lights(
    *,
    light_index: int,
    position: dict[str, float],
    roads: Sequence[dict[str, Any]],
    connected_road_indices: Sequence[int],
) -> list[dict[str, Any]]:
    """The lights of a signalised junction — **one per axis group**.

    A junction's approaches are grouped by the axis they approach on
    (`_approach_axis`): the north and south arms of a crossroads are one
    group, the east and west arms the other. Each group gets its **own**
    light, and the two groups are driven in opposition.

    The junction used to carry **at most one** light, whose axis was a
    guess about the junction's **first** road (the end-to-end delta of
    that road). On the Shenzhen extract that produced 51 lights — every
    one of them `ew` — and left the perpendicular approach governed by
    nothing at all: the signals were decorative.

    The ids keep the old shape (`tl-<n>-<axis>`), so an id that already
    existed keeps existing; the second axis group of a junction gets the
    id of its own axis.
    """
    intersection = {"position": position}
    axes: list[str] = []
    for index in connected_road_indices:
        axis = _approach_axis(roads[index], intersection)
        if axis not in axes:
            axes.append(axis)
    lights: list[dict[str, Any]] = []
    for axis in axes:
        lights.append(
            {
                "id": f"tl-{light_index}-{axis}",
                "position": {
                    "x": position["x"] - 3 if axis == "ew" else position["x"],
                    "y": position["y"],
                    "z": position["z"] if axis == "ew" else position["z"] - 3,
                },
                "phase": "green" if axis == "ns" else "red",
                # The first axis group is served for 30 s; the second one
                # starts 36 s later (30 green + 3 yellow + 3 all-red), so
                # the junction's clearance is 6 s - symmetric, and the
                # repeat period is 72 s.
                "phaseRemaining": (
                    GREEN_PHASE_SECONDS if axis == "ns" else SECOND_AXIS_DELAY_SECONDS
                ),
                "cycleSeconds": SIGNAL_CYCLE_SECONDS,
                "axis": axis,
            }
        )
    return lights


def junction_radius(lane_counts: Sequence[int]) -> float:
    """The radius of a junction box, derived from the lane model.

    The box has to do two jobs at once, and the second one is the reason it
    cannot be a fixed number:

    1. **Contain the crossing carriageway.** The stop line sits on the box
       edge (`stopLineSOnRoad` = `centreS +/- intersectionRadius`), so a
       box narrower than the road it delimits leaves the outer lanes
       outside the box — and the intersection-occupancy rule never sees
       them. The carriageway's half-width is `laneCount * ROAD_LANE_WIDTH
       / 2`, and the box is shared by every approach, so the **widest**
       connected road decides.
    2. **Keep a queued nose out of the crossing carriageway.** The stop
       rule acts on the vehicle's centre, so a car waiting at the stop
       line may overhang by up to half its length (4.5 m for the 9 m
       bus). The box needs that much clearance on top of the half-width.

    So: `radius = widest half-width + clearance`.

    The clearance is **unconditional**. It used to be conditional on the
    junction being signalised, but that condition was wrong: the frontend
    paints a stop line on **every** junction's box edge (`roadStopLines`
    does not look at the traffic lights) and the cross-road yield rule
    (`tick.ts` -> `applyCrossRoadYield`) can stop a vehicle in front of
    any of them, lit or not — so every junction can hold a queue. The
    parser's own traffic lights are no proxy for that either: it only
    attaches lights to the OSM nodes tagged `highway=traffic_signals` (51
    of the 7991 junctions in the Shenzhen extract, 82 lights). The flag is
    gone, so the two sides of the contract have literally the same
    formula.

    This mirrors the frontend's `junctionRadius`
    (`TraffSim3D-frontend/src/domain/services/junctionRadius.ts`),
    which is applied to the built-in scenes; the imported maps get it
    here, because the parser is the only place that knows the lane
    counts of an OSM network.
    """
    widest = max((int(count) for count in lane_counts), default=1)
    half_width = widest * ROAD_LANE_WIDTH / 2.0
    return half_width + INTERSECTION_CLEARANCE_M


def _spawn_arc_length(
    road: dict[str, Any],
    intersections: Sequence[dict[str, Any]],
) -> float | None:
    """The arc length of this road's spawn point, or `None` if there is
    no legal place to put one.

    One spawn point per road, placed at the point that is **furthest from
    every intersection on that road** — measured to the *edge* of the
    intersection box, not to its centre.

    Rationale: an OSM way very often *starts* at an intersection — that
    is how the intersection is detected in the first place (a node shared
    by two or more ways). Spawning at `s = 0` therefore dropped the car
    straight into the junction, which is where it was spawned before this
    rule existed.

    The candidates are the road's two ends and the midpoints between
    consecutive intersections, because on a line the point furthest from a
    set of points is always one of those. Each candidate is scored by
    its distance to the **nearest intersection box edge**, so a point
    just outside a junction beats one further away from a junction that
    is not on this road at all.

    Two constraints shape the result:

    - The road's **end** (`s = length`) is not a candidate for a forward
      lane: the simulation treats the road as a loop, so a car that
      starts at the travel end is teleported back to `s ≈ 0` on its first
      tick — which is where the junction usually is. The end is therefore
      only used when it is the *start* of the lane (`s = 0`).
    - A road without any intersection keeps `s = 0` (unchanged
      behaviour).

    A junction box now reaches much further along the road than the old
    hard-coded 8 m did (it is sized by the lane model, see
    `junction_radius`), so a short road can be **entirely** covered by
    the boxes of the junctions at its ends. There is then no point left
    that is outside every box, and the answer is `None`: the road gets
    **no spawn point at all**. That is a defined rule, not an accident —
    the alternative (parking the car on the box edge) would put it inside
    an intersection, which is the very thing the spawn placement exists
    to prevent.
    """
    waypoints = road.get("waypoints") or []
    length = _polyline_length(waypoints)
    if length < 1e-6:
        return 0.0
    road_id = str(road.get("id", ""))
    # (arc length of the junction centre, radius of its box)
    junctions: list[tuple[float, float]] = []
    for intersection in intersections:
        connected = intersection.get("connectedRoads") or []
        if road_id not in connected:
            continue
        s, _projected = _project_intersection_on_road(road, intersection)
        radius = float(intersection.get("intersectionRadius", 0) or 0)
        junctions.append((s, radius))
    if not junctions:
        return 0.0
    junctions.sort()

    # The junction **boxes** cut the road into stretches of open ground.
    # The spawn point goes in the middle of the widest of them.
    #
    # Working with the boxes rather than the centres matters: a wide
    # intersection reaches far along the road, and a point that is clear
    # of the *centre* can still be inside the box the traffic light
    # governs.
    spans = sorted((max(0.0, s - radius), min(length, s + radius)) for s, radius in junctions)
    free: list[tuple[float, float]] = []
    cursor = 0.0
    for lo, hi in spans:
        if lo > cursor:
            free.append((cursor, lo))
        cursor = max(cursor, hi)
    if cursor < length:
        free.append((cursor, length))

    # The spawn point goes in the middle of an open stretch. The stretch
    # at the very end of the road is usable like any other: its midpoint
    # is always strictly inside the road, so the travel end is never
    # chosen. (The simulation treats a road as a loop, so a car that
    # started exactly at the travel end would be teleported back to the
    # start of the road on its first tick — which is where a junction
    # usually is.)
    candidates: list[float] = []
    for lo, hi in free:
        if hi - lo <= 1e-6:
            continue
        candidates.append((lo + hi) / 2.0)
    if not candidates:
        # Every part of the road is inside a junction box: there is no
        # open stretch left, so there is no legal place to start a car.
        # The road gets no spawn point (see `_build_spawn_points`).
        return None
    # Prefer the point with the most room around it.
    return max(
        candidates,
        key=lambda c: min(abs(c - s) - radius for s, radius in junctions),
    )


def _empty_network(origin_lat: float, origin_lon: float) -> dict[str, Any]:
    return {
        "roads": [],
        "intersections": [],
        "vehicles": [],
        "spawnPoints": [],
        "originLat": origin_lat,
        "originLon": origin_lon,
    }


def _build_spawn_points(
    roads: Sequence[dict[str, Any]],
    intersections: Sequence[dict[str, Any]],
) -> list[dict[str, Any]]:
    """One spawn point per road that can actually hold a car.

    The shape is part of the cross-end contract:
    `{id, roadId, laneIndex, s, occupiedBy}`, where `laneIndex` counts
    lanes in the direction of travel and `s` is the distance along the road
    from its start.

    `s` is not always 0: it is the end of the road that is furthest from
    every junction on it (see `_spawn_arc_length`), so an imported map
    does not spawn its cars inside an intersection.

    A road whose whole length is covered by junction boxes gets **no**
    spawn point: there is no point on it that is outside every box, and
    a car may not start inside an intersection.
    """
    spawn_points: list[dict[str, Any]] = []
    for road in roads:
        if int(road.get("laneCount", 0)) < SPAWN_MIN_LANES:
            continue
        if _polyline_length(road["waypoints"]) < SPAWN_MIN_ROAD_LENGTH_M:
            continue
        s = _spawn_arc_length(road, intersections)
        if s is None:
            # No open stretch: the road is covered by junction boxes from
            # end to end. Skipped on purpose — see `_spawn_arc_length`.
            continue
        road_id = str(road["id"])
        spawn_points.append(
            {
                "id": f"sp-{road_id}-0",
                "roadId": road_id,
                "laneIndex": 0,
                "s": s,
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

    # ---- 2) The region: in degrees, and as a rectangle in world meters ----
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
    rect = _region_rect(region, origin_lat, origin_lon, cos_lat)
    if rect[2] <= rect[0] or rect[3] <= rect[1]:
        # The region has no area. A zero-extent box is a line, not a place,
        # so nothing survives it — that is the honest answer, not a way
        # kept whole.
        return _empty_network(origin_lat, origin_lon)

    # ---- 3) Ways -> the runs of geometry that lie inside the region ----
    candidates: list[_Candidate] = []
    for way in raw_ways:
        if way.tags.get("highway") not in DEFAULT_HIGHWAY_TYPES:
            continue
        refs = [ref for ref in way.node_refs if ref in nodes]
        if len(refs) < 2:
            continue
        # The travel direction is decided *before* the clip, so the pieces
        # come out in the order cars actually travel them.
        direction = _oneway_direction(way.tags)
        if direction == "reverse":
            # Traffic runs against the digitisation direction: flip the way
            # so that "forward" means the direction cars actually travel.
            refs.reverse()
        vertices = [_Vertex(nodes[ref].x, nodes[ref].z, ref, ref) for ref in refs]
        runs = _clip_polyline(vertices, rect)
        if not runs:
            continue
        candidates.append(_Candidate(way=way, direction=direction, runs=runs))

    # ---- 4) One height per node, so shared nodes really are shared ----
    node_levels: dict[int, Counter] = {}
    for candidate in candidates:
        level = _way_level(candidate.way.tags)
        for run in candidate.runs:
            for vertex in run:
                if vertex.node_ref is None:
                    # A cut point on the border is not an OSM node; it
                    # inherits the height of its nearest original node.
                    continue
                counter = node_levels.setdefault(vertex.node_ref, Counter())
                counter[level] += 1
    node_level = {ref: _pick_level(counter) for ref, counter in node_levels.items()}

    # ---- 5) Ways -> roads (one road per surviving run) ----
    roads: list[dict[str, Any]] = []
    road_runs: list[list[_Vertex]] = []
    road_candidates: list[int] = []
    for candidate_index, candidate in enumerate(candidates):
        way = candidate.way
        level = _way_level(way.tags)
        oneway = candidate.direction != "both"
        try:
            lanes = max(1, int(way.tags.get("lanes", "2")))
        except ValueError:
            lanes = 2
        if oneway:
            lanes = max(1, lanes // 2)
        base_id = f"{road_id_prefix}{way.way_id}"
        for run_index, run in enumerate(candidate.runs):
            # A way that survives as one run keeps its plain id; a way that
            # was cut into several runs numbers them in travel order.
            road_id = base_id if run_index == 0 else f"{base_id}-{run_index + 1}"
            waypoints = [
                {
                    "x": vertex.x,
                    "y": node_level.get(vertex.level_ref, level) * LEVEL_HEIGHT,
                    "z": vertex.z,
                }
                for vertex in run
            ]
            roads.append(
                {
                    "id": road_id,
                    "startNode": waypoints[0],
                    "endNode": waypoints[-1],
                    "waypoints": waypoints,
                    "laneCount": lanes,
                    "oneway": oneway,
                    "speedLimit": HIGHWAY_SPEED_LIMIT[way.tags["highway"]],
                    "level": level,
                }
            )
            road_runs.append(run)
            road_candidates.append(candidate_index)

    # ---- 6) Traffic signals marked on a way rather than on a node ----
    # Legacy behaviour of the PBF path, now applied to both formats.
    signal_node_ids = set(traffic_signal_node_ids)
    for way in raw_ways:
        if way.tags.get("highway") == "traffic_signals" and way.node_refs:
            signal_node_ids.add(way.node_refs[0])

    # ---- 7) Intersections: OSM nodes shared by two or more ways ----
    node_to_ways: dict[int, list[int]] = {}
    node_to_roads: dict[int, list[int]] = {}
    for road_index, run in enumerate(road_runs):
        candidate_index = road_candidates[road_index]
        for vertex in run:
            ref = vertex.node_ref
            if ref is None:
                # A cut point on the region border is shared by nobody: it
                # is not an OSM node, so the border never becomes a junction.
                continue
            ways_bucket = node_to_ways.setdefault(ref, [])
            if candidate_index not in ways_bucket:
                ways_bucket.append(candidate_index)
            roads_bucket = node_to_roads.setdefault(ref, [])
            if road_index not in roads_bucket:
                roads_bucket.append(road_index)

    intersections: list[dict[str, Any]] = []
    inter_counter = 0
    for ref, way_indices in node_to_ways.items():
        if len(way_indices) < 2:
            continue
        node = nodes[ref]
        height = node_level.get(ref, 0) * LEVEL_HEIGHT
        inter_id = f"{intersection_id_prefix}{inter_counter}"
        inter_counter += 1
        connected_road_indices = node_to_roads[ref]
        traffic_lights: list[dict[str, Any]] = []
        if ref in signal_node_ids:
            # One light per **axis group** of the junction's approaches —
            # the axis comes from the road's local tangent where it meets
            # this junction, not from a guess about one road.
            traffic_lights = _build_traffic_lights(
                light_index=inter_counter,
                position={"x": node.x, "y": height, "z": node.z},
                roads=roads,
                connected_road_indices=connected_road_indices,
            )
        intersections.append(
            {
                "id": inter_id,
                "position": {"x": node.x, "y": height, "z": node.z},
                "trafficLights": traffic_lights,
                "connectedRoads": [roads[i]["id"] for i in connected_road_indices],
                # Sized by the lane model, not by a fixed number: the box
                # has to hold the carriageway of the roads it crosses, and
                # leave room for a queued vehicle's nose. The old
                # hard-coded 8 m was narrower than a 6-lane road's
                # half-width (10.5 m), so the outer lanes were never
                # inside the box.
                #
                # The clearance is unconditional: the frontend puts a stop
                # line on the box edge of *every* junction, and the
                # cross-road yield rule can stop a vehicle in front of
                # any of them, so a queue can form there. The parser's
                # own traffic lights are no proxy for that — it only
                # attaches lights to the OSM nodes tagged
                # `highway=traffic_signals` (51 of the 7991 junctions in
                # the Shenzhen extract, 82 lights — one per axis group).
                "intersectionRadius": junction_radius(
                    [int(roads[i].get("laneCount", 1)) for i in connected_road_indices],
                ),
            }
        )

    return {
        "roads": roads,
        "intersections": intersections,
        "vehicles": [],
        "spawnPoints": _build_spawn_points(roads, intersections),
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
    interest. The geometry is cut at the border: a way that crosses the
    region ends where it leaves it. Omitting `bbox` keeps the historical
    ~55 km safety cap, which is clipped the same way.
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
