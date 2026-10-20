// src/infrastructure/physics/RapierBodySpec.ts
//
// Per-vehicle Rapier rigid-body + collider spec, built once per
// registerVehicle call. The collider is a cuboid aligned with the
// body's local axes (no rotation needed at construction; we set
// heading via setRot at register time).

import type { VehicleType } from '@domain/entities/Vehicle'
import type { Vec3 } from './WorldConfig'
import { VEHICLE_BODY_SPEC } from '@shared/constants/simulation'

/** Rapier rigid-body + collider spec. Built once per registerVehicle
 *  call. The collider is a cuboid aligned with the body's local axes
 *  (no rotation needed at construction; we set heading via setRot). */
export interface RigidBodySpec {
  vehicleId: string
  type: VehicleType
  position: Vec3
  heading: number // radians
  mass: number
  halfExtents: Vec3 // half of (length, height, width)
}

export const buildRigidBodySpec = (
  vehicleId: string,
  type: VehicleType,
  position: Vec3,
  heading: number,
): RigidBodySpec => {
  const s = VEHICLE_BODY_SPEC[type]
  return {
    vehicleId,
    type,
    position,
    heading,
    mass: s.mass,
    halfExtents: { x: s.length / 2, y: 0.75, z: s.width / 2 },
  }
}
