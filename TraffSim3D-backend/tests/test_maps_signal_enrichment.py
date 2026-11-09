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
