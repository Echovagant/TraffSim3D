# TraffSim3D Backend

Python FastAPI backend for the 3D traffic simulation platform. Hosts:

- **`apps/maps/`** — OSM XML → RoadNetwork parser (Plan 041)
- **`apps/rl/`** — Gymnasium env + PPO training (Plan 044)
- **`apps/simulation/`, `apps/perception/`** — scaffolded, awaiting M2/M3 work

The Vue 3 + Three.js frontend lives in `TraffSim3D-frontend/`. See
`TraffSim3D.code-workspace` to open both folders together.

---

## Quick start

```bash
# 1. Install base deps (FastAPI + dev tools)
cd TraffSim3D-backend
uv sync

# 2. Run dev server (hot reload on :8000)
uv run uvicorn app.main:app --reload --port 8000

# 3. Smoke check
curl http://localhost:8000/health
# → {"status": "ok"}
```

Python 3.12, `uv` package manager. `pyproject.toml` lists all deps.

---

## Testing

```bash
# Run all tests
uv run python -m pytest

# Lint
uv run ruff check .

# Typecheck (strict)
uv run mypy app
```

Tests use **httpx2 + ASGITransport** for in-process FastAPI testing
(no uvicorn subprocess overhead — each test runs in <100ms).

---

## GPU / CUDA support

The RL stack (stable-baselines3 + PyTorch) is gated behind an optional
`[rl]` extra to keep dev installs small.

### Default: CPU

```bash
uv sync                # CPU only, ~50MB
```

### Add real PPO training (CPU by default)

```bash
uv sync --extra rl     # + SB3 + torch CPU, ~250MB
```

### Switch to GPU (NVIDIA)

```bash
# Replace torch-cpu with torch-cu121 (RTX 30/40 series, sm86+)
uv pip uninstall torch torchvision torchaudio
uv pip install torch --index-url https://download.pytorch.org/whl/cu121

# Verify
uv run python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

**CUDA 12.1** (`cu121`) is recommended for RTX 4050 (sm89/Ada Lovelace)
and other 30/40-series cards. For older cards (RTX 20 series) use
`cu118`. **Only one torch install can coexist per environment** —
CPU ↔ GPU requires uninstall + reinstall.

### Runtime GPU detection

`GET /api/v1/rl/capabilities` returns the runtime-detected state:

```json
{
  "torch_version": "2.12.1+cu121",
  "cuda_available": true,
  "device_count": 1,
  "device_name": "NVIDIA GeForce RTX 4050",
  "vram_gb": 6.0,
  "sb3_available": true,
  "device_fallback_reason": ""
}
```

The frontend reads this on mount and disables the GPU option when
`cuda_available: false`. The trainer falls back to CPU when
`cuda_available: false` OR `vram_gb < 2.0`.

### Manual training

```bash
# Dry-run (default; no PPO, writes synthetic reward history for UI demo)
uv run python -m app.apps.rl.train 1000 --dry-run

# Real PPO on CPU
uv sync --extra rl
uv run python -m app.apps.rl.train 10000

# Real PPO on GPU (auto-selects if torch+CUDA available)
uv run python -m app.apps.rl.train 50000 --device auto

# Force CPU
uv run python -m app.apps.rl.train 10000 --device cpu
```

### Via API

```bash
# Dry-run via API (default; safe)
curl -X POST http://localhost:8000/api/v1/rl/train \
  -H "Content-Type: application/json" \
  -d '{"steps": 1000, "dry_run": true, "device": "auto"}'

# Real PPO via API (spawns subprocess, returns PID immediately)
curl -X POST http://localhost:8000/api/v1/rl/train \
  -H "Content-Type: application/json" \
  -d '{"steps": 50000, "dry_run": false, "device": "auto"}'

