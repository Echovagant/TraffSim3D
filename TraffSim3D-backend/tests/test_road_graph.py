"""OSM import must produce a *queryable* graph (节点 + 边).

The parser emits a flat `roads` list. An earlier Node+Edge graph was built for a
*synthetic* corridor demo scene, not for OSM import — so imported maps had no
adjacency structure, and nothing could consume one. With `astar|dijkstra`
at 0 hits repo-wide, the graph had no reader; that is the same
"structure with no consumer" defect an earlier A* proposal was rejected for.

`RoadGraph` supplies the missing piece: a node index, directed edges with real
costs, and (per `road_graph`) A* routing so the structure is not dead code.

Directional semantics
---------------------
The parser emits one road per OSM way, and the way's geometry is a polyline.
`RoadGraph` turns that polyline into a *chain*: every waypoint is a node and
every consecutive pair of waypoints is one edge. Keeping only the road's two
endpoints (the old behaviour) shattered an imported city map into thousands
of fragments, because the parser's intersections sit at *shared* nodes, and
those are usually interior waypoints of a way.

OSM ways are *directed by convention* (the digitisation direction), but
traffic on a two-way road flows both ways. `RoadGraph` therefore adds:

- a forward edge along the chain, and
- a reverse edge for every non-`oneway` road.

The parser emits an explicit `oneway` flag; when it is absent (older
payloads) the legacy `laneCount == 1` heuristic is used instead.
"""

from __future__ import annotations

import math

import pytest

from app.apps.maps.road_graph import RoadGraph


def _pos(x: float, z: float, y: float = 0.0) -> dict[str, float]:
    return {"x": x, "y": y, "z": z}


def _network(roads: list[dict]) -> dict:
    return {"roads": roads, "intersections": [], "vehicles": [], "spawnPoints": []}


def _road(
    rid: str,
    start: dict,
    end: dict,
    *,
    lanes: int = 2,
    speed: float = 13.89,
    waypoints: list[dict] | None = None,
    level: int = 0,
    cost_override: float | None = None,
    oneway: bool | None = None,
) -> dict:
    """Build a parser-shaped road dict. start/end are node *positions*.

    `cost_override` lets a test state an edge cost that deliberately
    disagrees with geometry — the only way to construct routing traps.

    `oneway` stays `None` unless the test asks for it, so the default
    exercises the legacy "no `oneway` field" fallback.
    """
    road = {
        "id": rid,
        "startNode": start,
        "endNode": end,
        "waypoints": waypoints or [start, end],
        "laneCount": lanes,
        "speedLimit": speed,
        "level": level,
    }
    if cost_override is not None:
        road["costOverride"] = cost_override
    if oneway is not None:
        road["oneway"] = oneway
    return road


# --------------------------------------------------------------------------
# Construction
# --------------------------------------------------------------------------


def test_graph_indexes_every_road_endpoint() -> None:
    net = _network(
        [
            _road("w-1", _pos(0, 0), _pos(10, 0)),
            _road("w-2", _pos(10, 0), _pos(10, 10)),
        ]
    )
    g = RoadGraph.from_network(net)
    assert len(g.nodes) == 3
    assert g.node_count == 3
    assert g.edge_count >= 4  # 2 roads x 2 directions


def test_shared_endpoint_becomes_one_node() -> None:
    """Two roads meeting at a corner must share a node, not duplicate it."""
    net = _network(
        [
            _road("w-1", _pos(0, 0), _pos(10, 0)),
            _road("w-2", _pos(10, 0), _pos(10, 10)),
        ]
    )
    g = RoadGraph.from_network(net)
    corner = g.node_at(10, 0)
    assert corner is not None
    assert len(g.neighbors(corner.id)) == 2


def test_road_ids_are_stable_and_derived_from_geometry() -> None:
    """Node ids must be reproducible across parses of the same input."""
    net = _network([_road("w-1", _pos(0, 0), _pos(10, 0))])
    a = RoadGraph.from_network(net)
    b = RoadGraph.from_network(net)
    assert set(a.nodes) == set(b.nodes)
    assert {nid: n.position for nid, n in a.nodes.items()} == {
        nid: n.position for nid, n in b.nodes.items()
    }


# --------------------------------------------------------------------------
# Directionality
# --------------------------------------------------------------------------


def test_two_way_road_is_traversable_in_both_directions() -> None:
    net = _network([_road("w-1", _pos(0, 0), _pos(10, 0), lanes=2)])
    g = RoadGraph.from_network(net)
    a, b = g.node_at(0, 0).id, g.node_at(10, 0).id
    assert any(e.to_node == b for e in g.neighbors(a))
    assert any(e.to_node == a for e in g.neighbors(b))


