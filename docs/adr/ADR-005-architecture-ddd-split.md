# ADR-005: Project Architecture — DDD + Front/Back Split

- **Status**: Accepted
- **Date**: 2026-05-19
- **Deciders**: Project lead
- **Source**: the project's original architecture decision set (ADR-001 … ADR-009, this directory)

## Context

TraffSim3D spans a Vue3 front-end (scene editing, 3D viewer, RL
dashboards) and a Python back-end (simulation step, RL training, map
data). The two evolve at different rates and have different runtime
constraints. Naively sharing types via a `common/` directory is a
common failure mode — it grows into a junk drawer.

## Decision

Adopt a **two-sibling repository layout** (`TraffSim3D-frontend/` and
`TraffSim3D-backend/`) with **DDD layering inside each**:

- **Front-end** (under `src/`):
  - `domain/` — entities, value-objects, events (pure TS, no DOM/Three)
  - `application/` — services, use-cases
  - `infrastructure/` — rendering (Three.js), physics (Rapier), api, persistence
  - `interfaces/` — views, components, composables, Pinia stores
  - `shared/` — generic utilities (no domain knowledge)
- **Back-end** (under `app/`):
  - `apps/{rl,simulation,maps,perception}/` — one package per capability
  - `api/v1/` — FastAPI surface
  - `core/`, `models/`, `storage/` — shared infrastructure

The two siblings communicate via the FastAPI HTTP surface; types are
**re-declared** in each language (not shared across the network
boundary) — the API contract is the OpenAPI schema, not a shared
`types.ts` file.

## Consequences

- The first P0 action for the front-end is to restructure the flat
  Vue template into the four DDD layers; new feature code lands on
  top of the layered structure, not on top of the flat scaffold.
- The back-end's `app/apps/*` packages stay as empty skeletons
  (one-line docstrings only) and fill in as each capability lands.
- Storage stack (PostgreSQL + PostGIS, Redis, MinIO) is **only**
  introduced when the capability that needs it starts (map data, RL).
- ADR-001 through ADR-006 must be re-confirmed at the next architecture boundary;
  any deviation (e.g. swapping Pinia for a different store, or
  dropping DDD) requires a new ADR that supersedes the current one.

## Alternatives considered

- **Monorepo with shared types**: tempting, but creates coupling
  we explicitly want to avoid; the API surface *is* the contract.
- **Single full-stack framework (Next.js, Nuxt)**: would collapse
  the back-end's Python + PyTorch story; the RL engine is a
  first-class citizen, not a sidecar.
- **Microservices**: premature; we have one team and one product.
