"""Behavioural tests for the road network graph.

The graph is the bridge between the frontend's serialized network and the
network-level simulation core, so its two load-bearing properties are:

* the topology it builds corresponds to the roads it was given, and
* it is **directed** — a one-way road may not be driven backwards, which is
  what makes a route non-reversible.

These are property assertions, not snapshots.
"""

from __future__ import annotations

import itertools

import pytest

from app.apps.rl.network_graph import (
    Route,
    build_network_graph,
    find_route,
    point_on_road,
    route_cost,
)


def _road(road_id: str, start: tuple[float, float], end: tuple[float, float], **extra) -> dict:
    return {
        "id": road_id,
        "startNode": {"x": start[0], "z": start[1]},
        "endNode": {"x": end[0], "z": end[1]},
        "laneCount": 2,
        "speedLimit": 16.67,
        **extra,
    }


def _intersection(node_id: str, pos: tuple[float, float], roads: list[str]) -> dict:
    return {
        "id": node_id,
        "position": {"x": pos[0], "z": pos[1]},
        "connectedRoads": roads,
        "trafficLights": [],
        "intersectionRadius": 8.0,
    }


def _line_network(road_ids: list[str], oneway: set[str] | None = None) -> dict:
    """A chain of intersections joined by one road each.

    `road_ids[i]` runs from intersection `i` to intersection `i + 1`.
    """
    oneway = oneway or set()
    count = len(road_ids) + 1
    intersections = [
        _intersection(
            f"I{i}",
            (i * 100.0, 0.0),
            [road_ids[i - 1]] if i > 0 else ([road_ids[0]] if road_ids else []),
        )
        for i in range(count)
    ]
    # An interior intersection touches the road before and the road after it.
    for i in range(1, count - 1):
        intersections[i]["connectedRoads"] = [road_ids[i - 1], road_ids[i]]
    if count > 1:
        intersections[0]["connectedRoads"] = [road_ids[0]]
        intersections[count - 1]["connectedRoads"] = [road_ids[-1]]

    roads = [
        _road(
            road_id,
            (i * 100.0, 0.0),
            ((i + 1) * 100.0, 0.0),
            oneway=road_id in oneway,
        )
        for i, road_id in enumerate(road_ids)
    ]
    return {"roads": roads, "intersections": intersections, "vehicles": []}


def _t_junction_network(oneway_a: bool) -> dict:
    """A junction where three roads meet.

    `a` runs into the junction, `b` runs out of it and `c` runs into it from
    the far side — so `c -> a` is a legal route only while `a` is
    bidirectional.
    """
    return {
        "roads": [
            _road("a", (0.0, 0.0), (100.0, 0.0), oneway=oneway_a),
            _road("b", (200.0, 0.0), (100.0, 0.0)),
            _road("c", (100.0, 0.0), (200.0, 0.0)),
        ],
        "intersections": [
            _intersection("I1", (0.0, 0.0), ["a"]),
            _intersection("I2", (100.0, 0.0), ["a", "b", "c"]),
            _intersection("I3", (200.0, 0.0), ["b", "c"]),
        ],
        "vehicles": [],
    }


def test_graph_has_one_segment_per_road() -> None:
    """The graph's edges correspond to the roads it was given."""
    network = _line_network(["r0", "r1", "r2"])
    graph = build_network_graph(network)

    assert set(graph.segments) == {"r0", "r1", "r2"}
    assert len(graph.segments) == len(network["roads"])


def test_graph_has_one_node_per_intersection() -> None:
    """The graph's nodes correspond to the intersections it was given."""
    network = _line_network(["r0", "r1", "r2"])
    graph = build_network_graph(network)

    assert set(graph.nodes) == {"I0", "I1", "I2", "I3"}
    assert len(graph.real_intersections) == len(network["intersections"])


def test_segment_length_is_the_polyline_length() -> None:
    """A road's length is the summed length of its points."""
    network = _line_network(["r0", "r1"])
    graph = build_network_graph(network)

    assert graph.segments["r0"].length == pytest.approx(100.0)
    assert graph.segments["r1"].length == pytest.approx(100.0)


def test_endpoints_match_the_intersections() -> None:
    """A road between two intersections is anchored to both of them."""
    graph = build_network_graph(_line_network(["r0", "r1"]))

    assert graph.segment_endpoints["r0"] == ("I0", "I1")
    assert graph.segment_endpoints["r1"] == ("I1", "I2")


def test_a_route_exists_and_its_cost_is_the_sum_of_its_segments() -> None:
    """A route is a real chain of adjacent segments, priced by their length."""
    graph = build_network_graph(_line_network(["r0", "r1", "r2"]))

    route = find_route(graph, "r0", "r2")

    assert route.found
    assert route.segment_ids == ["r0", "r1", "r2"]
    # Every hop must be a legal transition.
    for current, nxt in zip(route.segment_ids, route.segment_ids[1:], strict=False):
        assert nxt in graph.adjacent_segments(current)
    # The cost is exactly the summed length of the segments on the route.
    expected = sum(graph.segments[sid].length for sid in route.segment_ids)
    assert route_cost(graph, route) == pytest.approx(expected)


