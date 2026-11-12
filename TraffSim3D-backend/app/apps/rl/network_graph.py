"""Road network graph — bridges frontend SerializedScene to RL sim.

Builds a directed graph from the frontend's road/intersection JSON.
Used by NetworkSimCore to run simulation on arbitrary user-edited
scenes (not just hardcoded cross/corridor).

Directionality
--------------
The graph is **directed**: a vehicle that finishes road `a` may only
continue onto roads that can legally be entered from the node `a` ends at.

* A road whose `oneway` flag is true may only be entered at the node it
  *starts* from — it cannot be driven backwards.
* A road without the flag is bidirectional and may be entered at either end.

The `oneway` flag is not invented here: the OSM parser already emits it per
road (`app/apps/maps/osm_parser.py`), so an imported map carries real
one-way restrictions. Scenes that predate the flag are treated as
bidirectional.
"""

from __future__ import annotations

import heapq
import math
from dataclasses import dataclass, field


@dataclass
class RoadSegment:
    id: str
    points: list[tuple[float, float]]  # [(x, z), ...] polyline
    lane_count: int
    speed_limit: float
    oneway: bool = False
    length: float = 0.0

    def __post_init__(self) -> None:
        if len(self.points) < 2:
            raise ValueError(f"RoadSegment {self.id} needs >= 2 points, got {len(self.points)}")
        self.length = sum(
            math.hypot(
                self.points[i + 1][0] - self.points[i][0], self.points[i + 1][1] - self.points[i][1]
            )
            for i in range(len(self.points) - 1)
        )


@dataclass
class IntersectionNode:
    id: str
    position: tuple[float, float]  # (x, z)
    incoming_road_ids: list[str] = field(default_factory=list)
    outgoing_road_ids: list[str] = field(default_factory=list)
    has_traffic_light: bool = False
    radius: float = 8.0
    # True for the placeholder nodes the builder creates for a road end that
    # is not at any intersection. They are not real junctions and must not
    # be counted as such.
    is_synthetic: bool = False


@dataclass
class NetworkGraph:
    segments: dict[str, RoadSegment] = field(default_factory=dict)
    nodes: dict[str, IntersectionNode] = field(default_factory=dict)
    # segment_id -> (start_node_id, end_node_id)
    segment_endpoints: dict[str, tuple[str, str]] = field(default_factory=dict)

    def adjacent_segments(self, seg_id: str) -> list[str]:
        """Segments reachable from the end of `seg_id` via an intersection."""
        if seg_id not in self.segment_endpoints:
            return []
        _, end_node = self.segment_endpoints[seg_id]
        if end_node not in self.nodes:
            return []
        return [
            cand
            for cand in self.nodes[end_node].outgoing_road_ids
            if cand != seg_id and self.can_enter(cand, end_node)
        ]

    def can_enter(self, seg_id: str, node_id: str) -> bool:
        """May a vehicle enter `seg_id` at `node_id`?

        A one-way road may only be entered at the node it starts from — it
        cannot be driven backwards. A bidirectional road may be entered at
        either end.
        """
        seg = self.segments.get(seg_id)
        if seg is None or not seg.oneway:
            return True
        start_node = self.segment_endpoints.get(seg_id, ("", ""))[0]
        node = self.nodes.get(start_node)
        if node is None or node.is_synthetic:
            # The road is not anchored to a real intersection, so there is no
            # direction to enforce.
            return True
        return start_node == node_id

    @property
    def real_intersections(self) -> list[IntersectionNode]:
        """The intersections the network actually declares (no placeholders)."""
        return [node for node in self.nodes.values() if not node.is_synthetic]


@dataclass
class RouteMetrics:
    """A route's segment lengths, and the prefix sums over them.

    `index` holds the route position of every segment that EXISTS in
    the graph (a route may name a segment the graph does not carry), and
    `prefix[i]` is the summed length of the first `i` of those, so
    `prefix[-1]` is the route's total length and `total - prefix[i]` is
    what is left ahead of the `i`-th one.
    """

    # The graph the metrics were measured against: the same route object
    # must not answer with another graph's numbers.
    graph: NetworkGraph
    index: list[int]
    prefix: list[float]

    @property
    def total(self) -> float:
        return self.prefix[-1] if self.prefix else 0.0


