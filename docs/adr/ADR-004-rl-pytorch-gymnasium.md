# ADR-004: RL Framework — PyTorch + Gymnasium

- **Status**: Accepted
- **Date**: 2026-05-19
- **Deciders**: Project lead
- **Source**: the project's original architecture decision set (ADR-001 … ADR-009, this directory)

## Context

The platform's eventual goal is multi-agent RL for traffic control and
driving. We need a stable, mature, well-tooled RL stack. PyTorch is the
de-facto research framework; Gymnasium is the maintained fork of OpenAI
Gym with broader environment support and active development.

## Decision

Use **PyTorch (>=2.x) + Gymnasium (>=0.29) + Stable-Baselines3** for RL.
Algorithms of interest: PPO, SAC, DQN; multi-agent via independent
learners or MAPPO in M4.

## Consequences

- PyTorch is **not pinned in M1** to avoid forcing a 2 GB+ install
  before it's needed. The pin lands in M4 alongside the `tool.uv.sources`
  block selecting the right PyTorch index (CPU or CUDA).
- Domain entities in `src/domain/` (frontend) and `app/models/`
  (backend) must be **pure and serializable** — the Gymnasium env
  consumes them as observation / action spaces. Three.js types and
  DOM objects must NOT leak into `domain/`.
- The Gymnasium env wraps the back-end's reduced kinematic model
  (see ADR-003) — it does NOT call into the front-end Rapier runtime.

## Alternatives considered

- **TensorFlow + TF-Agents**: TF-Agents has been less actively
  maintained; PyTorch dominates the RL research community.
- **JAX + Acme**: higher performance ceiling, but the team's PyTorch
  fluency and ecosystem tooling tip the balance toward PyTorch.
- **Ray RLlib**: appealing for distributed training, but the project
  is single-developer in M1–M4; we can swap in RLlib later without
  rewriting the env.
