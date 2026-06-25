# ADR-007: Deployment — Docker Compose

- **Status**: Proposed
- **Date**: 2026-06-22
- **Deciders**: Project lead
- **Source**: the project's original architecture decision set (ADR-001 … ADR-009, this directory)

## Context

The plan calls for `Docker + Docker Compose` deployment for the front-end
and back-end. The exact compose-file shape (dev vs prod split, base image
choice, whether to bundle Postgres/Redis/MinIO in compose or assume external
services) is not yet decided.

## Decision

Adopt **Docker Compose** as the deployment vehicle, subject to the open
questions below. No compose file is committed in M1.

## Consequences

- The `infrastructure/api/` and `infrastructure/persistence/` work in the
  front-end is staged to land alongside the first compose file in a later
  plan, not M1.
- A `Dockerfile` per sub-project will be added when this ADR graduates to
  `Accepted`.

## Open questions

- One compose file for dev + prod, or two?
- Which Python base image (python:3.12-slim vs distroless)?
- Bundle Postgres / Redis / MinIO in compose, or assume external services
  via `.env`?
- Build context: monorepo root with per-service sub-paths, or each
  sub-project self-contained?

## Alternatives considered

- **Single-host deploy without containers** — viable for M5 but loses
  parity with the rest of the team's workflow.
- **Kubernetes** — overkill at this stage.

## Last reviewed

- 2026-06-25: Postponed to M5. Reason: M3/M4 backend work is local-venv
  driven; no CI yet. Plan 044 (CI/CD pipeline, planned) will revisit this
  ADR alongside the first compose file write.