@dataclass
class Route:
    segment_ids: list[str]
    # False when no path exists. The segment list then falls back to the
    # start segment alone, which keeps a vehicle moving instead of freezing
    # it — `found` is what tells the two apart.
    found: bool = True
    # The route's geometry, computed once and cached here — see
    # `route_metrics`. A route does not change while a vehicle drives
    # it, so the sums the simulation asks for on every step of every
    # vehicle are the same sums.
    metrics: RouteMetrics | None = None


def route_metrics(graph: NetworkGraph, route: Route) -> RouteMetrics:
    """The route's lengths and prefix sums — computed once, then cached.

    The simulation asks for the route's total length, the distance
    covered so far and the distance still ahead on EVERY step of EVERY
    vehicle, and all three used to be summed from scratch each time:
    O(segments) per step, per vehicle, for the whole episode.

    The route is fixed while the vehicle drives it and the graph's
    segment lengths do not change, so the sums are measured once and
    kept on the route.
    """
    cached = route.metrics
    if cached is not None and cached.graph is graph:
        return cached
    index: list[int] = []
    prefix: list[float] = [0.0]
    for i, sid in enumerate(route.segment_ids):
        seg = graph.segments.get(sid)
        if seg is None:
            continue
        index.append(i)
        prefix.append(prefix[-1] + seg.length)
    metrics = RouteMetrics(graph=graph, index=index, prefix=prefix)
    route.metrics = metrics
    return metrics


def build_network_graph(network: dict) -> NetworkGraph:
    """Build a NetworkGraph from SerializedScene.network JSON.

    Input shape (matches frontend serializeNetwork output):
    {
      roads: [{ id, startNode: {x,y,z}, endNode: {x,y,z}, waypoints?, laneCount, speedLimit }],
      intersections: [{ id, position: {x,y,z}, connectedRoads: [...], trafficLights: [...], intersectionRadius }],
      vehicles: [...],
      spawnPoints: [...]
    }
    """
    graph = NetworkGraph()

    for r in network.get("roads", []):
        pts = _extract_polyline(r)
        seg = RoadSegment(
            id=r["id"],
            points=pts,
            lane_count=r.get("laneCount", 2),
            speed_limit=r.get("speedLimit", 16.67),
            oneway=bool(r.get("oneway", False)),
        )
        graph.segments[seg.id] = seg

    node_at_point: dict[tuple[float, float], str] = {}
    inter_id_by_road: dict[str, str] = {}

    for inter in network.get("intersections", []):
        pos = (inter["position"]["x"], inter["position"]["z"])
        node = IntersectionNode(
            id=inter["id"],
            position=pos,
            has_traffic_light=len(inter.get("trafficLights", [])) > 0,
            radius=inter.get("intersectionRadius", 8.0),
        )
        graph.nodes[node.id] = node
        node_at_point[_snap(pos)] = node.id
        for road_id in inter.get("connectedRoads", []):
            inter_id_by_road[road_id] = node.id

    for road_id, node_id in inter_id_by_road.items():
        if road_id not in graph.segments:
            continue
        if node_id not in graph.nodes:
            continue
        graph.nodes[node_id].incoming_road_ids.append(road_id)
        graph.nodes[node_id].outgoing_road_ids.append(road_id)

    # The index the nearest-node lookup uses — built once, and it takes
    # the synthetic nodes the loop below creates (see `_NodeGrid`).
    node_grid = _NodeGrid(graph.nodes)

    for seg_id, seg in graph.segments.items():
        start_pt = _snap(seg.points[0])
        end_pt = _snap(seg.points[-1])

        start_node = node_at_point.get(start_pt, "")
        end_node = node_at_point.get(end_pt, "")

        if not start_node:
            start_node = _find_nearest_node(node_grid, seg.points[0], exclude=end_node)
        if not end_node:
            end_node = _find_nearest_node(node_grid, seg.points[-1], exclude=start_node)

        if not start_node:
            start_node = f"_node_start_{seg_id}"
            graph.nodes[start_node] = IntersectionNode(
                id=start_node,
                position=seg.points[0],
                outgoing_road_ids=[seg_id],
                is_synthetic=True,
            )
            node_grid.add(start_node, seg.points[0])
            node_at_point[_snap(seg.points[0])] = start_node
        if not end_node:
            end_node = f"_node_end_{seg_id}"
            graph.nodes[end_node] = IntersectionNode(
                id=end_node,
                position=seg.points[-1],
                incoming_road_ids=[seg_id],
                is_synthetic=True,
            )
            node_grid.add(end_node, seg.points[-1])
            node_at_point[_snap(seg.points[-1])] = end_node

        graph.segment_endpoints[seg_id] = (start_node, end_node)

        if start_node in graph.nodes and seg_id not in graph.nodes[start_node].outgoing_road_ids:
            graph.nodes[start_node].outgoing_road_ids.append(seg_id)
        if end_node in graph.nodes and seg_id not in graph.nodes[end_node].incoming_road_ids:
            graph.nodes[end_node].incoming_road_ids.append(seg_id)

    return graph


