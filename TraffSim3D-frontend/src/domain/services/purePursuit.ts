/**
 * Pure Pursuit path-following algorithm.
 *
 * Enables vehicles to steer smoothly along curve roads
 * (T-junctions, rectangular loops, ramps). Pure Pursuit computes a
 * steering angle from:
 *   - the vehicle's current pose (x, z, heading)
 *   - a lookahead point LOOKAHEAD_DISTANCE meters ahead on the lane
 *   - the vehicle's wheelbase (type-dependent)
 *
 * The steering angle drives Rapier's angular velocity via setVehicleAngularVelocity.
 *
 * Algorithm reference:
 *   Coulter, R.C. (1992). Implementation of the Pure Pursuit Path Tracking Algorithm.
 *   Carnegie Mellon University, Robotics Institute.
 */

import type { Road } from '@domain/entities/Road'
import { lanePoint } from './laneGeometry'

/** Per-vehicle-type Pure Pursuit parameters. */
export interface PurePursuitOptions {
  /** Wheelbase (m) — distance between front and rear axles.
   *  Affects turning radius: larger = wider turns. */
  wheelbase: number
  /** Lookahead distance (m) — how far ahead on the lane to aim.
   *  Larger = smoother but slower to respond. */
  lookahead: number
}

export const DEFAULT_PURE_PURSUIT: PurePursuitOptions = {
  wheelbase: 2.5,
  lookahead: 8,
}

/**
 * Convert a steering angle (radians) to an angular velocity (rad/s)
 * for Rapier. A simple proportional controller: omega = delta * GAIN.
 *
 * GAIN = 2.5 rad/s per rad of steering. At max steering (±π/4),
 * this gives ~1.96 rad/s angular velocity — a car can sweep 90°
 * in about 0.45 seconds at low speed, which is realistic.
 */
export const STEER_SPEED_GAIN = 2.5 // rad/s per radian

export const steeringAngleToOmega = (delta: number): number => {
  return delta * STEER_SPEED_GAIN
}

/**
 * Compute the Pure Pursuit steering angle for a vehicle on a lane.
 *
 * @param vehicleX   Vehicle world X
 * @param vehicleZ    Vehicle world Z
 * @param heading     Vehicle heading in radians (world-space, math convention)
 * @param road        The road the vehicle is on
 * @param laneIndex   Current lane index
 * @param s           Current arc-length along the road
 * @param opts        Pure Pursuit parameters (wheelbase, lookahead)
 * @returns           Steering angle in radians, clamped to ±π/4
 */
export const computeSteeringAngle = (
  vehicleX: number,
  vehicleZ: number,
  heading: number,
  road: Road,
  laneIndex: number,
  s: number,
  opts: PurePursuitOptions = DEFAULT_PURE_PURSUIT,
): number => {
  // 1. Lookahead point: `lookahead` meters ahead along the lane.
  //    lanePoint() clamps s to [0, roadLength] internally, so even if
  //    we overshoot the end we get a valid world position.
  const lookaheadS = s + opts.lookahead
  const lp = lanePoint(road, laneIndex, lookaheadS)

  // 2. Vector from vehicle to lookahead point
  const dx = lp.position.x - vehicleX
  const dz = lp.position.z - vehicleZ
  const ld = Math.hypot(dx, dz)

  // Degenerate: vehicle is exactly at the lookahead point
  if (ld < 1e-6) return 0

  // 3. Angle of the lookahead vector relative to world X-axis
  const lookaheadAngle = Math.atan2(dz, dx)

  // 4. Alpha: angle from vehicle heading to lookahead direction.
  //    NOTE the sign: this is `heading - lookaheadAngle`, i.e. the
  //    **negative** of the textbook Pure Pursuit alpha. That is deliberate
  //    here and must not be "corrected" to match
  //    `src/domain/services/egoKernel.ts` (the training sim's kernel, which
  //    uses the textbook `targetAngle - heading`):
  //
  //      - this controller's `delta` is handed to Rapier as an angular
  //        velocity about the **y axis**, whose sense is opposite to the
  //        (x, z) plane's `heading` convention the sim integrates;
  //      - the kernel's steer is integrated directly as `heading += steer*dt`
  //        in that same (x, z) convention.
  //
  //    So the two files compute the same-looking expression with opposite
  //    signs, and **both are correct** — in their own frame. Flipping this
  //    one would make the browser's traffic leave the lanes.
  let alpha = heading - lookaheadAngle

  // 5. Normalize to (-π, π]
  alpha = Math.atan2(Math.sin(alpha), Math.cos(alpha))

  // 6. Pure Pursuit steering law:
  //    delta = arctan(2 * L * sin(alpha) / ld)
  //    where L = wheelbase, ld = distance to lookahead
  let delta = Math.atan2(2 * opts.wheelbase * Math.sin(alpha), ld)

  // 7. Clamp to ±π/4 (45°) — physical steering rack limit
  delta = Math.max(-Math.PI / 4, Math.min(Math.PI / 4, delta))

  return delta
}
