# Overpass response cache (backend proxy)

User-reported follow-up: `/smart-city` called
overpass-api.de directly from the browser. This had two problems:
  1. **Slow / blocked on some networks** — the user's network couldn't
     reach overpass-api.de, so the "正在从 Overpass 加载 OSM
     数据..." toast stayed forever.
  2. **No caching** — every page reload re-fetched the same bbox
     (e.g. a ±2 km box around a city centre) from Overpass.

## Fix

Frontend (`loadOSMScene.ts`) now hits our backend
`GET /api/v1/maps/overpass?data=<query>`. The backend:

1. SHA-256 hashes the query → `geojson/cache/<hash>.json`
2. **Cache hit**: serve from disk (no Overpass call)
3. **Cache miss**: POST to overpass-api.de, write JSON to disk,
   return to client

The cache directory `TraffSim3D-backend/geojson/cache/` is
gitignored. User can `rm -rf` it to force a refresh from Overpass
(e.g. when local OSM data has been updated for the area).

## Endpoint

```
GET /api/v1/maps/overpass?data=<query>
  → 200 { ...raw Overpass JSON { version, elements, ... }... }
  → 502 if Overpass fetch fails
```

Plus a debug listing:

```
GET /api/v1/maps/overpass/cache
  → 200 { cached: [{ key, size_kb, modified_ms }, ...] }
```

## Test results

- Backend suite: **738 collected** (735 passed, 3 skipped), including the three
  cache tests:
  - `test_cache_miss_then_hit` — first call hits Overpass + writes
    cache; second call reads disk without HTTP
  - `test_different_queries_get_different_cache_keys` — no cross-talk
  - `test_atomic_write` — write-through tmp file → atomic replace
- Frontend unit suite: **941 passed** (78 files)
- Frontend e2e suite: **44 tests — 43 passed, 1 skipped** (the real-PPO
  spec is opt-in; it starts a real training run, so it is skipped unless
  `npm run test:e2e:real` sets `E2E_REAL_TRAINING=1`)

Measured on 2026-10-23.

## Cache invalidation

We use **content-addressed keys** (SHA-256 of query string), so:
- Same bbox + same query template → same hash → cache hit
- Slight query edit → different hash → new entry, old stays

The user controls invalidation by deleting `geojson/cache/*.json`.
For a project with manually curated scenes, this is the right
default — no surprise eviction. A later change can add LRU if memory pressure
becomes an issue.

## ODbL attribution

OSM data is © OpenStreetMap contributors under ODbL. Caching is
permissive under ODbL, but the UI must continue to display the
attribution footer (already present in `MapImporterView.vue`).
