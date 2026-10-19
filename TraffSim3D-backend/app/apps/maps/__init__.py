"""OSM parsing (XML + PBF) and Overpass cache proxy.

Implemented: `osm_parser` (.osm XML → RoadNetwork JSON), `parse_pbf`
(binary .osm.pbf via osmium), `road_graph` (node index + directed edges +
A* `shortest_path`, added 2026-10-16), `overpass_cache` (disk-cached
Overpass proxy for the smart-city view — overpass-api.de is slow/blocked
from China, responses cached under geojson/cache/).

NOT implemented (backlog, plan §4.2 M3): graph storage in PostGIS — the
in-memory graph in `road_graph` is sufficient for current scale.
"""

from .overpass_cache import (
    cached_overpass_fetch as cached_overpass_fetch,
)
from .overpass_cache import (
    list_cached_queries as list_cached_queries,
)
