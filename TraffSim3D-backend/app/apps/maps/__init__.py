"""OSM parsing (XML + PBF) and Overpass cache proxy.

Implemented: `osm_parser` (.osm XML → RoadNetwork JSON), `parse_pbf`
(binary .osm.pbf via osmium), `overpass_cache` (disk-cached Overpass
proxy for the smart-city view — overpass-api.de is slow/blocked from
China, responses cached under geojson/cache/).

NOT implemented (backlog, plan §4.2 M3): graph storage (PostGIS) and
the A*/Dijkstra path planner promised for M3 — see SPEC backlog,
run 2026-10-15-170500.
"""

from .overpass_cache import (
    cached_overpass_fetch as cached_overpass_fetch,
)
from .overpass_cache import (
    list_cached_queries as list_cached_queries,
)