def find_route(graph: NetworkGraph, start_seg: str, end_seg: str) -> Route:
    """Cheapest route from `start_seg` to `end_seg`, by segment length.

    A* over the segment graph with an admissible **zero** heuristic — i.e.
    Dijkstra. The graph's adjacency is not guaranteed to be geometrically
    continuous (a road may be entered at an intersection it merely passes
    through), so a Euclidean heuristic could overestimate the remaining cost
    and break optimality. Zero is always admissible, so the returned route is
    a minimum-cost path.

    The cost of a route is the summed length of the segments it contains,
    start segment included — see `route_cost`.
    """
    if start_seg == end_seg:
        return Route(segment_ids=[start_seg], found=True)
    if start_seg not in graph.segments or end_seg not in graph.segments:
        return Route(segment_ids=[start_seg], found=False)

    # dist[s] = cheapest known cost of a route that ends with segment `s`.
    dist: dict[str, float] = {start_seg: graph.segments[start_seg].length}
    prev: dict[str, str] = {}
    heap: list[tuple[float, str]] = [(dist[start_seg], start_seg)]
    settled: set[str] = set()

    while heap:
        cost, current = heapq.heappop(heap)
        if current in settled:
            continue
        settled.add(current)
        if current == end_seg:
            break
        for nxt in graph.adjacent_segments(current):
            if nxt in settled or nxt not in graph.segments:
                continue
            new_cost = cost + graph.segments[nxt].length
            if new_cost < dist.get(nxt, math.inf):
                dist[nxt] = new_cost
                prev[nxt] = current
                heapq.heappush(heap, (new_cost, nxt))

    if end_seg not in dist:
        # No path. Fall back to the start segment so the vehicle keeps
        # driving; `found` is False so callers can tell.
        return Route(segment_ids=[start_seg], found=False)

    path = [end_seg]
    while path[-1] != start_seg:
        path.append(prev[path[-1]])
    path.reverse()
    return Route(segment_ids=path, found=True)


def route_cost(graph: NetworkGraph, route: Route) -> float:
    """Total length of the segments a route runs through."""
    return sum(graph.segments[sid].length for sid in route.segment_ids if sid in graph.segments)


def point_on_road(seg: RoadSegment, t: float) -> tuple[float, float]:
    """Interpolate position along road polyline at parameter t in [0, length]."""
    t = max(0.0, min(seg.length, t))
    accumulated = 0.0
    for i in range(len(seg.points) - 1):
        dx = seg.points[i + 1][0] - seg.points[i][0]
        dz = seg.points[i + 1][1] - seg.points[i][1]
        seg_len = math.hypot(dx, dz)
        if accumulated + seg_len >= t or i == len(seg.points) - 2:
            if seg_len < 1e-9:
                return seg.points[i]
            local_t = (t - accumulated) / seg_len
            local_t = min(local_t, 1.0)
            return (
                seg.points[i][0] + dx * local_t,
                seg.points[i][1] + dz * local_t,
            )
        accumulated += seg_len
    return seg.points[-1]


