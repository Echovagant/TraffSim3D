# ADR-003: Physics Engine — Rapier (WASM)

- **Status**: Accepted
- **Date**: 2026-05-19
- **Deciders**: Project lead
- **Source**: the project's original architecture decision set (ADR-001 … ADR-009, this directory)

## Context

The simulator needs deterministic-ish rigid-body physics (vehicles,
collisions, traffic-light triggers) in the browser. The RL pipeline
(Gymnasium env on the back-end) does not need full physics — it operates
on a reduced state vector — but the front-end *viewer* does need
realistic motion for human inspection of learned policies.

## Decision

Use **Rapier (WASM)** for the front-end 3D physics. Rapier compiles to
WebAssembly and exposes a JavaScript API; we wire it through the Vue
front-end in M2.

## Consequences

- The back-end does NOT depend on Rapier; the Gymnasium env in `apps/rl`
  uses its own simplified kinematic model in M4.
- WASM bundle size is non-trivial; we will lazy-load the Rapier module
  when the SceneLab or SimulationLab view mounts.
- Determinism for RL training is preserved by running the *training*
  env on the back-end (CPU-only PyTorch) and only running Rapier for
  *visualization* / *human-in-the-loop* scenarios.

## Alternatives considered

- **Cannon.js**: pure JS, no WASM, slower for large scenes.
- **Bullet (Ammo.js)**: WASM port, but heavier and less actively
  maintained than Rapier.
- **Box2D**: 2D-only, not suitable for the 3D scene the plan calls for.