def test_single_lane_road_is_one_way() -> None:
    """The parser halves lanes for oneway ways; laneCount==1 means one-way."""
    net = _network([_road("w-1", _pos(0, 0), _pos(10, 0), lanes=1)])
    g = RoadGraph.from_network(net)
    a, b = g.node_at(0, 0).id, g.node_at(10, 0).id
    assert any(e.to_node == b for e in g.neighbors(a))
    assert not any(e.to_node == a for e in g.neighbors(b)), "oneway must not be reversible"


def test_explicit_oneway_field_overrides_the_lane_heuristic() -> None:
    """The payload's `oneway` flag wins over the legacy lane heuristic.

    `lanes <= 1` used to be the only one-way signal available, so a real
    one-way street with four lanes was read as two-way.
    """
    net = _network([_road("w-1", _pos(0, 0), _pos(10, 0), lanes=2, oneway=True)])
    g = RoadGraph.from_network(net)
    a, b = g.node_at(0, 0).id, g.node_at(10, 0).id
    assert any(e.to_node == b for e in g.neighbors(a))
    assert not any(e.to_node == a for e in g.neighbors(b)), "explicit oneway must not be reversible"

    # ... and the other way round: an explicit two-way road stays two-way
    # even when the lane count would have said otherwise.
    net2 = _network([_road("w-2", _pos(0, 0), _pos(10, 0), lanes=1, oneway=False)])
    g2 = RoadGraph.from_network(net2)
    a2, b2 = g2.node_at(0, 0).id, g2.node_at(10, 0).id
    assert any(e.to_node == a2 for e in g2.neighbors(b2))


def test_missing_oneway_field_falls_back_to_the_lane_heuristic() -> None:
    """Older payloads carry no `oneway` field; the heuristic still applies."""
    net = _network([_road("w-1", _pos(0, 0), _pos(10, 0), lanes=1)])
    assert "oneway" not in net["roads"][0]
    g = RoadGraph.from_network(net)
    a, b = g.node_at(0, 0).id, g.node_at(10, 0).id
    assert not any(e.to_node == a for e in g.neighbors(b))


def test_edge_carries_road_attributes() -> None:
    net = _network([_road("w-1", _pos(0, 0), _pos(10, 0), lanes=2, speed=22.2)])
    g = RoadGraph.from_network(net)
    e = g.neighbors(g.node_at(0, 0).id)[0]
    assert e.road_id == "w-1"
    assert e.speed_limit == pytest.approx(22.2)
    assert e.lanes == 2


def test_edge_cost_is_road_length_in_meters() -> None:
    net = _network([_road("w-1", _pos(0, 0), _pos(3, 4))])  # 3-4-5 triangle
    g = RoadGraph.from_network(net)
    e = g.neighbors(g.node_at(0, 0).id)[0]
    assert e.cost == pytest.approx(5.0)


def test_polyline_length_uses_all_waypoints() -> None:
    """A curved way must cost more than its straight-line endpoints.

    A road is a chain of edges — one per consecutive pair of waypoints — so
    the curved way's price is the *route* over both of its segments, not the
    price of a single edge.
    """
    straight = _road("w-1", _pos(0, 0), _pos(0, 30))
    curved = _road(
        "w-2",
        _pos(0, 0),
        _pos(0, 30),
        waypoints=[_pos(0, 0), _pos(10, 10), _pos(0, 30)],
    )
    g_straight = RoadGraph.from_network(_network([straight]))
    g_curved = RoadGraph.from_network(_network([curved]))
    straight_cost = g_straight.shortest_path(
        g_straight.node_at(0, 0).id, g_straight.node_at(0, 30).id
    ).cost
    curved_cost = g_curved.shortest_path(g_curved.node_at(0, 0).id, g_curved.node_at(0, 30).id).cost
    assert curved_cost > straight_cost
    # The curved way detours through (10,10): hypot(10,10) + hypot(10,20)
    #   = 14.142 + 22.360 = 36.503, against 30 straight-line.
    assert curved_cost == pytest.approx(math.hypot(10, 10) + math.hypot(10, 20))
    # The intermediate waypoint is a node of its own.
    assert g_curved.node_count == 3
    assert g_curved.try_node_at(10, 10) is not None


# --------------------------------------------------------------------------
# Connectivity: a road is a chain of edges, not a single edge
# --------------------------------------------------------------------------