# Check training progress
curl http://localhost:8000/api/v1/rl/status
```

---

## Map data sources

### OpenStreetMap (default — free, no API key)

Plan 041 parses `.osm` XML files into the frontend's `RoadNetwork`
format. The OSM data is governed by the **ODbL** (Open Database License):
any UI displaying OSM-derived maps must include the attribution
**"© OpenStreetMap 贡献者"**.

**Acquisition channels**:

| Channel | Region scope | Format | Update | Use case |
|---|---|---|---|---|
| [openstreetmap.org Export](https://www.openstreetmap.org/export) | ~0.25 sq deg | .osm (XML) | Live | Quick small exports |
| [Overpass API](https://overpass-api.de/) | arbitrary bbox + tags | .osm / GeoJSON | Live | Programmatic per-condition fetch |
| [Geofabrik](https://download.geofabrik.de/asia/china.html) | Continent/country/province | .pbf / .shp | Daily~weekly | Bulk national/provincial |
| [BBBike](https://download.bbbike.org/) | 200+ cities | .pbf / .shp / .geojson | Regular | City-level, multiple formats |
| [Planet OSM](https://planet.openstreetmap.org/) | Global | .pbf (~59GB) / .xml (~106GB) | Weekly | Full-world offline DB |

For **China specifically**:
- Geofabrik: https://download.geofabrik.de/asia/china.html (daily updated)
- Recommended cities to download: Shenzhen, Beijing, Shanghai, Guangzhou

**China-specific caveats**:
- OSM coverage is **incomplete** in mainland China (mapping restrictions,
  smaller volunteer community). Urban arterial roads are usually present,
  but `lanes`, `maxspeed`, `bridge` tags are often missing.
- **Border/boundary data is unreliable** in OSM for geopolitical regions —
  do not rely on OSM admin boundaries for any boundary-sensitive use case.
- For accurate China road data, **高德 (AutoNavi / Amap) 开放平台** or
  **百度地图开放平台** are the commercial alternatives (require API key,
  ToS-restricted for commercial use). See "高德 follow-up" below.

**Coordinate systems**:
- OSM uses **WGS-84** (EPSG:4326).
- 高德 uses **GCJ-02** ("火星坐标") — offset by ~50-500m from WGS-84.
- 百度 uses **BD-09** — further offset from GCJ-02.
- **Never mix WGS-84 and GCJ-02 in the same scene** — roads will appear
  hundreds of meters off from real GPS tracks. Coordinate transformation
  libraries: `pyproj`, `coord-transform-python`.

**ODbL attribution requirement**:
> When displaying OSM-derived data (or any derivative), credit
> "© OpenStreetMap contributors" prominently. Internal use is fine
> without re-distributing, but **any published derivative database must
> also be ODbL**. See https://opendatacommons.org/licenses/odbl/.

The frontend `MapImporterView.vue` includes this attribution footer
per Plan 041's acceptance criteria.

### 高德 (Amap) — China-specific, requires API key (follow-up)

> **Status**: not yet implemented. Planned for a post-044 plan.

Workflow when implemented:
1. User registers at https://lbs.amap.com/ → creates an application → gets an API key.
2. Sets `AMAP_KEY=...` in `.env` or environment.
3. Backend calls 高德 行政区划 + 路径规划 APIs to build the road network.
4. `amap_parser.py` converts the response to `RoadNetwork` shape (same
   shape as OSM parser output).
5. The frontend adds a "地图源: OSM / 高德" selector.

**Why two parsers**: OSM is universal + free but China coverage is poor.
高德 has authoritative China data but is commercial (ToS-restricted).
The MVP supports OSM for global coverage and adds 高德 as a follow-up
for production China use.

---

## Status persistence

Training status (current step, reward history, running flag) is persisted
to a JSON file:

- Default path: `/tmp/traffic_ppo_status.json`
- Override via env: `TRAFFIC_PPO_STATUS=/path/to/status.json`
- Format:
  ```json
  {
    "running": false,
    "step": 1000,
    "episode_count": 5,
    "last_reward": 12.5,
    "reward_history": [0.1, 0.5, 1.2, ...],
    "started_at_ms": 1719374400000,
    "finished_at_ms": 1719374405000,
    "reason": "dry_run_completed"
  }
  ```

The file is written atomically (tmp + rename) to survive crashes.

---

## Project structure

```
TraffSim3D-backend/
├── app/
│   ├── main.py                # FastAPI entry
│   ├── api/v1/                # API endpoints
│   │   ├── ping.py
│   │   ├── maps.py            # POST /api/v1/maps/parse-osm
│   │   └── rl.py              # POST /api/v1/rl/train + GET /api/v1/rl/{status,capabilities}
│   ├── apps/
│   │   ├── maps/osm_parser.py # XML → RoadNetwork
│   │   └── rl/
│   │       ├── sim_core.py    # Minimal Python sim (4-way intersection)
│   │       ├── env.py         # Gymnasium wrapper
│   │       ├── status.py      # status.json I/O
│   │       └── train.py       # PPO entry point
│   ├── core/, models/, storage/  # scaffolded for M3+
├── tests/
│   ├── test_smoke.py          # health + ping
│   ├── test_osm_parser.py     # 10 unit tests for parser
│   ├── test_api_maps.py       # 3 httpx2 in-process API tests
│   ├── test_rl_sim.py         # 7 sim core unit tests
│   ├── test_rl_env.py         # 6 Gym env contract tests
│   └── test_rl_api.py         # 2 RL API tests
├── pyproject.toml
└── README.md (this file)
```

---

## Follow-ups

- **045**: Multi-agent RL, PPO long training runs, checkpoint management.
- **045+**: OSM PBF parser (`osmpbf`), 高德 amap_parser, pre-extracted city files, OSM→elevated roads end-to-end e2e.
- **046 (M5)**: Cross-language contract test (TS sim ↔ Python sim snapshot diff), production deployment (ADR-007 Docker Compose), test coverage ≥70%.