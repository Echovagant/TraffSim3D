# ADR-001: Frontend Framework — Vue 3 + TypeScript

- **Status**: Accepted
- **Date**: 2026-05-19
- **Deciders**: Project lead
- **Source**: the project's original architecture decision set (ADR-001 … ADR-009, this directory)

## Context

The platform needs a 3D-capable front-end with strong TypeScript support and
a mature ecosystem for state management, routing, and 3D rendering. The
existing project scaffold is Vue 3 + Vite.

## Decision

Adopt **Vue 3 + TypeScript** as the front-end framework. Keep the existing
Vite scaffold. Use Pinia for state, Vue Router 4 for routing, Three.js for 3D.

## Consequences

- The DDD-layered `interfaces/` layer (views, components, composables, stores)
  is implemented in Vue 3 SFC + composables.
- TypeScript is the source of truth for domain models in `src/domain/`.
- Three.js postprocessing is already integrated for bloom / vignette /
  chromatic-aberration effects.

## Alternatives considered

- **React + Three.js (react-three-fiber)**: larger ecosystem but breaks the
  existing scaffold and the team's Vue experience.
- **Svelte + Threlte**: smaller bundle but thinner ecosystem for the RL
  dashboards we plan to build.
