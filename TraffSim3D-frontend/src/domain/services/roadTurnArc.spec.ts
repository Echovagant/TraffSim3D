// The turn arc's geometry — the pure half of the pivot→arc model change.
//
// What is pinned here:
//   1. the arc STARTS at the vehicle's pose, moving along its heading;
//   2. it ENDS at the entry pose, moving along the lane's heading;
//   3. it HUGES the corner — the curve stays on the junction side, so
//      the body cannot sweep across the corner the way the pivot did;
//   4. the length is honest (the chord is a lower bound, the control
//      polygon an upper one);
//   5. the collinear case degenerates to a straight line.

import { describe, it, expect } from 'vitest'
import { buildTurnArc, pointAt, turnAngle, turnSpeedLimit } from './roadTurnArc'

describe('buildTurnArc', () => {
  it('starts at the vehicle pose along its heading', () => {
    const arc = buildTurnArc({ x: -14, z: 0, heading: 0 }, { x: 0, z: -14, heading: -Math.PI / 2 })
    const start = pointAt(arc, 0)
    expect(start.x).toBeCloseTo(-14, 9)
    expect(start.z).toBeCloseTo(0, 9)
    expect(start.heading).toBeCloseTo(0, 6)
  })

  it('ends at the entry pose along the lane heading', () => {
    const arc = buildTurnArc({ x: -14, z: 0, heading: 0 }, { x: 0, z: -14, heading: -Math.PI / 2 })
    const end = pointAt(arc, arc.length)
    expect(end.x).toBeCloseTo(0, 9)
    expect(end.z).toBeCloseTo(-14, 9)
    expect(end.heading).toBeCloseTo(-Math.PI / 2, 6)
  })

  it('hugs the corner instead of sweeping across it', () => {
    // A right-angle turn whose poses sit 14 m from the junction centre
    // (the corner the pivot used to sweep across, sideways by up to
    // 7.4 m). The arc's points must stay on the near side: no point may
    // cross into the far quadrant.
    const arc = buildTurnArc(
      { x: -14, z: 5.25, heading: 0 },
      { x: -5.25, z: -14, heading: -Math.PI / 2 },
    )
    for (let i = 0; i <= 24; i += 1) {
      const p = pointAt(arc, (i / 24) * arc.length)
      // The far quadrant for this turn is x > 0 AND z > 0 — the arc
      // must never enter it.
      expect(p.x, `point ${i} crossed the far quadrant`).toBeLessThanOrEqual(0.5)
    }
  })

  it('has an honest length between chord and control polygon', () => {
    const arc = buildTurnArc({ x: -14, z: 0, heading: 0 }, { x: 0, z: -14, heading: -Math.PI / 2 })
    const chord = Math.hypot(14, 14)
    const polygon =
      Math.hypot(arc.p1.x - arc.p0.x, arc.p1.z - arc.p0.z) +
      Math.hypot(arc.p2.x - arc.p1.x, arc.p2.z - arc.p1.z)
    expect(arc.length).toBeGreaterThan(chord)
    expect(arc.length).toBeLessThan(polygon)
  })

  it('degenerates to a straight line for collinear directions', () => {
    const arc = buildTurnArc({ x: -14, z: 0, heading: 0 }, { x: 14, z: 0, heading: 0 })
    const mid = pointAt(arc, arc.length / 2)
    // Midpoint on the straight line between the poses.
    expect(mid.x).toBeCloseTo(0, 6)
    expect(mid.z).toBeCloseTo(0, 6)
    expect(mid.heading).toBeCloseTo(0, 6)
  })

  it('falls back to an approach control point when the corner is behind the exit ray', () => {
    // Measured 2026-11-05 on the rectangular loop: an inner-lane right
    // turn whose exit pose sat past the lane crossing produced a corner
    // parameter of −0.7 — the Bézier swept the vehicle BACKWARDS along
    // its own lane and the post-arc lane re-derivation flipped it onto
    // the oncoming lane (the corner ping-pong). The control point must
    // then come from the approach ray, so the arrival tangent stays the
    // entry heading and the curve never doubles back.
    const from = { x: -61.2, z: -58.25, heading: Math.PI }
    const to = { x: -58.25, z: -60, heading: Math.PI / 2 }
    const arc = buildTurnArc(from, to)
    // The control point is BEFORE the entry along its approach (south of
    // it here), never north of it — north would arrive heading SOUTH.
    expect(arc.p1.z).toBeLessThan(arc.p2.z)
    // The arrival tangent is the entry heading: p1 → p2 is exactly the
    // entry direction.
    const dx = arc.p2.x - arc.p1.x
    const dz = arc.p2.z - arc.p1.z
    expect(Math.atan2(dz, dx)).toBeCloseTo(to.heading, 9)
    // And the arc still starts along the exit heading.
    const start = pointAt(arc, 0)
    expect(start.x).toBeCloseTo(from.x, 9)
    expect(start.z).toBeCloseTo(from.z, 9)
  })

  it('clamps the distance past the ends', () => {
    const arc = buildTurnArc({ x: -14, z: 0, heading: 0 }, { x: 0, z: -14, heading: -Math.PI / 2 })
    const before = pointAt(arc, -5)
    const after = pointAt(arc, arc.length + 5)
    const start = pointAt(arc, 0)
    const end = pointAt(arc, arc.length)
    expect(before.x).toBeCloseTo(start.x, 9)
    expect(after.x).toBeCloseTo(end.x, 9)
    expect(after.z).toBeCloseTo(end.z, 9)
  })

  it('measures the turn angle as the absolute signed difference', () => {
    expect(turnAngle(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12)
    expect(turnAngle(0, -Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12)
    expect(turnAngle(0.1, 0.1)).toBeCloseTo(0, 12)
    // A heading difference that wraps.
    expect(turnAngle(3, -3)).toBeCloseTo(2 * Math.PI - 6, 12)
  })
})

describe('turnSpeedLimit', () => {
  it('a right-angle corner comes out at a city-corner speed', () => {
    const arc = buildTurnArc({ x: -14, z: 0, heading: 0 }, { x: 0, z: -14, heading: -Math.PI / 2 })
    const limit = turnSpeedLimit(arc)
    // R = length / (pi/2); v = sqrt(2.5 * R). For this corner the arc is
    // ~20 m → R ~12.7 → v ~5.6 m/s (20 km/h) — not 16.67.
    expect(limit).toBeGreaterThan(4)
    expect(limit).toBeLessThan(7)
  })

  it('a straight (collinear) arc has no limit', () => {
    const arc = buildTurnArc({ x: -14, z: 0, heading: 0 }, { x: 14, z: 0, heading: 0 })
    expect(turnSpeedLimit(arc)).toBe(Number.POSITIVE_INFINITY)
  })

  it('a shallower corner is faster than a tight one', () => {
    const tight = buildTurnArc({ x: -8, z: 0, heading: 0 }, { x: 0, z: -8, heading: -Math.PI / 2 })
    const wide = buildTurnArc({ x: -20, z: 0, heading: 0 }, { x: 0, z: -20, heading: -Math.PI / 2 })
    expect(turnSpeedLimit(wide)).toBeGreaterThan(turnSpeedLimit(tight))
  })
})
