"""Cached Overpass fetcher.

The smart-city view calls Overpass directly from the
browser. Two problems:
  1. overpass-api.de is slow / blocked from China — the user sees
     the "正在从 Overpass 加载 OSM 数据..." toast stay forever.
  2. Every page reload re-fetches the same bbox from Overpass.

This module adds a backend-cached fetch path: the FastAPI process
fetches Overpass once, stores the response as
`geojson/cache/<hash>.json`, and serves subsequent requests from
disk. Cache misses fall through to Overpass and write through.

Cache key is a hash of the Overpass query string. Same bbox +
overpass query template = same hash. We do NOT cache the parsed
RoadNetwork — that's much larger and harder to invalidate.

The cache is intentionally simple (no TTL, no LRU). A research
project doesn't need hot-cache eviction; we invalidate by deleting
`geojson/cache/` if the OSM data for a region changes.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import httpx2 as httpx  # project uses the httpx2 fork (starlette 1.3+ TestClient)

# Cached responses land here. .gitignored so a 1MB cache directory
# doesn't pollute the repo.
CACHE_DIR = Path(__file__).resolve().parents[3] / "geojson" / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_TIMEOUT_S = 30.0


def _cache_key(query: str) -> str:
    """Stable hash of the query string. 16 hex chars is plenty
    for a research cache (collision risk is ~1 in 2^64)."""
    return hashlib.sha256(query.encode("utf-8")).hexdigest()[:16]


def cached_overpass_fetch(query: str) -> dict[str, Any]:
    """Fetch Overpass with a disk cache.

    Returns the raw Overpass JSON dict (`{ version, elements }`).
    Writes to `geojson/cache/<hash>.json` on cache miss so the
    next call is instant.

    Note: OSM data is CC-BY-SA licensed; caching is fine but the
    ODbL attribution footer in the UI must remain visible (see
    `MapImporterView.vue`).
    """
    key = _cache_key(query)
    cache_path = CACHE_DIR / f"{key}.json"

    if cache_path.exists():
        return dict(json.loads(cache_path.read_text(encoding="utf-8")))

    # Cache miss — hit Overpass.
    body = {"data": query}
    with httpx.Client(timeout=OVERPASS_TIMEOUT_S) as client:
        r = client.post(OVERPASS_URL, data=body)
        r.raise_for_status()
        data = r.json()

    # Write through. Use atomic write so a partial file never
    # replaces a valid cache entry.
    tmp = cache_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    tmp.replace(cache_path)
    return dict(data)  # narrow `Any` -> dict[str, Any] for mypy


def list_cached_queries() -> list[dict[str, Any]]:
    """List cached Overpass responses for the dev UI / debug."""
    out = []
    for p in sorted(CACHE_DIR.glob("*.json")):
        stat = p.stat()
        out.append(
            {
                "key": p.stem,
                "size_kb": round(stat.st_size / 1024, 1),
                "modified_ms": int(stat.st_mtime * 1000),
            }
        )
    return out