def _component_count(g: RoadGraph) -> int:
    """Number of connected components, ignoring edge direction.

    Direction is ignored on purpose: a one-way road still belongs to the
    same component as the roads it joins.
    """
    blob = g.to_dict()["nodes"]
    adjacency: dict[str, set[str]] = {nid: set() for nid in blob}
    for nid, node in blob.items():
        for edge in node["edges"]:
            adjacency[nid].add(edge["to_node"])
            adjacency[edge["to_node"]].add(nid)
    seen: set[str] = set()
    count = 0
    for nid in blob:
        if nid in seen:
            continue
        count += 1
        stack = [nid]
        seen.add(nid)
        while stack:
            for neighbour in adjacency[stack.pop()]:
                if neighbour not in seen:
                    seen.add(neighbour)
                    stack.append(neighbour)
    return count


def _t_junction() -> dict:
    """A T junction: a stem meeting a through road at a shared node.

    The shared node is an *interior* waypoint of the through road, which is
    exactly the case that shattered the graph when it only carried the
    road's two endpoints.
    """
    return _network(
        [
            _road(
                "w-stem",
                _pos(0, 0),
                _pos(0, -10),
                waypoints=[_pos(0, 0), _pos(0, -5), _pos(0, -10)],
            ),
            _road(
                "w-through",
                _pos(-10, 0),
                _pos(10, 0),
                waypoints=[_pos(-10, 0), _pos(-5, 0), _pos(0, 0), _pos(5, 0), _pos(10, 0)],
            ),
        ]
    )


def test_t_junction_is_a_single_connected_component() -> None:
    """One component — the roads must actually meet in the graph.

    With endpoints-only nodes the junction node exists in the road list but
    not in the graph, and the T falls apart into two fragments.
    """
    g = RoadGraph.from_network(_t_junction())
    assert _component_count(g) == 1
    # 3 stem vertices + 5 through vertices, sharing the junction vertex.
    assert g.node_count == 7


def test_junction_node_is_shared_by_both_roads() -> None:
    g = RoadGraph.from_network(_t_junction())
    junction = g.node_at(0, 0)
    road_ids = {edge.road_id for edge in g.neighbors(junction.id)}
    assert road_ids == {"w-stem", "w-through"}


def test_every_waypoint_becomes_a_graph_node() -> None:
    net = _network(
        [
            _road(
                "w-1",
                _pos(0, 0),
                _pos(10, 0),
                waypoints=[_pos(0, 0), _pos(4, 0), _pos(7, 0), _pos(10, 0)],
            )
        ]
    )
    g = RoadGraph.from_network(net)
    assert g.node_count == 4
    for x in (0, 4, 7, 10):
        assert g.try_node_at(x, 0) is not None
    # 3 segments, each with a forward and a reverse edge.
    assert g.edge_count == 6


def test_chain_edges_carry_their_own_segment_cost() -> None:
    net = _network(
        [
            _road(
                "w-1",
                _pos(0, 0),
                _pos(10, 0),
                waypoints=[_pos(0, 0), _pos(3, 4), _pos(10, 0)],
            )
        ]
    )
    g = RoadGraph.from_network(net)
    first = next(e for e in g.neighbors(g.node_at(0, 0).id) if e.to_node != g.node_at(0, 0).id)
    assert first.cost == pytest.approx(5.0)  # the 3-4-5 first segment


def test_cost_override_is_split_across_the_chain() -> None:
    """The override is the road's total cost, not one edge's cost."""
    net = _network(
        [
            _road(
                "w-1",
                _pos(0, 0),
                _pos(10, 0),
                waypoints=[_pos(0, 0), _pos(5, 0), _pos(10, 0)],
                cost_override=100.0,
            )
        ]
    )
    g = RoadGraph.from_network(net)
    path = g.shortest_path(g.node_at(0, 0).id, g.node_at(10, 0).id)
    assert path is not None
    assert path.cost == pytest.approx(100.0)
    assert len(path.legs) == 2


# --------------------------------------------------------------------------
# A* routing
# --------------------------------------------------------------------------


def _ladder() -> dict:
    """A 2x2 ladder: corners A(0,0) B(10,0) C(0,10) D(10,10)."""
    return _network(
        [
            _road("w-ab", _pos(0, 0), _pos(10, 0)),
            _road("w-ac", _pos(0, 0), _pos(0, 10)),
            _road("w-bd", _pos(10, 0), _pos(10, 10)),
            _road("w-cd", _pos(0, 10), _pos(10, 10)),
        ]
    )


