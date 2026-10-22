# ADR-002: Backend Framework — Python FastAPI

- **Status**: Accepted
- **Date**: 2026-05-19
- **Deciders**: Project lead
- **Source**: the project's original architecture decision set (ADR-001 … ADR-009, this directory)

## Context

The platform needs a Python back-end that exposes the RL engine, simulation
step, and map data to the front-end. FastAPI gives us type-checked Pydantic
models, async request handling, and an OpenAPI surface for free. The team has
prior FastAPI experience; `uv` is the package manager of choice.

## Decision

Adopt **Python 3.12 + FastAPI + Pydantic v2 + Uvicorn** as the back-end stack.
Manage dependencies with `uv`; build target is `hatchling`. PyTorch is
intentionally NOT pinned initially — added when the RL engine lands.

## Consequences

- The back-end lives under `TraffSim3D-backend/` with a DDD-style package
  skeleton: `app/` (entry), `app/apps/{rl,simulation,maps,perception}/`,
  `app/api/v1/`, `app/core/`, `app/models/`, `app/storage/`.
- HTTP smoke endpoints (`/health`, `/api/v1/ping`) land first, to validate
  the front-end / back-end wiring before any domain code is written.
- PyTorch wheels may not yet support Python 3.14 at the time of writing — pin
  `requires-python = ">=3.12,<3.14"` and use `uv` to fetch 3.12 if missing.

## Alternatives considered

- **Django + DRF**: heavier admin surface we don't need; ORM lock-in.
- **Flask**: too thin for typed Pydantic models; less ergonomic for async.
- **Node.js (Express / Fastify)**: would let us share TypeScript types with
  the front-end, but PyTorch + Gymnasium integration is the dominant
  constraint and Python is the better fit.