def _diamond_network() -> dict:
    """A network with two routes between the same pair of roads.

    `r0 → r1 → r2` is the short way round; `r0 → s → r2` is a long detour.
    """
    return {
        "roads": [
            _road("r0", (0.0, 0.0), (100.0, 0.0)),
            _road("r1", (100.0, 0.0), (200.0, 0.0)),
            _road("r2", (200.0, 0.0), (200.0, 400.0)),
            _road("s", (100.0, 0.0), (200.0, 400.0)),
        ],
        "intersections": [
            _intersection("I0", (0.0, 0.0), ["r0"]),
            _intersection("I1", (100.0, 0.0), ["r0", "r1", "s"]),
            _intersection("I2", (200.0, 0.0), ["r1", "r2"]),
            _intersection("I3", (200.0, 400.0), ["r2", "s"]),
        ],
        "vehicles": [],
    }


def test_the_route_is_the_cheapest_one() -> None:
    """The router is optimal — brute force agrees.

    Every simple path is enumerated and the cheapest is compared with what
    `find_route` returned.
    """
    graph = build_network_graph(_diamond_network())
    route = find_route(graph, "r0", "r2")

    def cheapest_tail(current: str, visited: frozenset[str]) -> tuple[float, list[str]] | None:
        """(cost of the path *after* `current`, that path) — None if `r2` is unreachable."""
        best: tuple[float, list[str]] | None = None
        for nxt in graph.adjacent_segments(current):
            if nxt in visited:
                continue
            if nxt == "r2":
                candidate = (graph.segments[nxt].length, [nxt])
            else:
                sub = cheapest_tail(nxt, visited | {nxt})
                if sub is None:
                    continue
                candidate = (graph.segments[nxt].length + sub[0], [nxt, *sub[1]])
            if best is None or candidate[0] < best[0]:
                best = candidate
        return best

    tail = cheapest_tail("r0", frozenset({"r0"}))
    assert tail is not None
    best = ["r0", *tail[1]]

    assert route_cost(graph, route) == pytest.approx(route_cost(graph, Route(best)))
    # ...and it is the short way round, not the detour.
    assert route.segment_ids == ["r0", "r1", "r2"]


def test_a_one_way_road_makes_the_route_non_reversible() -> None:
    """The directionality property.

    While `a` is bidirectional, `c -> a` is a legal route. Marking `a` as
    one-way removes the ability to drive it backwards, so the same route
    stops existing — the path is no longer reversible.
    """
    two_way = build_network_graph(_t_junction_network(oneway_a=False))
    assert find_route(two_way, "c", "a").found, "the reverse route must exist while a is two-way"
    assert find_route(two_way, "a", "c").found

    one_way = build_network_graph(_t_junction_network(oneway_a=True))
    assert find_route(one_way, "a", "c").found, "the forward route must survive"
    assert not find_route(one_way, "c", "a").found, "the reverse route must be gone"


def test_a_one_way_road_keeps_its_own_direction() -> None:
    """A one-way road is still traversable in the direction it points."""
    graph = build_network_graph(_t_junction_network(oneway_a=True))

    route = find_route(graph, "a", "c")

    assert route.found
    assert route.segment_ids[0] == "a"


def test_no_route_is_reported_as_not_found() -> None:
    """An unreachable target is flagged, not silently faked."""
    graph = build_network_graph(_line_network(["r0", "r1"]))

    route = find_route(graph, "r1", "r0")

    # r0 can only be entered at I0, and nothing reaches I0 from r1.
    assert not route.found


def test_a_road_with_no_intersection_gets_a_placeholder_node() -> None:
    """Roads that do not touch an intersection are still in the graph."""
    network = {
        "roads": [_road("lonely", (0.0, 500.0), (100.0, 500.0))],
        "intersections": [],
        "vehicles": [],
    }
    graph = build_network_graph(network)

    assert set(graph.segments) == {"lonely"}
    assert len(graph.nodes) == 2  # one per end
    assert graph.real_intersections == []


def test_point_on_road_interpolates_along_the_polyline() -> None:
    """The helper used to place vehicles on a road is arclength-correct."""
    graph = build_network_graph(_line_network(["r0"]))
    seg = graph.segments["r0"]

    assert point_on_road(seg, 0.0) == pytest.approx((0.0, 0.0))
    assert point_on_road(seg, 50.0) == pytest.approx((50.0, 0.0))
    assert point_on_road(seg, seg.length) == pytest.approx((100.0, 0.0))


def test_roads_keep_their_declared_attributes() -> None:
    """Lane count, speed limit and the one-way flag survive the build."""
    network = _line_network(["r0"], oneway={"r0"})
    graph = build_network_graph(network)

    seg = graph.segments["r0"]
    assert seg.lane_count == 2
    assert seg.speed_limit == pytest.approx(16.67)
    assert seg.oneway is True


def test_adjacency_never_contains_the_segment_itself() -> None:
    """A road is not reachable from itself — no self-loops."""
    graph = build_network_graph(_line_network(["r0", "r1"]))

    for seg_id in graph.segments:
        assert seg_id not in graph.adjacent_segments(seg_id)


def test_all_pairs_of_roads_are_reachable_or_reported_as_such() -> None:
    """Sanity sweep: every pair either routes or says it cannot."""
    graph = build_network_graph(_line_network(["r0", "r1", "r2"]))

    for start, end in itertools.permutations(graph.segments, 2):
        route = find_route(graph, start, end)
        if route.found:
            assert route.segment_ids[0] == start
            assert route.segment_ids[-1] == end
        else:
            assert route.segment_ids == [start]
