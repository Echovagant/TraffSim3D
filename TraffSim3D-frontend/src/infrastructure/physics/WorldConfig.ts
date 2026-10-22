// src/infrastructure/physics/WorldConfig.ts
//
// World configuration for the Rapier3D physics simulation. The physics
// contract (plans/m2-interface-contract.md §2) names `Vec3` as the
// primitive world-space type; since `Position` is already the right
// shape, this module re-exports `Vec3 = Position` so consumers can
// `import type { Vec3 } from '@infrastructure/physics'` without the
// physics barrel reaching into the domain layer. The single
// source-of-truth shape lives in `src/domain/value-objects/Position.ts`.

import type { Position } from '@domain/value-objects/Position'

/** Vec3 = Position (alias). Defined here so the physics contract
 *  (plans/m2-interface-contract.md §2) can import from a
 *  physics-adjacent module without dragging in the domain. */
export type Vec3 = Position

export interface WorldConfig {
  /** Rapier solver seed. Determinism (R3) — green-wave timing
   *  depends on reproducible physics. */
  seed: number
  /** Fixed physics timestep (s). I5 mandates 1/60. */
  fixedDt: number
  /** Gravity vector. Default earth gravity. */
  gravity: Vec3
  /** Ground collider thickness (m). */
  groundThickness: number
}

export const DEFAULT_WORLD_CONFIG: WorldConfig = {
  seed: 0xdefa17,
  fixedDt: 1 / 60,
  gravity: { x: 0, y: -9.81, z: 0 },
  groundThickness: 0.1,
}
