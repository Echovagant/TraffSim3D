// The steering angle the car is **actually holding** — the number the
// cockpit's wheel should show.
//
// Two regimes, both geometry rather than taste:
//
//   1. On a lane: the same Pure Pursuit law `tick.ts` applies
//      (`computeSteeringAngle`). Reused, not re-derived — a HUD that
//      recomputes its own version of the physics drifts away from it.
//   2. Mid-turn through a junction: the heading is the arc's tangent,
//      so the wheel follows the arc's **curvature**, δ = atan(L · κ).
//      The curvature is measured from the tangent's heading change per
//      metre, which keeps the sign in the same convention as (1).
//
// Sign convention — and it is the simulation's, not the screen's:
// **positive is a left turn** (a positive angular velocity about world
// +Y, which is what increases the reported heading; see the long note in
// `purePursuit.ts`). The gauge flips it exactly once, for the screen.
import type { Vehicle } from '@domain/entities/Vehicle'
import type { Road } from '@domain/entities/Road'
import { computeSteeringAngle } from '@domain/services/purePursuit'
import { VEHICLE_PURE_PURSUIT } from '@shared/constants/simulation'

/**
 * A real car's front wheels lock at roughly 35°. Used as the gauge's
 * full-deflection angle: beyond this the icon stays at the stop,
 * because that is what the car in front of you would do.
 */
export const MAX_ROAD_WHEEL_DEG = 35

type Turn = NonNullable<Vehicle['turn']>

/** Heading of the arc's tangent at parameter `t` (0 = start, 1 = entry). */
const arcHeading = (turn: Turn, t: number): number => {
  const u = Math.min(1, Math.max(0, t))
  const dx = 2 * (1 - u) * (turn.p1x - turn.p0x) + 2 * u * (turn.p2x - turn.p1x)
  const dz = 2 * (1 - u) * (turn.p1z - turn.p0z) + 2 * u * (turn.p2z - turn.p1z)
  return Math.atan2(dz, dx)
}

/**
 * Road-wheel angle in the middle of a junction turn.
 *
 * κ is taken as Δheading / Δarc, which is the definition of curvature
 * for a plane curve and stays correct for a quadratic Bézier (where the
 * closed-form κ would need the second derivative and an extra sign
 * argument). Sampling ±2 % of the arc also keeps it finite where the
 * tangent is ill-conditioned (a cusp at the ends of the arc).
 */
export const turnSteeringAngle = (turn: Turn, wheelbaseM: number): number => {
  if (turn.length < 1e-6) return 0
  const t = Math.min(1, Math.max(0, turn.dist / turn.length))
  const eps = 0.02
  const t1 = Math.max(0, t - eps)
  const t2 = Math.min(1, t + eps)
  const arc = (t2 - t1) * turn.length
  if (arc < 1e-6) return 0
  const dh = Math.atan2(
    Math.sin(arcHeading(turn, t2) - arcHeading(turn, t1)),
    Math.cos(arcHeading(turn, t2) - arcHeading(turn, t1)),
  )
  return Math.atan(wheelbaseM * (dh / arc))
}

/**
 * The angle applied to this vehicle right now.
 *
 * Mirrors `tick.ts` exactly, including its two guards — mid-turn the arc
 * owns the heading, and below 0.5 m/s no angular velocity is set at all
 * (see the comment there: steering a stationary body spins it in place).
 * A HUD that ignored those guards would show a wheel doing something the
 * car is not doing.
 */
export const vehicleSteeringAngle = (v: Vehicle, road: Road): number => {
  const opts = VEHICLE_PURE_PURSUIT[v.type]
  if (v.turn) return turnSteeringAngle(v.turn, opts.wheelbase)
  if (v.speed < 0.5) return 0
  // A lane change aims at the **target** lane, exactly as tick does.
  const lane = v.desiredLaneIndex ?? v.laneIndex
  return computeSteeringAngle(v.position.x, v.position.z, v.heading, road, lane, v.s, opts)
}
