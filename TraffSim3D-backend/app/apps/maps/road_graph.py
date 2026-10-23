"""Turn a parsed OSM RoadNetwork into a queryable graph.

The parser emits a flat `roads` list — convenient for rendering, useless for
anything that has to *decide*. The requirement is "路网转换为内部图结构
（节点+边）"; before this module the only Node+Edge graph in the repo
belonged to a synthetic corridor demo, so imported OSM maps had no
adjacency and no consumer could exist.

This module supplies the missing structure and, with it, a consumer: A* routing.

Node identity
-------------
Nodes are derived from **projected geometry** (`x`,`y`,`z` rounded to
`_COORD_PRECISION`), not from road indices, so that two roads meeting at an
intersection resolve to the same node and node ids are reproducible across
parses of identical input.

A road is a *chain*
------------------
The parser emits one road per OSM way, and the way's geometry is a polyline
with as many vertices as OSM gave it. The graph used to keep only the road's
two endpoints, which shattered an imported city map into thousands of
fragments: the parser finds intersections at *shared* nodes, and those shared
nodes are usually interior waypoints of a way, so the intersection existed in
the road list but not in the graph.

Every waypoint is therefore a graph node, and every consecutive pair of
waypoints is one edge. A road with N vertices contributes N-1 edges (plus a
reverse edge each, unless the road is one-way).

Directionality
--------------
OSM ways are directed by digitisation convention, but traffic on a two-way
road flows both ways, so each edge contributes a forward edge and — unless
the road is one-way — a reverse edge. The parser emits an explicit `oneway`
flag; when that flag is missing (older payloads), the legacy `laneCount == 1`
heuristic is used instead.

Cost
----
Polyline length in meters (sum of consecutive `waypoints`), not straight-line
endpoints, so curved ways are priced honestly. A `costOverride` may replace
that length (travel time, congestion, toll) without changing the shape; it is
split across the chain's edges in proportion to their geometric length, so
the route's total cost is exactly the override.

Heuristic admissibility
-----------------------
Straight-line Euclidean distance is a valid A* heuristic **only when no edge
costs less than its own geometry** — i.e. when cost == polyline length. An
override below the geometric distance (a "teleport"-priced link, or simply a
short edge carrying a tiny cost) breaks that guarantee, and A* then returns
suboptimal paths.

So `from_network` tracks whether any such override was seen and, if so,
degrades the heuristic to zero. That costs speed, never correctness — a
suboptimal route returned silently would be far worse. `shortest_path(...,
heuristic="zero")` forces the same behaviour for testing, which is how
`test_astar_agrees_with_dijkstra_on_random_networks` acts as an oracle.
"""

from __future__ import annotations

import heapq
import math
from dataclasses import dataclass, field
from typing import Any, Literal

# Positions come from a float projection; round before using as an identity key
# so that arithmetically-equal coordinates collapse to one node.
_COORD_PRECISION = 3


def _key(pos: dict[str, Any]) -> tuple[int, int, int]:
    return (
        round(float(pos.get("x", 0.0)) * 1000),
        round(float(pos.get("y", 0.0)) * 1000),
        round(float(pos.get("z", 0.0)) * 1000),
    )


def _dist(a: dict[str, Any], b: dict[str, Any]) -> float:
    return math.dist(
        (float(a.get("x", 0.0)), float(a.get("y", 0.0)), float(a.get("z", 0.0))),
        (float(b.get("x", 0.0)), float(b.get("y", 0.0)), float(b.get("z", 0.0))),
    )


def _polyline_length(waypoints: list[dict[str, Any]]) -> float:
    return sum(_dist(a, b) for a, b in zip(waypoints, waypoints[1:], strict=False))


def _road_chain(road: dict[str, Any]) -> list[dict[str, Any]]:
    """The ordered vertices of a road, with repeated positions collapsed.

    Falls back to `startNode`/`endNode` for payloads that carry no polyline.
    """
    chain: list[dict[str, Any]] = []
    for waypoint in road.get("waypoints") or []:
        if not isinstance(waypoint, dict):
            continue
        if chain and _key(chain[-1]) == _key(waypoint):
            continue
        chain.append(waypoint)
    if len(chain) < 2:
        start, end = road.get("startNode"), road.get("endNode")
        if not start or not end:
            return []
        chain = [start, end]
    return chain


def _road_oneway(road: dict[str, Any], lanes: int) -> bool:
    """Explicit `oneway` wins; the lane count is only a fallback.

    Older payloads (and hand-built networks) carry no `oneway` field, and
    for those `laneCount == 1` stays the one-way signal.
    """
    flag = road.get("oneway")
    if flag is None:
        return lanes <= 1
    return bool(flag)


def _segment_costs(
    chain: list[dict[str, Any]],
    override: float | None,
) -> list[float]:
    """Cost of each chain segment.

    Without an override the cost is the segment's geometric length. With
    one, the override is the *total* cost of the road and is distributed
    across the segments in proportion to their length, so a route over the
    whole road costs exactly the override.
    """
    lengths = [_dist(a, b) for a, b in zip(chain, chain[1:], strict=False)]
    if override is None:
        return lengths
    total = float(override)
    total_length = sum(lengths)
    if total_length <= 0.0:
        share = total / len(lengths) if lengths else 0.0
        return [share] * len(lengths)
    return [length * total / total_length for length in lengths]


