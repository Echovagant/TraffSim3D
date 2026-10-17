# ADR-007: Deployment — Containerization

- **Status**: ❌ **Rejected** (2026-10-17)
- **Date**: 2026-06-22（提议） / 2026-10-17（裁定）
- **Deciders**: Project lead
- **Source**: the project's original architecture decision set (ADR-001 … ADR-009, this directory)
- **Supersedes**: the 2026-06-22 proposal to adopt Docker Compose

## Context

The plan calls for `Docker + Docker Compose` deployment. As of 2026-06-22 this
was **Proposed** and never finalized; four open questions remained (compose
file shape, base image, whether to bundle Postgres/Redis/MinIO, build context).

Two things were blocking dependent work:

1. M4's §4.2 Must item「模型权重存取（MinIO）」needs a deployment form to
   decide the *object-storage shape* of weight persistence.
2. M4's acceptance criterion「权重可跨**容器重建**保留（需挂卷）」requires
   containers to exist at all.

Meanwhile the project's actual pain was never "no containers" — it was
**weights disappearing on restart**, and that was solved on 2026-10-16 by
`apps/rl/paths.py`, which anchors all RL runtime paths under
`TraffSim3D-backend/.data/` instead of the previous `/tmp` default. That change
also fixed a worse latent defect: on Windows `Path('/tmp/x').is_absolute()` is
`False`, so checkpoints silently split across drive letters.

## Decision

**Do not adopt Docker Compose.** Deployment is local-process based:

| Layer | Mechanism |
|---|---|
| Back-end | uv-managed venv (`uv sync --extra dev`), `uvicorn app.main:app` |
| Front-end | Vite dev server (`npm run dev`) / `npm run build` + static host |
| RL runtime state | `TraffSim3D-backend/.data/` (gitignored), overridable via `TRAFFIC_RL_DATA_DIR` |

No `Dockerfile`, no compose file, no container volumes.

## Consequences

- **M4「模型权重存取」项改判。** The MinIO requirement is formally
  re-scoped to *persistent local filesystem storage*. The real requirement —
  "weights must not be lost on same-machine restart" — **is met** and
  verified. If object storage is ever needed, it should be added as an
  adapter behind `apps/rl/paths.py`, not as a deployment-form prerequisite.
- **M4 验收第 5 条作废。**「权重可跨容器重建保留（需挂卷）」is **out of scope
  under this ADR**, not failed. It is removed from the acceptance list rather
  than left perpetually unchecked.
- **M5 的 ADR finalization 项收口.** ADR-001~007 are now all resolved
  (001-006 Accepted, 007 Rejected).
- MinIO / Postgres / Redis / object storage are **not** introduced. Any future
  need requires a new ADR that supersedes this one.
- Deployment documentation (still M5 TODO) must describe the local-process
  procedure instead of a compose workflow.

## Alternatives considered

- **Docker Compose（2026-06 的原提议）** — rejected. Its only concrete benefit
  for this project was weight persistence, which the local `.data/` path
  already solves with far less machinery. The cost (per-service Dockerfiles,
  image builds, a second environment to debug) buys nothing the project needs
  at its current scale.
- **Kubernetes** — rejected as overkill, unchanged.
- **MinIO as a compose service** — rejected as a consequence of this ADR: it
  requires a resident server deployment, and the `minio` pip package is only a
  client SDK.

## Last reviewed

- 2026-06-25: Postponed to M5 (M3/M4 backend work was local-venv driven).
- **2026-10-17: Rejected.** Project lead ruled "不用容器". RL weight
  persistence had already been solved on local FS (`apps/rl/paths.py`), which
  removed the only concrete dependency this ADR had.
