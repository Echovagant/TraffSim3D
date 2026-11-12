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

/**
 * The body's dimensions.
 *
 * The HEIGHT is the vehicle's real height (a car 1.6 m, a bus 3.4 m),
 * not a flat 1.5 m for everybody: the boxes have to be able to say
 * "this one does not fit under that" — which is exactly what the OSM
 * `maxheight` rule asks (a 3.5 m tunnel takes a car and refuses a bus).
 *
 * The box's half-height is also what places the body: the box SITS ON
 * the road, so the body's centre is the road level plus this half
 * (see `RapierWorld.registerVehicle`).
 */
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
    halfExtents: { x: s.length / 2, y: s.height / 2, z: s.width / 2 },
  }
}
