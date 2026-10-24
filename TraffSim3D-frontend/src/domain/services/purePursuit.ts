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
import { lanePoint, laneForwardSign } from './laneGeometry'

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
  // 1. Lookahead point: `lookahead` meters ahead along the lane **in the
  //    lane's own travel direction**.
  //
  //    The direction matters: a lane with `laneIndex >= laneCount / 2` is
  //    travelled **backwards** (end → start, see `laneForwardSign`), so its
  //    arc length *decreases* as the vehicle drives on. Adding the lookahead
  //    unconditionally put the target point BEHIND such a vehicle, and the
  //    steering law then pulled it further off course: measured on the
  //    cross scene, a +0.1° heading error produced −1.0906e-3 rad of
  //    steering on a forward lane but **+1.0906e-3 rad — the opposite
  //    sign** — on a backward lane. A vehicle on a backward lane turned
  //    180° within 7 s, changed lane four times and ended up 4.99 m off
  //    the centreline (exactly on the 5 m lane guard).
  //
  //    `lanePoint()` clamps the arc length into `[0, roadLength]`, so the
  //    lookahead stays finite near the ends of the road. On a backward
  //    lane the clamped point (s = 0) is still *ahead* of the vehicle —
  //    the vehicle travels towards s = 0 — so the steering stays sane.
  const travelSign = laneForwardSign(laneIndex, road.laneCount)
  const lookaheadS = travelSign === 1 ? s + opts.lookahead : s - opts.lookahead
  const lp = lanePoint(road, laneIndex, lookaheadS)

  // 2. Vector from vehicle to lookahead point
  const dx = lp.position.x - vehicleX
  const dz = lp.position.z - vehicleZ
  const ld = Math.hypot(dx, dz)

  // Degenerate: vehicle is exactly at the lookahead point
  if (ld < 1e-6) return 0

  // 3. Angle of the lookahead vector relative to world X-axis
  const lookaheadAngle = Math.atan2(dz, dx)

  // 4. Alpha: the angle from the vehicle's heading to the lookahead direction.
  //    This is the **textbook** Pure Pursuit alpha (Coulter 1992):
  //    `alpha = lookaheadAngle - heading`, so `sin(alpha) > 0` means the
  //    target is ahead and to the left, and the steer turns **towards** it.
  //
  //    The steering is applied as an angular velocity about the world **+Y**
  //    axis (`RapierWorld.setVehicleAngularVelocity` → `setAngvel({y: omega})`),
  //    and the heading the simulation integrates and reports
  //    (`RapierWorld.readPose` → `atan2(2(wy+xz), 1-2(y²+x²))`) **is** that
  //    same +Y yaw. A positive omega therefore *increases* the reported
  //    heading — the same sense in which the textbook law is derived. There is
  //    no frame flip to compensate for.
  //
  //    This is the same convention as the training sim and its 1:1 TypeScript
  //    port (`src/domain/services/egoKernel.ts` → `pythonSteer`, and
  //    `sim_core.py` → `alpha = target_angle - heading`). All three use the
  //    textbook sign; keep them that way.
  //
  //    It was the other way round until 2026-10-22: this file computed
  //    `alpha = heading - lookaheadAngle` on the (incorrect) belief that the
  //    +Y angular velocity ran against the heading convention. The consequence
  //    was that the browser's traffic steered **away** from its lane and the
  //    5 m drift guard kept snapping it back. It went unnoticed because the
  //    cross-language contract only pins the *training* sim — the browser's
  //    Rapier path was never compared against it.
  let alpha = lookaheadAngle - heading

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
