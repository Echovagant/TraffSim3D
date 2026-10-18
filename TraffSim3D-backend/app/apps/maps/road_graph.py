"""M3 Must: turn a parsed OSM RoadNetwork into a queryable graph.

The parser emits a flat `roads` list — convenient for rendering, useless for
anything that has to *decide*. §4.2 M3 promises "路网转换为内部图结构
（节点+边）"; before this module the only Node+Edge graph in the repo
(Plan 040) belonged to a synthetic corridor demo, so imported OSM maps had no
adjacency and no consumer could exist.

This module supplies the missing structure and, with it, a consumer: A* routing.

Node identity
-------------
Nodes are derived from **projected geometry** (`x`,`y`,`z` rounded to
`_COORD_PRECISION`), not from road indices, so that two roads meeting at an
intersection resolve to the same node and node ids are reproducible across
parses of identical input.

Directionality
--------------
The parser emits one road per OSM way with `startNode`/`endNode`. OSM ways are
directed by digitisation convention, but traffic on a two-way road flows both
ways, so each road contributes a forward edge and — unless it is one-way — a
reverse edge. The parser already halves lane count for oneway ways, so
`laneCount == 1` is the observable one-way signal.

Cost
----
Polyline length in meters (sum of consecutive `waypoints`), not straight-line
endpoints, so curved ways are priced honestly. A `costOverride` may replace
that length (travel time, congestion, toll) without changing the shape.

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
            start, end = road.get("startNode"), road.get("endNode")
            if not start or not end:
                continue
            waypoints = road.get("waypoints") or [start, end]
            # `costOverride` is a test/authoring hook: it lets a caller state
            # a cost that deliberately disagrees with geometry (e.g. travel
            # time, congestion, or a toll) without lying about the shape.
            override = road.get("costOverride")
            geometric_cost = _polyline_length(waypoints)
            if override is None:
                cost = geometric_cost
            else:
                cost = float(override)
                if cost < geometric_cost - 1e-9:
                    # Cost below the straight-line distance => Euclidean
                    # distance is no longer a lower bound on remaining cost.
                    geometric = False
            if cost <= 0.0:
                # Zero-length stub would make A* spin on a 0-cost cycle.
                continue

            lanes = int(road.get("laneCount", 2) or 2)
            oneway = lanes <= 1
            speed = float(road.get("speedLimit", 0.0) or 0.0)
            rid = str(road.get("id", ""))

            s_id = node_id_for(start)
            e_id = node_id_for(end)
            if s_id == e_id:
                continue  # self-loop carries no routing information

            adjacency[s_id].append(
                GraphEdge(
                    road_id=rid,
                    to_node=e_id,
                    cost=cost,
                    speed_limit=speed,
                    lanes=lanes,
                    oneway=oneway,
                )
            )
            if not oneway:
                adjacency[e_id].append(
                    GraphEdge(
                        road_id=rid,
                        to_node=s_id,
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
