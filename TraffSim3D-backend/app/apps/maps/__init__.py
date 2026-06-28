"""OSM parser, graph storage, A* planner. Landed in M3.

Plan 056 follow-up adds overpass_cache for the smart-city view's
bottleneck — overpass-api.de is slow / blocked from China, so
we cache the response in geojson/cache/ and serve from disk on
repeat requests.
"""
from .overpass_cache import (
    cached_overpass_fetch as cached_overpass_fetch,
)
from .overpass_cache import (
    list_cached_queries as list_cached_queries,
)
