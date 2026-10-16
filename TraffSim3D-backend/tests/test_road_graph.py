"""M3 Must: OSM import must produce a *queryable* graph (节点 + 边).

The parser emits a flat `roads` list. Plan 040 built a Node+Edge graph for a
*synthetic* corridor demo scene, not for OSM import — so imported maps had no
adjacency structure, and nothing could consume one. With `astar|dijkstra`
at 0 hits repo-wide, the graph had no reader; that is the same
"structure with no consumer" defect Plan 032's A* proposal was rejected for.

`RoadGraph` supplies the missing piece: a node index, directed edges with real
costs, and (per `road_graph`) A* routing so the structure is not dead code.

Directional semantics
---------------------
The parser emits one road per OSM way with `startNode`/`endNode`. OSM ways are
*directed by convention* (the digitisation direction), but traffic on a
two-way road flows both ways. `RoadGraph` therefore adds:

- a forward edge `start -> end`, and
- a reverse edge `end -> start` for every non-`oneway` road.

The parser already halves the lane count for oneway ways, so `laneCount == 1`
is the observable signal available downstream; the graph honours that.
"""
from __future__ import annotations

import math

import pytest

from app.apps.maps.road_graph import RoadGraph


def _pos(x: float, z: float, y: float = 0.0) -> dict[str, float]:
    return {"x": x, "y": y, "z": z}


def _network(roads: list[dict]) -> dict:
    return {"roads": roads, "intersections": [], "vehicles": [], "spawnPoints": []}


def _road(rid: str, start: dict, end: dict, *, lanes: int = 2,
          speed: float = 13.89, waypoints: list[dict] | None = None,
          level: int = 0, cost_override: float | None = None) -> dict:
    """Build a parser-shaped road dict. start/end are node *positions*.

    `cost_override` lets a test state an edge cost that deliberately
    disagrees with geometry — the only way to construct routing traps.
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
    return road


# --------------------------------------------------------------------------
# Construction
# --------------------------------------------------------------------------


def test_graph_indexes_every_road_endpoint() -> None:
    net = _network([
        _road("w-1", _pos(0, 0), _pos(10, 0)),
        _road("w-2", _pos(10, 0), _pos(10, 10)),
    ])
    g = RoadGraph.from_network(net)
    assert len(g.nodes) == 3
    assert g.node_count == 3
    assert g.edge_count >= 4  # 2 roads x 2 directions


def test_shared_endpoint_becomes_one_node() -> None:
    """Two roads meeting at a corner must share a node, not duplicate it."""
    net = _network([
        _road("w-1", _pos(0, 0), _pos(10, 0)),
        _road("w-2", _pos(10, 0), _pos(10, 10)),
    ])
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
    """A curved way must cost more than its straight-line endpoints."""
    straight = _road("w-1", _pos(0, 0), _pos(0, 30))
    curved = _road(
        "w-2", _pos(0, 0), _pos(0, 30),
        waypoints=[_pos(0, 0), _pos(10, 10), _pos(0, 30)],
    )
    net = _network([straight, curved])
    g = RoadGraph.from_network(net)
    costs = {e.road_id: e.cost for e in g.neighbors(g.node_at(0, 0).id)}
    assert costs["w-2"] > costs["w-1"]
    # The curved way detours through (10,10): hypot(10,10) + hypot(10,20)
    #   = 14.142 + 22.360 = 36.503, against 30 straight-line.
    assert costs["w-2"] == pytest.approx(math.hypot(10, 10) + math.hypot(10, 20))


# --------------------------------------------------------------------------
# A* routing
# --------------------------------------------------------------------------


def _ladder() -> dict:
    """A 2x2 ladder: corners A(0,0) B(10,0) C(0,10) D(10,10)."""
    return _network([
        _road("w-ab", _pos(0, 0), _pos(10, 0)),
        _road("w-ac", _pos(0, 0), _pos(0, 10)),
        _road("w-bd", _pos(10, 0), _pos(10, 10)),
        _road("w-cd", _pos(0, 10), _pos(10, 10)),
    ])


def test_astar_finds_the_direct_route() -> None:
    g = RoadGraph.from_network(_ladder())
    path = g.shortest_path(g.node_at(0, 0).id, g.node_at(10, 0).id)
    assert path is not None
    assert [n.road_id for n in path.legs] == ["w-ab"]
    assert path.cost == pytest.approx(10.0)


def test_astar_routes_around_a_missing_link() -> None:
    """Break one edge and A* must take the long way round."""
    net = _network([
        _road("w-ab", _pos(0, 0), _pos(10, 0)),
        _road("w-ac", _pos(0, 0), _pos(0, 10)),
        _road("w-bd", _pos(10, 0), _pos(10, 10)),
        _road("w-cd", _pos(0, 10), _pos(10, 10)),
    ])
    g = RoadGraph.from_network(net)
    # Remove A<->B by making that road one-way out of B.
    net["roads"][0]["laneCount"] = 1
    net["roads"][0]["startNode"], net["roads"][0]["endNode"] = (
        _pos(10, 0), _pos(0, 0),
    )
    g2 = RoadGraph.from_network(net)
    path = g2.shortest_path(g2.node_at(0, 0).id, g2.node_at(10, 0).id)
    assert path is not None
    assert len(path.legs) == 3
    assert path.cost == pytest.approx(30.0)


def test_astar_returns_none_when_unreachable() -> None:
    net = _network([
        _road("w-1", _pos(0, 0), _pos(10, 0)),
        _road("w-2", _pos(100, 100), _pos(110, 100)),
    ])
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
    net = _network([
        _road("w-sg", _pos(0, 0), _pos(10, 10), cost_override=25.0),
        _road("w-sm", _pos(0, 0), _pos(0, 10), cost_override=10.0),
        _road("w-mg", _pos(0, 10), _pos(10, 10), cost_override=10.0),
    ])
    g = RoadGraph.from_network(net)
    path = g.shortest_path(g.node_at(0, 0).id, g.node_at(10, 10).id)
    assert path is not None
    assert path.cost == pytest.approx(20.0), (
        f"expected the 20-cost detour, got {path.cost} via "
        f"{[leg.road_id for leg in path.legs]}"
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
            targets = rng.sample([j for j in range(len(pts)) if j != i],
                                 rng.randint(1, 3))
            for k, j in enumerate(targets):
                roads.append(_road(
                    f"w-{i}-{k}", _pos(*src), _pos(*pts[j]),
                    lanes=rng.choice([1, 2]),
                    cost_override=rng.choice([None, rng.uniform(1.0, 30.0)]),
                ))
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
                assert a.cost == pytest.approx(d.cost), (
                    f"trial {trial}: A* cost {a.cost} != Dijkstra {d.cost}"
                )
                total_checked += 1
    # One-way edges legitimately make some pairs unreachable, so the guard is
    # on the corpus total rather than per trial — what matters is that the
    # oracle actually compared a meaningful number of paths.
    assert total_checked >= 100, (
        f"only {total_checked} reachable pairs compared — oracle too weak to be meaningful"
    )


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
        restored.node_at(0, 0).id, restored.node_at(10, 10).id,
    ).cost == pytest.approx(20.0)


def test_empty_network_yields_an_empty_graph() -> None:
    g = RoadGraph.from_network(_network([]))
    assert g.node_count == 0
    assert g.to_dict()["nodes"] == {}