def test_astar_finds_the_direct_route() -> None:
    g = RoadGraph.from_network(_ladder())
    path = g.shortest_path(g.node_at(0, 0).id, g.node_at(10, 0).id)
    assert path is not None
    assert [n.road_id for n in path.legs] == ["w-ab"]
    assert path.cost == pytest.approx(10.0)


def test_astar_routes_around_a_missing_link() -> None:
    """Break one edge and A* must take the long way round."""
    net = _network(
        [
            _road("w-ab", _pos(0, 0), _pos(10, 0)),
            _road("w-ac", _pos(0, 0), _pos(0, 10)),
            _road("w-bd", _pos(10, 0), _pos(10, 10)),
            _road("w-cd", _pos(0, 10), _pos(10, 10)),
        ]
    )
    g = RoadGraph.from_network(net)
    # Remove A<->B by making that road one-way out of B. The chain's
    # direction follows the waypoints, so those have to be flipped too.
    net["roads"][0]["laneCount"] = 1
    net["roads"][0]["startNode"], net["roads"][0]["endNode"] = (
        _pos(10, 0),
        _pos(0, 0),
    )
    net["roads"][0]["waypoints"] = [_pos(10, 0), _pos(0, 0)]
    g2 = RoadGraph.from_network(net)
    path = g2.shortest_path(g2.node_at(0, 0).id, g2.node_at(10, 0).id)
    assert path is not None
    assert len(path.legs) == 3
    assert path.cost == pytest.approx(30.0)


def test_astar_returns_none_when_unreachable() -> None:
    net = _network(
        [
            _road("w-1", _pos(0, 0), _pos(10, 0)),
            _road("w-2", _pos(100, 100), _pos(110, 100)),
        ]
    )
    g = RoadGraph.from_network(net)
    assert g.shortest_path(g.node_at(0, 0).id, g.node_at(10, 0).id) is not None
    assert g.shortest_path(g.node_at(0, 0).id, g.node_at(110, 100).id) is None


def test_astar_respects_oneway_direction() -> None:
    """A one-way edge must not be traversable backwards."""
    net = _network([_road("w-1", _pos(0, 0), _pos(10, 0), lanes=1)])
    g = RoadGraph.from_network(net)
    assert g.shortest_path(g.node_at(0, 0).id, g.node_at(10, 0).id) is not None
    assert g.shortest_path(g.node_at(10, 0).id, g.node_at(0, 0).id) is None


def test_astar_prefers_a_longer_looking_detour_when_it_is_cheaper() -> None:
    """The classic inadmissible-heuristic trap, made deterministic.

    Geometry:  S(0,0) --- M(0,10) --- G(10,10),  plus a direct S->G.
    Costs:     the two-hop detour totals 20; the direct edge costs 25.

    The direct edge is geometrically *shorter* than the detour, so a
    Euclidean heuristic rates it favourably. A naive agent that trusts the
    heuristic over the true cost returns 25 here. Correct A* must return 20 —
    the whole point of expanding on `g + h` rather than on `h` alone.
    """
    net = _network(
        [
            _road("w-sg", _pos(0, 0), _pos(10, 10), cost_override=25.0),
            _road("w-sm", _pos(0, 0), _pos(0, 10), cost_override=10.0),
            _road("w-mg", _pos(0, 10), _pos(10, 10), cost_override=10.0),
        ]
    )
    g = RoadGraph.from_network(net)
    path = g.shortest_path(g.node_at(0, 0).id, g.node_at(10, 10).id)
    assert path is not None
    assert path.cost == pytest.approx(20.0), (
        f"expected the 20-cost detour, got {path.cost} via " f"{[leg.road_id for leg in path.legs]}"
    )
    assert [leg.road_id for leg in path.legs] == ["w-sm", "w-mg"]