@dataclass(frozen=True)
class GraphNode:
    id: str
    position: dict[str, float]
    edges: tuple[GraphEdge, ...] = field(default=(), compare=False)


@dataclass(frozen=True)
class GraphEdge:
    road_id: str
    to_node: str
    cost: float
    speed_limit: float
    lanes: int
    oneway: bool


@dataclass(frozen=True)
class PathLeg:
    road_id: str
    from_node: str
    to_node: str
    cost: float


@dataclass(frozen=True)
class Path:
    nodes: tuple[str, ...]
    legs: tuple[PathLeg, ...]
    cost: float


class RoadGraph:
    """Directed graph over a parsed RoadNetwork."""

    def __init__(
        self,
        nodes: dict[str, GraphNode],
        index: dict[tuple[int, int, int], str],
        geometric_costs: bool = True,
    ) -> None:
        self._nodes = nodes
        self._index = index
        # True when every edge cost equals its polyline length, which is what
        # makes straight-line Euclidean distance an admissible (never
        # overestimating) heuristic. A `costOverride` below geometric length
        # breaks that guarantee, so we drop to a zero heuristic rather than
        # silently returning suboptimal paths.
        self._geometric_costs = geometric_costs

    # ---- construction ----------------------------------------------------

    @classmethod
    def from_network(cls, network: dict[str, Any]) -> RoadGraph:
        """Build from the parser's `{roads: [...]}` output."""
        nodes: dict[str, GraphNode] = {}
        index: dict[tuple[int, int, int], str] = {}
        # Adjacency accumulated first, then frozen into GraphNode objects,
        # because GraphNode is immutable and edges reference node ids.
        adjacency: dict[str, list[GraphEdge]] = {}
        geometric = True

        def node_id_for(pos: dict[str, Any]) -> str:
            k = _key(pos)
            existing = index.get(k)
            if existing is not None:
                return existing
            nid = f"n-{len(nodes)}"
            index[k] = nid
            nodes[nid] = GraphNode(
                id=nid,
                position={
                    "x": float(pos.get("x", 0.0)),
                    "y": float(pos.get("y", 0.0)),
                    "z": float(pos.get("z", 0.0)),
                },
            )
            adjacency[nid] = []
            return nid

        for road in network.get("roads", []):
            chain = _road_chain(road)
            if len(chain) < 2:
                continue
            # `costOverride` is a test/authoring hook: it lets a caller state
            # a cost that deliberately disagrees with geometry (e.g. travel
            # time, congestion, or a toll) without lying about the shape.
            costs = _segment_costs(chain, road.get("costOverride"))
            lanes = int(road.get("laneCount", 2) or 2)
            oneway = _road_oneway(road, lanes)
            speed = float(road.get("speedLimit", 0.0) or 0.0)
            rid = str(road.get("id", ""))

            # Every waypoint is a node, not just the road's two ends.
            chain_ids = [node_id_for(waypoint) for waypoint in chain]

            for index_of, (a, b) in enumerate(zip(chain, chain[1:], strict=False)):
                cost = costs[index_of]
                if cost <= 0.0:
                    # Zero-length stub would make A* spin on a 0-cost cycle.
                    continue
                if cost < _dist(a, b) - 1e-9:
                    # Cost below the straight-line distance => Euclidean
                    # distance is no longer a lower bound on remaining cost.
                    geometric = False
                a_id = chain_ids[index_of]
                b_id = chain_ids[index_of + 1]
                if a_id == b_id:
                    continue  # self-loop carries no routing information

                adjacency[a_id].append(
                    GraphEdge(
                        road_id=rid,
                        to_node=b_id,
                        cost=cost,
                        speed_limit=speed,
                        lanes=lanes,
                        oneway=oneway,
                    )
                )
                if not oneway:
                    adjacency[b_id].append(
                        GraphEdge(
                            road_id=rid,
                            to_node=a_id,
                            cost=cost,
                            speed_limit=speed,
                            lanes=lanes,
                            oneway=oneway,
                        )
                    )

        frozen = {
            nid: GraphNode(id=nid, position=n.position, edges=tuple(adjacency.get(nid, ())))
            for nid, n in nodes.items()
        }
        return cls(frozen, index, geometric_costs=geometric)

    @classmethod
    def from_dict(cls, blob: dict[str, Any]) -> RoadGraph:
        """Rebuild from `to_dict()` output (JSON round-trip safe)."""
        raw_nodes: dict[str, dict[str, Any]] = blob.get("nodes", {})
        nodes: dict[str, GraphNode] = {}
        index: dict[tuple[int, int, int], str] = {}
        for nid, nb in raw_nodes.items():
            pos = nb["position"]
            nodes[nid] = GraphNode(id=nid, position=pos, edges=())
            index[_key(pos)] = nid
        frozen = {
            nid: GraphNode(
                id=nid,
                position=n.position,
                edges=tuple(
                    GraphEdge(
                        road_id=e["road_id"],
                        to_node=e["to_node"],
                        cost=float(e["cost"]),
                        speed_limit=float(e.get("speed_limit", 0.0)),
                        lanes=int(e.get("lanes", 2)),
                        oneway=bool(e.get("oneway", False)),
                    )
                    for e in raw_nodes[nid].get("edges", [])
                ),
            )
            for nid, n in nodes.items()
        }
        return cls(frozen, index)

    # ---- queries ---------------------------------------------------------

    @property
    def nodes(self) -> dict[str, GraphNode]:
        """All nodes, keyed by id."""
        return self._nodes

    @property
    def node_count(self) -> int:
        return len(self._nodes)

    @property
    def edge_count(self) -> int:
        return sum(len(n.edges) for n in self._nodes.values())

    def node_at(self, x: float, z: float, y: float = 0.0) -> GraphNode:
        """Look a node up by position. Raises KeyError if absent."""
        nid = self._index.get((round(x * 1000), round(y * 1000), round(z * 1000)))
        if nid is None:
            raise KeyError(f"no graph node at x={x} y={y} z={z}")
        return self._nodes[nid]

    def try_node_at(self, x: float, z: float, y: float = 0.0) -> GraphNode | None:
        nid = self._index.get((round(x * 1000), round(y * 1000), round(z * 1000)))
        return self._nodes.get(nid) if nid else None

    def neighbors(self, node_id: str) -> tuple[GraphEdge, ...]:
        return self._nodes[node_id].edges

    def shortest_path(
        self,
        start: str,
        goal: str,
        *,
        heuristic: Literal["euclidean", "zero"] = "euclidean",
    ) -> Path | None:
        """A* from `start` to `goal`, or None when unreachable.

        `heuristic="zero"` degrades to plain Dijkstra and exists as a test
        oracle — see `test_astar_agrees_with_dijkstra_on_random_networks`.
        """
        if start not in self._nodes or goal not in self._nodes:
            raise KeyError(f"unknown node: {start if start not in self._nodes else goal}")
        if start == goal:
            return Path(nodes=(start,), legs=(), cost=0.0)

        goal_pos = self._nodes[goal].position

        def h(nid: str) -> float:
            # Zero heuristic is always admissible (it never overestimates),
            # which is required once edge costs may dip below geometric
            # distance. It costs speed, not correctness.
            if heuristic == "zero" or not self._geometric_costs:
                return 0.0
            return _dist(self._nodes[nid].position, goal_pos)

        # Heap entries are (f, tiebreak, node_id). f is only a priority hint —
        # the authoritative cost-so-far lives in `best[node_id]`, so a stale f
        # can never corrupt the result. `tiebreak` keeps ordering stable
        # without comparing node ids.
        open_heap: list[tuple[float, int, str]] = [(h(start), 0, start)]
        best: dict[str, float] = {start: 0.0}
        came_from: dict[str, tuple[str, GraphEdge]] = {}
        closed: set[str] = set()
        tiebreak = 0

        while open_heap:
            _f, _tb, nid = heapq.heappop(open_heap)
            if nid in closed:
                continue
            closed.add(nid)
            if nid == goal:
                return self._reconstruct(came_from, start, goal, best[goal])
            g_here = best[nid]
            for edge in self._nodes[nid].edges:
                if edge.to_node in closed:
                    continue
                tentative = g_here + edge.cost
                if tentative < best.get(edge.to_node, math.inf) - 1e-9:
                    best[edge.to_node] = tentative
                    came_from[edge.to_node] = (nid, edge)
                    tiebreak += 1
                    heapq.heappush(
                        open_heap,
                        (tentative + h(edge.to_node), tiebreak, edge.to_node),
                    )
        return None

    def _reconstruct(
        self,
        came_from: dict[str, tuple[str, GraphEdge]],
        start: str,
        goal: str,
        cost: float,
    ) -> Path:
        chain: list[tuple[str, GraphEdge]] = []
        cur = goal
        hops = 0
        while cur != start:
            prev, edge = came_from[cur]
            chain.append((prev, edge))
            cur = prev
            hops += 1
            if hops > len(self._nodes):  # defensive: cycle guard
                raise RuntimeError("cycle detected while reconstructing path")
        chain.reverse()
        nodes = tuple([start] + [e.to_node for _prev, e in chain])
        legs = tuple(
            PathLeg(road_id=e.road_id, from_node=prev, to_node=e.to_node, cost=e.cost)
            for prev, e in chain
        )
        return Path(nodes=nodes, legs=legs, cost=cost)

    # ---- serialization ---------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        return {
            "nodes": {
                nid: {
                    "position": n.position,
                    "edges": [
                        {
                            "road_id": e.road_id,
                            "to_node": e.to_node,
                            "cost": e.cost,
                            "speed_limit": e.speed_limit,
                            "lanes": e.lanes,
                            "oneway": e.oneway,
                        }
                        for e in n.edges
                    ],
                }
                for nid, n in self._nodes.items()
            }
        }
