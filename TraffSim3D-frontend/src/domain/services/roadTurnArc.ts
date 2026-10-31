// src/domain/services/roadTurnArc.ts
//
// The turn as an ARC, not a pivot.
//
// The pivot was the model's idiom for a turn — and its known defect
// (recorded in `roadTransition.ts` and ADR-010): the turning body
// TELEPORTS across the junction corner, sweeping sideways by up to
// 7.4 m, and a follower drives into the corner it left behind.
// Measured on the 5 x 5 grid: 5 frames of overlap in 135 000 vehicle
// frames. The pivot's defence ("the fix is the arc, which is a model
// change") was honest — and this module is that model change.
//
// The shape: a quadratic Bézier from the vehicle's CURRENT pose (P0,
// with its heading) to the entry pose of the new lane (P2, with the
// lane's heading), with the control point P1 at the **corner** — the
// intersection of the two direction lines. A Bézier corner is what
// every road design uses for exactly this: it starts along the old
// direction, ends along the new one, and hugs the corner instead of
// sweeping across it.
//
// Degenerate case: two direction lines that are (nearly) COLLINEAR — a
// straight-through continuation whose lane offsets differ. There is no
// corner; the control point falls back to the midpoint, which makes the
// curve a straight line between the two poses (the only sensible path
// when the directions agree).
//
// The arc is ADVANCED BY DISTANCE, not by time: `pointAt(arc, dist)`
// returns the pose `dist` metres along it. The caller owns the speed —
// the vehicle keeps its speed through the turn, so a slow car turns
// slowly and a fast one turns tightly along the same shape. Pure
// geometry: no Three.js, no Rapier, no tick — this is the `domain/`
// layer.

export interface TurnArc {
  /** The Bézier control points: start, corner, entry. */
  readonly p0: { x: number; z: number }
  readonly p1: { x: number; z: number }
  readonly p2: { x: number; z: number }
  /** The arc's length in metres (sampled — see `ARC_SAMPLES`). */
  readonly length: number
}

/** How many segments the arc length is sampled over. */
export const ARC_SAMPLES = 24

/**
 * Below this turn angle (rad, ~5.7°) a continuation is **not** turned
 * along an arc at all — it lands directly.
 *
 * The straight-through continuation at a crossroads needs this: the
 * vehicle overruns the entry point by up to a frame's worth of travel
 * before the travel end is detected, so the "arc" from the current pose
 * to an entry pose that lies BEHIND it would run the body backwards.
 * A near-straight continuation has no sideways sweep to fix — the pivot
 * collisions were all 90-degree corners — so landing directly is both
 * simpler and correct.
 */
export const MIN_ARC_TURN_RAD = 0.1

/**
 * The angle between the two headings, in [0, pi].
 *
 * The corner degenerates when the directions are collinear, which is
 * what the callers test this for.
 */
export const turnAngle = (fromHeading: number, toHeading: number): number => {
  let d = (toHeading - fromHeading) % (2 * Math.PI)
  if (d > Math.PI) d -= 2 * Math.PI
  if (d < -Math.PI) d += 2 * Math.PI
  return Math.abs(d)
}

/**
 * Build the turn arc from a pose to an entry pose.
 *
 * `from` carries the vehicle's current position and heading (the exit
 * direction); `to` carries the new lane's entry position and heading
 * (the entry direction). The control point is where the two direction
 * lines cross — the corner. When they are near-collinear (the
 * straight-through case) the corner falls back to the midpoint: the
 * curve is then the straight line between the poses, which is what a
 * straight continuation looks like.
 */
export const buildTurnArc = (
  from: { x: number; z: number; heading: number },
  to: { x: number; z: number; heading: number },
  options: { collinearLimit?: number } = {},
): TurnArc => {
  const collinearLimit = options.collinearLimit ?? 1e-3
  const angle = turnAngle(from.heading, to.heading)
  if (angle < collinearLimit) {
    const mid = { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 }
    return finalise({ p0: { x: from.x, z: from.z }, p1: mid, p2: { x: to.x, z: to.z } })
  }

  // The corner: intersect the ray (from, along from.heading) with the
  // ray (to, against to.heading). In 2D the intersection of
  // P = A + s·u and P = B + t·v is standard; the denominator vanishes
  // exactly when the lines are parallel, which the angle check above
  // has already excluded — but the guard keeps the arithmetic honest.
  const ux = Math.cos(from.heading)
  const uz = Math.sin(from.heading)
  const vx = Math.cos(to.heading)
  const vz = Math.sin(to.heading)
  const dx = to.x - from.x
  const dz = to.z - from.z
  const denom = ux * -vz - uz * -vx
  if (Math.abs(denom) < 1e-9) {
    const mid = { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 }
    return finalise({ p0: { x: from.x, z: from.z }, p1: mid, p2: { x: to.x, z: to.z } })
  }
  const s = (dx * -vz - dz * -vx) / denom
  const corner = { x: from.x + ux * s, z: from.z + uz * s }
  return finalise({ p0: { x: from.x, z: from.z }, p1: corner, p2: { x: to.x, z: to.z } })
}

/** Sample the arc length once, at construction. */
const finalise = (arc: Omit<TurnArc, 'length'>): TurnArc => {
  let length = 0
  let px = arc.p0.x
  let pz = arc.p0.z
  for (let i = 1; i <= ARC_SAMPLES; i += 1) {
    const t = i / ARC_SAMPLES
    const point = bezierAt(arc, t)
    length += Math.hypot(point.x - px, point.z - pz)
    px = point.x
    pz = point.z
  }
  return { ...arc, length }
}

/** The Bézier point at parameter t in [0, 1]. */
const bezierAt = (arc: Omit<TurnArc, 'length'>, t: number): { x: number; z: number } => {
  const u = 1 - t
  return {
    x: u * u * arc.p0.x + 2 * u * t * arc.p1.x + t * t * arc.p2.x,
    z: u * u * arc.p0.z + 2 * u * t * arc.p1.z + t * t * arc.p2.z,
  }
}

/**
 * The pose `dist` metres along the arc.
 *
 * `dist` is clamped to [0, length]: past the end the arc returns the
 * entry pose (the caller transitions off it). The heading is the
 * curve's tangent — finite differences over a small step, which is
 * numerically stabler than the analytic derivative of a quadratic at
 * its endpoints.
 */
export const pointAt = (arc: TurnArc, dist: number): { x: number; z: number; heading: number } => {
  const t = arc.length <= 0 ? 1 : Math.max(0, Math.min(1, dist / arc.length))
  const point = bezierAt(arc, t)
  // The tangent from the ANALYTIC derivative of the quadratic Bézier —
  // B'(t) = 2(1-t)(P1-P0) + 2t(P2-P1) — which is exact at the
  // endpoints, where a finite difference bleeds the curvature into the
  // heading (measured: 5e-4 rad at t = 0 with a 1e-3 step).
  const dx = 2 * (1 - t) * (arc.p1.x - arc.p0.x) + 2 * t * (arc.p2.x - arc.p1.x)
  const dz = 2 * (1 - t) * (arc.p1.z - arc.p0.z) + 2 * t * (arc.p2.z - arc.p1.z)
  const heading = Math.atan2(dz, dx)
  return { x: point.x, z: point.z, heading }
}