def test_astar_agrees_with_dijkstra_on_random_networks() -> None:
    """Correctness oracle: A* must match Dijkstra (heuristic disabled).

    Points are forced distinct — with random ints on a small grid, duplicates
    silently collapse into shared nodes and the graph degenerates into a few
    special cases that any implementation happens to pass.
    """
    import random

    rng = random.Random(20261017)
    total_checked = 0
    for trial in range(30):
        # Distinct lattice points on a 13x13 grid, plus random costs that
        # sometimes disagree with geometry.
        pts = rng.sample([(x, y) for x in range(13) for y in range(13)], 12)
        roads = []
        # Connect each point to 1-3 others so the graph stays well connected;
        # a bare chain leaves too few reachable pairs to be a meaningful oracle.
        for i, src in enumerate(pts):
            targets = rng.sample([j for j in range(len(pts)) if j != i], rng.randint(1, 3))
            for k, j in enumerate(targets):
                roads.append(
                    _road(
                        f"w-{i}-{k}",
                        _pos(*src),
                        _pos(*pts[j]),
                        lanes=rng.choice([1, 2]),
                        cost_override=rng.choice([None, rng.uniform(1.0, 30.0)]),
                    )
                )
        net = _network(roads)
        g = RoadGraph.from_network(net)
        for _ in range(6):
            src, dst = rng.sample(range(len(pts)), 2)
            s_id, d_id = g.node_at(*pts[src]).id, g.node_at(*pts[dst]).id
            a = g.shortest_path(s_id, d_id)
            d = g.shortest_path(s_id, d_id, heuristic="zero")
            if (a is None) != (d is None):
                pytest.fail(f"trial {trial}: A* and Dijkstra disagree on reachability")
            if a is not None:
                assert a.cost == pytest.approx(
                    d.cost
                ), f"trial {trial}: A* cost {a.cost} != Dijkstra {d.cost}"
                total_checked += 1
    # One-way edges legitimately make some pairs unreachable, so the guard is
    # on the corpus total rather than per trial — what matters is that the
    # oracle actually compared a meaningful number of paths.
    assert (
        total_checked >= 100
    ), f"only {total_checked} reachable pairs compared — oracle too weak to be meaningful"


def test_astar_agrees_with_dijkstra_on_multi_waypoint_networks() -> None:
    """The chain edges must not break the A*/Dijkstra oracle.

    The random-network oracle above only exercises two-point roads. This
    one uses bent roads with an intermediate waypoint, so every road
    contributes several edges and the heuristic has to stay admissible
    across a chain.
    """
    import random

    rng = random.Random(20261023)
    total_checked = 0
    for trial in range(20):
        pts = rng.sample([(x, y) for x in range(11) for y in range(11)], 8)
        roads = []
        for i, src in enumerate(pts):
            targets = rng.sample([j for j in range(len(pts)) if j != i], rng.randint(1, 2))
            for k, j in enumerate(targets):
                mid = (rng.randint(0, 10), rng.randint(0, 10))
                roads.append(
                    _road(
                        f"w-{i}-{k}",
                        _pos(*src),
                        _pos(*pts[j]),
                        waypoints=[_pos(*src), _pos(*mid), _pos(*pts[j])],
                        lanes=rng.choice([1, 2]),
                    )
                )
        g = RoadGraph.from_network(_network(roads))
        for _ in range(5):
            src, dst = rng.sample(range(len(pts)), 2)
            s_id, d_id = g.node_at(*pts[src]).id, g.node_at(*pts[dst]).id
            a = g.shortest_path(s_id, d_id)
            d = g.shortest_path(s_id, d_id, heuristic="zero")
            if (a is None) != (d is None):
                pytest.fail(f"trial {trial}: A* and Dijkstra disagree on reachability")
            if a is not None:
                assert a.cost == pytest.approx(
                    d.cost
                ), f"trial {trial}: A* cost {a.cost} != Dijkstra {d.cost}"
                total_checked += 1
    assert (
        total_checked >= 30
    ), f"only {total_checked} reachable pairs compared — oracle too weak to be meaningful"


def test_unknown_node_id_raises() -> None:
    g = RoadGraph.from_network(_ladder())
    with pytest.raises(KeyError):
        g.shortest_path("nope", g.node_at(0, 0).id)


# --------------------------------------------------------------------------
# Serialization
# --------------------------------------------------------------------------


def test_graph_serializes_to_plain_json_types() -> None:
    """The graph must survive a JSON round-trip for API/cache use."""
    g = RoadGraph.from_network(_ladder())
    blob = g.to_dict()
    import json

    text = json.dumps(blob)  # must not raise
    restored = RoadGraph.from_dict(json.loads(text))
    assert restored.node_count == g.node_count
    assert restored.edge_count == g.edge_count
    assert restored.shortest_path(
        restored.node_at(0, 0).id,
        restored.node_at(10, 10).id,
    ).cost == pytest.approx(20.0)


def test_empty_network_yields_an_empty_graph() -> None:
    g = RoadGraph.from_network(_network([]))
    assert g.node_count == 0
    assert g.to_dict()["nodes"] == {}
