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


def junction_radius(lane_counts: Sequence[int], signalised: bool) -> float:
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

    So: `radius = widest half-width + clearance`, and the clearance is
    only needed where a queue can actually form — a junction without a
    traffic light has no stop line to queue at.

    The imported maps treat **every** junction as signalised (see the
    call site in `_build_network`), because the parser's own traffic
    lights are far too sparse to be a proxy for "can a queue form here".

    This mirrors the frontend's `junctionRadius`
    (`TraffSim3D-frontend/src/application/services/defaultScene.ts`),
    which is applied to the built-in scenes; the imported maps get it
    here, because the parser is the only place that knows the lane
    counts of an OSM network.
    """
    widest = max((int(count) for count in lane_counts), default=1)
    half_width = widest * ROAD_LANE_WIDTH / 2.0
    return half_width + (INTERSECTION_CLEARANCE_M if signalised else 0.0)


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
                # Sized by the lane model, not by a fixed number: the box
                # has to hold the carriageway of the roads it crosses, and
                # leave room for a queued vehicle's nose. The old
                # hard-coded 8 m was narrower than a 6-lane road's
                # half-width (10.5 m), so the outer lanes were never
                # inside the box.
                #
                # Every imported junction counts as signalised: the
                # frontend puts a stop line on the box edge of *every*
                # junction, and the cross-road yield rule can stop a
                # vehicle in front of any of them, so a queue can form
                # there. The parser's own traffic lights are no proxy for
                # that — it only attaches one to the OSM nodes tagged
                # `highway=traffic_signals` (51 of the 7991 junctions in
                # the Shenzhen extract).
                "intersectionRadius": junction_radius(
                    [int(roads[i].get("laneCount", 1)) for i in way_indices],
                    signalised=True,
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
