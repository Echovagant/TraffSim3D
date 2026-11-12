"""Signal enrichment — putting the lights the source file dropped back.

The bundled Shenzhen extract was generated from a roads-only GeoJSON,
so its `highway=traffic_signals` nodes were never in the file: the
parsed city had 1 120 junctions and only 10 of them signalised (14
lights). `attach_traffic_signals` gives the junctions their lights back
from the signal nodes fetched over Overpass.
"""

from __future__ import annotations

from app.apps.maps.osm_parser import attach_traffic_signals


def _network() -> dict:
    """A two-road crossroads at the origin, with no lights yet."""
    return {
        "originLat": 22.5409,
        "originLon": 114.055,
        "roads": [
            {
                "id": "w-1",
                "startNode": {"x": 0.0, "y": 0.0, "z": -100.0},
                "endNode": {"x": 0.0, "y": 0.0, "z": 100.0},
                "waypoints": [
                    {"x": 0.0, "y": 0.0, "z": -100.0},
                    {"x": 0.0, "y": 0.0, "z": 100.0},
                ],
                "laneCount": 2,
                "oneway": False,
                "speedLimit": 13.9,
                "level": 0,
            },
            {
                "id": "w-2",
                "startNode": {"x": -100.0, "y": 0.0, "z": 0.0},
                "endNode": {"x": 100.0, "y": 0.0, "z": 0.0},
                "waypoints": [
                    {"x": -100.0, "y": 0.0, "z": 0.0},
                    {"x": 100.0, "y": 0.0, "z": 0.0},
                ],
                "laneCount": 2,
                "oneway": False,
                "speedLimit": 13.9,
                "level": 0,
            },
        ],
        "intersections": [
            {
                "id": "i-0",
                "position": {"x": 0.0, "y": 0.0, "z": 0.0},
                "trafficLights": [],
                "connectedRoads": ["w-1", "w-2"],
                "radius": 11.5,
                "intersectionRadius": 11.5,
            }
        ],
    }


# The origin of the network is (22.5409, 114.055); a signal node at
# the junction is that point itself.
ORIGIN = (22.5409, 114.055)


def test_attaches_lights_to_the_junction_near_a_signal_node() -> None:
    network = _network()
    lit = attach_traffic_signals(network, [ORIGIN])
    assert lit == 1
    lights = network["intersections"][0]["trafficLights"]
    # One light per axis group of the junction's approaches.
    assert len(lights) == 2
    assert {light["axis"] for light in lights} == {"ns", "ew"}
    assert all(light["phase"] in {"green", "red"} for light in lights)


def test_a_signal_far_from_every_junction_lights_nothing() -> None:
    network = _network()
    # ~1.1 km north of the origin — well past the 25 m match radius.
    lit = attach_traffic_signals(network, [(22.5509, 114.055)])
    assert lit == 0
    assert network["intersections"][0]["trafficLights"] == []


def test_attaching_twice_does_not_double_the_signals() -> None:
    network = _network()
    attach_traffic_signals(network, [ORIGIN])
    first = len(network["intersections"][0]["trafficLights"])
    attach_traffic_signals(network, [ORIGIN])
    assert len(network["intersections"][0]["trafficLights"]) == first


def test_the_light_ids_are_unique() -> None:
    network = _network()
    attach_traffic_signals(network, [ORIGIN])
    ids = [light["id"] for light in network["intersections"][0]["trafficLights"]]
    assert len(ids) == len(set(ids))


def test_no_signal_nodes_leaves_the_network_alone() -> None:
    network = _network()
    assert attach_traffic_signals(network, []) == 0
    assert network["intersections"][0]["trafficLights"] == []


# ---------------------------------------------------------------------------
# The signal-node lookup
# ---------------------------------------------------------------------------


def test_the_way_spelling_of_a_signal_finds_its_node() -> None:
    """A signal can be a node OR a way — and the way's first node is
    where the light stands.

    Finding that node used to mean scanning the whole element list
    once per way (O(ways × elements)); it is an index lookup now.
    The result must not change.
    """
    from app.api.v1.maps import _fetch_signal_nodes

    elements = [
        {"type": "node", "id": 1, "lat": 22.5, "lon": 114.0},
        {"type": "node", "id": 2, "lat": 22.6, "lon": 114.1},
        # A signal pole: a WAY whose first node is where the light is.
        {"type": "way", "id": 100, "nodes": [2, 1], "tags": {"highway": "traffic_signals"}},
    ]

    class _FakeCache:
        def __init__(self) -> None:
            self.queries: list[str] = []

        def __call__(self, query: str, **kwargs: object) -> dict:
            self.queries.append(query)
            return {"elements": elements}

    import app.apps.maps.overpass_cache as cache_module

    original = cache_module.cached_overpass_fetch
    fake = _FakeCache()
    cache_module.cached_overpass_fetch = fake  # type: ignore[assignment]
    try:
        nodes = _fetch_signal_nodes((22.4, 113.9, 22.7, 114.2))
    finally:
        cache_module.cached_overpass_fetch = original  # type: ignore[assignment]

    # The node, the node, and the way's FIRST node.
    assert nodes == [(22.5, 114.0), (22.6, 114.1), (22.6, 114.1)]