def _extract_polyline(road: dict) -> list[tuple[float, float]]:
    """Extract (x, z) polyline from a Road JSON object."""
    wps = road.get("waypoints")
    if wps and len(wps) >= 2:
        return [(wp["x"], wp["z"]) for wp in wps]
    s = road["startNode"]
    e = road["endNode"]
    return [(s["x"], s["z"]), (e["x"], e["z"])]


def _snap(pt: tuple[float, float], precision: int = 0) -> tuple[float, float]:
    """Snap to integer grid to handle floating-point mismatches."""
    return (round(pt[0], precision), round(pt[1], precision))


def _find_nearest_node(
    index: _NodeGrid,
    pt: tuple[float, float],
    exclude: str = "",
) -> str:
    """Find the nearest intersection node within a reasonable distance."""
    return index.nearest(pt, exclude=exclude)


class _NodeGrid:
    """A grid index over the graph's nodes — the nearest-node lookup's index.

    The lookup is a nearest-node search with a 50 m cutoff, and it used
    to scan EVERY node in the graph: on the 1 115-road Shenzhen extract
    the 210 lookups meant 254 300 `math.hypot` calls, which was 77 % of
    the whole graph build (measured, 2026-11-12).

    A 50 m cell grid answers a lookup from the nine cells around the
    point, and those nine cells hold every node the 50 m cutoff can
    accept — a node within 50 m of the point is at most one cell away in
    each direction.

    The answer is the SAME node the linear scan found: the scan kept the
    first node that was strictly closer, so a tie went to the node that
    came first in the graph's insertion order. Here the candidates are
    compared by (distance, insertion order), which is that same rule.
    """

    CELL = 50.0
    MAX_DIST = 50.0

    def __init__(self, nodes: dict[str, IntersectionNode]) -> None:
        self._positions: dict[str, tuple[float, float]] = {}
        self._order: dict[str, int] = {}
        self._cells: dict[tuple[int, int], list[str]] = {}
        for order, (node_id, node) in enumerate(nodes.items()):
            position = node.position
            self._positions[node_id] = position
            self._order[node_id] = order
            key = self._cell_key(position)
            self._cells.setdefault(key, []).append(node_id)
        self._next_order = len(nodes)

    def add(self, node_id: str, position: tuple[float, float]) -> None:
        """A node that appeared AFTER the index was built.

        The builder creates a synthetic node for a road end that no
        intersection is near, and a later road's lookup used to be able
        to snap to it — the linear scan saw the growing dict. The index
        takes the same additions, in the same order.
        """
        self._positions[node_id] = position
        self._order[node_id] = self._next_order
        self._next_order += 1
        self._cells.setdefault(self._cell_key(position), []).append(node_id)

    @classmethod
    def _cell_key(cls, position: tuple[float, float]) -> tuple[int, int]:
        return (
            math.floor(position[0] / cls.CELL),
            math.floor(position[1] / cls.CELL),
        )

    def nearest(self, pt: tuple[float, float], exclude: str = "") -> str:
        """The nearest node within 50 m, or "" when there is none."""
        cx, cy = self._cell_key(pt)
        best_id = ""
        best_key: tuple[float, int] | None = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for node_id in self._cells.get((cx + dx, cy + dy), ()):
                    if node_id == exclude:
                        continue
                    position = self._positions[node_id]
                    d = math.hypot(position[0] - pt[0], position[1] - pt[1])
                    if d >= self.MAX_DIST:
                        continue
                    key = (d, self._order[node_id])
                    if best_key is None or key < best_key:
                        best_key = key
                        best_id = node_id
        return best_id
