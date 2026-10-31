"""Route planning over the scene network — `POST /api/v1/routes/plan`.

The product feature behind this endpoint is a single story: **plan a
route, then watch a car drive it from the driver's seat**. Two halves
have to be right for that to work.

**The path.** The graph is `app.apps.maps.road_graph.RoadGraph` — a
*directed* graph over the network's waypoints. One-way streets cannot be
traversed backwards, and the returned legs say which way each road is
entered (`from_node` → `to_node`), so the caller never has to guess the
direction of a road it is about to drive.

**The direction.** A car is not at a point; it is at a point *heading
somewhere*. It will next arrive at the end of the road it is on, in the
direction it is driving. So the start of a route is expressed as "the
end of this road, in this direction" rather than as a bare position,
and the path is computed from the node the car reaches **next**. That is
what makes the returned leg sequence drivable: the first leg starts
exactly where the car is going.

The response carries the ordered **legs** (each one a road, the two
nodes it joins and its cost), which is everything the browser needs:
the polyline to draw, and the road to take at the next junction.

This is the *product* routing API. The training environment has its own
routing (`app.apps.rl.network_graph.find_route`, a segment-level
Dijkstra) and it stays where it is: that one prices a route over the
RL env's own segment graph, this one answers a question about the scene
the user is looking at.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.apps.maps.road_graph import GraphNode, Path, PathLeg, RoadGraph, road_chain

router = APIRouter()

#: How far (m) a junction's position may sit from the graph's nearest
#: node and still be taken as "that node". A few metres is generous for
#: a rounding difference and far below the spacing of two junctions.
_NODE_SNAP_DISTANCE_M = 5.0


class RouteEndpoint(BaseModel):
    """One end of a planned route.

    Either a **junction** (`junction_id`) or the **directional end of a
    road** (`road_id` + `direction`) — the latter is how a moving car is
    addressed: it is not at a junction yet, it is on a road, heading for
    one of that road's two ends.
    """

    junction_id: str | None = None
    road_id: str | None = None
    #: `forward` = the road's start→end travel direction (the car arrives
    #: at the road's LAST waypoint); `backward` = the opposite.
    direction: Literal["forward", "backward"] = "forward"


class RouteRequest(BaseModel):
    """The scene network plus the two ends of the route."""

    network: dict[str, Any] = Field(default_factory=dict)
    start: RouteEndpoint
    end: RouteEndpoint


@router.post("/routes/plan", tags=["routes"])
def plan_route(req: RouteRequest) -> dict[str, Any]:
    """Plan the cheapest route between two places in the scene.

    The request carries the scene's serialized network (the same shape
    the RL endpoints take) and the two ends of the route. The response
    is the ordered list of legs, or `found: false` when the two ends are
    not connected.

    Errors:
      - 400: the network is empty or malformed
      - 404: one of the ends names a junction / road that is not in the
        network, or sits further than `NODE_SNAP_DISTANCE_M` from any of
        its nodes
    """
    network = req.network or {}
    if not network.get("roads"):
        raise HTTPException(status_code=400, detail="network has no roads")

    try:
        graph = RoadGraph.from_network(network)
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"invalid network: {exc}") from exc

    start_node = _resolve_endpoint(graph, network, req.start, "start")
    end_node = _resolve_endpoint(graph, network, req.end, "end")

    # A car that starts *on a road* is already committed to that road: it
    # will reach the far end of it, and the route continues from there.
    # Its own road must therefore not be the route's first leg — that
    # would be a U-turn at the junction it is about to reach. (With equal
    # lengths the search happily picks it: a square grid has two ways
    # round, and the A* heap order decides which one comes first.)
    forbid_first_road = req.start.road_id

    path = _shortest_path_avoiding_first_road(graph, start_node.id, end_node.id, forbid_first_road)
    if path is None:
        return {
            "found": False,
            "roads": [],
            "legs": [],
            "cost_m": 0.0,
            "start_node": start_node.id,
            "end_node": end_node.id,
        }

    legs = [
        {
            "road_id": leg.road_id,
            "from": _position(graph, leg.from_node),
            "to": _position(graph, leg.to_node),
            "cost_m": leg.cost,
        }
        for leg in path.legs
    ]
    return {
        "found": True,
        "roads": [leg["road_id"] for leg in legs],
        "legs": legs,
        "cost_m": path.cost,
        "start_node": start_node.id,
        "end_node": end_node.id,
    }


def _shortest_path_avoiding_first_road(
    graph: RoadGraph,
    start_node_id: str,
    end_node_id: str,
    forbid_first_road: str | None,
) -> Path | None:
    """The cheapest path whose FIRST leg is not `forbid_first_road`.

    With no road to avoid this is the plain search. With one, the first
    step is taken by hand — every outgoing edge except the forbidden
    road's — and the search continues from where that edge lands. The
    cheapest of those continuations wins.
    """
    if forbid_first_road is None:
        return graph.shortest_path(start_node_id, end_node_id)

    best: Path | None = None
    for edge in graph.neighbors(start_node_id):
        if edge.road_id == forbid_first_road:
            continue
        rest = graph.shortest_path(edge.to_node, end_node_id)
        if rest is None:
            continue
        candidate = Path(
            nodes=(start_node_id, *rest.nodes),
            legs=(
                PathLeg(
                    road_id=edge.road_id,
                    from_node=start_node_id,
                    to_node=edge.to_node,
                    cost=edge.cost,
                ),
                *rest.legs,
            ),
            cost=edge.cost + rest.cost,
        )
        if best is None or candidate.cost < best.cost:
            best = candidate
    return best


def _resolve_endpoint(
    graph: RoadGraph,
    network: dict[str, Any],
    endpoint: RouteEndpoint,
    label: str,
) -> GraphNode:
    """The graph node an endpoint refers to.

    Raises HTTPException(404) when the endpoint names something that is
    not in the network — a route that silently planned from "somewhere
    near the target" would be worse than one that says it cannot.
    """
    position: dict[str, Any] | None = None

    if endpoint.junction_id is not None:
        for inter in network.get("intersections", []) or []:
            if str(inter.get("id", "")) == endpoint.junction_id:
                position = inter.get("position")
                break
        if position is None:
            raise HTTPException(
                status_code=404,
                detail=f"{label} junction not found: {endpoint.junction_id}",
            )
    elif endpoint.road_id is not None:
        for road in network.get("roads", []) or []:
            if str(road.get("id", "")) == endpoint.road_id:
                chain = road_chain(road)
                if len(chain) < 2:
                    raise HTTPException(
                        status_code=400,
                        detail=f"{label} road has no usable geometry: {endpoint.road_id}",
                    )
                # A car driving forward along the road arrives at the
                # chain's LAST vertex; one driving backward arrives at
                # the first.
                position = chain[-1] if endpoint.direction == "forward" else chain[0]
                break
        if position is None:
            raise HTTPException(
                status_code=404,
                detail=f"{label} road not found: {endpoint.road_id}",
            )
    else:
        raise HTTPException(
            status_code=400,
            detail=f"{label} needs a junction_id or a road_id",
        )

    x = float(position.get("x", 0.0))
    y = float(position.get("y", 0.0))
    z = float(position.get("z", 0.0))
    # The graph's node index is keyed by the exact (rounded) position of
    # a waypoint. An intersection usually sits exactly on one, but it may
    # differ by a rounding step — or by a whole level, on a raised road.
    node = graph.try_node_at(x, z, y) or graph.try_node_at(x, z, 0.0)
    if node is None:
        node = graph.nearest_node(x, z, y, _NODE_SNAP_DISTANCE_M)
    if node is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"{label} is further than {_NODE_SNAP_DISTANCE_M} m from any road "
                f"in the network ({x:.1f}, {y:.1f}, {z:.1f})"
            ),
        )
    return node


def _position(graph: RoadGraph, node_id: str) -> dict[str, float]:
    """A node's world position, for drawing the route."""
    pos = graph.node(node_id).position
    return {
        "x": float(pos.get("x", 0.0)),
        "y": float(pos.get("y", 0.0)),
        "z": float(pos.get("z", 0.0)),
    }
