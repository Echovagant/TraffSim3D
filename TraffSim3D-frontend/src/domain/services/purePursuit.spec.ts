import { describe, it, expect } from 'vitest'
import {
  computeSteeringAngle,
  steeringAngleToOmega,
  STEER_SPEED_GAIN,
  DEFAULT_PURE_PURSUIT,
} from './purePursuit'
import { makePolylineRoad } from '@__fixtures__/testNetwork'
import { lanePoint } from './laneGeometry'

/** NS road: startNode (0,0,-30) → endNode (0,0,30).
 *  Forward tangent = +Z direction → heading = Math.PI/2.
 *  A vehicle going straight has heading ≈ Math.PI/2. */
const nsRoad = makePolylineRoad(
  'r-test',
  [
    { x: 0, z: -30 },
    { x: 0, z: 30 },
  ],
  2,
)

describe('computeSteeringAngle', () => {
  it('straight ahead on NS road → steering ≈ 0', () => {
    // Vehicle at s=10, laneIndex=0. Compute the actual world position from lanePoint.
    const lp = lanePoint(nsRoad, 0, 10)
    // Vehicle is on the lane, heading = road forward direction (Math.PI/2).
    // LookaheadS = 10 + 8 = 18. lanePoint(nsRoad, 0, 18) has same x as lanePoint(0, 10)
    // but z=18 (further along). dx=0, dz=8. Heading=π/2, lookaheadAngle=π/2 → alpha=0 → delta≈0.
    const delta = computeSteeringAngle(lp.position.x, lp.position.z, lp.heading, nsRoad, 0, 10)
    expect(Math.abs(delta)).toBeLessThan(0.05)
  })

  it('heading too far right → steer left (delta > 0)', () => {
    // Add 0.5 rad to the correct heading (Math.PI/2 + 0.5).
    // Lookahead is still at Math.PI/2 (forward), so alpha = -0.5 rad.
    // Vehicle must steer left to correct → delta > 0.
    const lp = lanePoint(nsRoad, 0, 10)
    const delta = computeSteeringAngle(
      lp.position.x,
      lp.position.z,
      Math.PI / 2 + 0.5,
      nsRoad,
      0,
      10,
    )
    expect(delta).toBeGreaterThan(0)
  })

  it('heading too far left → steer right (delta < 0)', () => {
    // Subtract 0.5 rad from the correct heading (Math.PI/2 - 0.5).
    // Lookahead is at Math.PI/2 (forward), so alpha = +0.5 rad.
    // Vehicle must steer right to correct → delta < 0.
    const lp = lanePoint(nsRoad, 0, 10)
    const delta = computeSteeringAngle(
      lp.position.x,
      lp.position.z,
      Math.PI / 2 - 0.5,
      nsRoad,
      0,
      10,
    )
    expect(delta).toBeLessThan(0)
  })

  it('steering is clamped to ±π/4 even with tiny lookahead', () => {
    // Tiny lookahead (0.5m) makes the curvature extreme; the clamp should catch it.
    const opts = { wheelbase: 2.5, lookahead: 0.5 }
    const lp = lanePoint(nsRoad, 0, 10)
    const delta = computeSteeringAngle(
      lp.position.x,
      lp.position.z,
      Math.PI / 2 + 1.2,
      nsRoad,
      0,
      10,
      opts,
    )
    expect(delta).toBeLessThanOrEqual(Math.PI / 4 + 1e-9)
    expect(delta).toBeGreaterThanOrEqual(-Math.PI / 4 - 1e-9)
  })

  it('lookahead beyond road end → finite (no NaN)', () => {
    // s=55, lookahead=10 → s+lookahead=65 > roadLength(60) → lanePoint clamps.
    const lp = lanePoint(nsRoad, 0, 55)
    const delta = computeSteeringAngle(lp.position.x, lp.position.z, lp.heading, nsRoad, 0, 55)
    expect(Number.isFinite(delta)).toBe(true)
    expect(Number.isNaN(delta)).toBe(false)
  })

  it('alpha normalization: near 180° off course → finite delta (no NaN/∞)', () => {
    // Heading = -π/2 (facing backward), road forward = +π/2.
    // alpha = π (straight behind). Should be finite.
    const lp = lanePoint(nsRoad, 0, 10)
    const delta = computeSteeringAngle(lp.position.x, lp.position.z, -Math.PI / 2, nsRoad, 0, 10)
    expect(Number.isFinite(delta)).toBe(true)
    expect(Number.isNaN(delta)).toBe(false)
  })

  it('different vehicle types → both produce finite clamped steering', () => {
    // Use a scenario where the vehicle is clearly off-course (heading = 0, perpendicular to road).
    // Compute the lane point for laneIndex=0, s=10.
    const lp = lanePoint(nsRoad, 0, 10)
    // heading=0 means facing +X, perpendicular to road (+Z direction). This is off-course.
    const carOpts = { wheelbase: 2.5, lookahead: 8 }
    const truckOpts = { wheelbase: 4.0, lookahead: 12 }
    const deltaCar = computeSteeringAngle(lp.position.x, lp.position.z, 0, nsRoad, 0, 10, carOpts)
    const deltaTruck = computeSteeringAngle(
      lp.position.x,
      lp.position.z,
      0,
      nsRoad,
      0,
      10,
      truckOpts,
    )
    expect(Number.isFinite(deltaCar)).toBe(true)
    expect(Number.isFinite(deltaTruck)).toBe(true)
    expect(Math.abs(deltaCar)).toBeLessThanOrEqual(Math.PI / 4)
    expect(Math.abs(deltaTruck)).toBeLessThanOrEqual(Math.PI / 4)
  })

  it('degenerate: vehicle position identical to lookahead → returns 0', () => {
    // Call computeSteeringAngle with lookaheadS such that lanePoint returns
    // the vehicle's own position (very small lookahead on a long straight road).
    // road from (0,0,0) to (100,0,0) (EW road). Vehicle at s=0.
    const ewRoad = makePolylineRoad(
      'r-ew',
      [
        { x: 0, z: 0 },
        { x: 100, z: 0 },
      ],
      2,
    )
    const lp0 = lanePoint(ewRoad, 0, 0) // vehicle at (off, 0, 0)
    const delta = computeSteeringAngle(lp0.position.x, lp0.position.z, 0, ewRoad, 0, 0, {
      wheelbase: 2.5,
      lookahead: 0,
    })
    expect(delta).toBe(0)
  })
})

describe('steeringAngleToOmega', () => {
  it('max left steering (+π/4) → positive omega', () => {
    const omega = steeringAngleToOmega(Math.PI / 4)
    expect(omega).toBeCloseTo((STEER_SPEED_GAIN * Math.PI) / 4, 4)
    expect(omega).toBeGreaterThan(0)
  })

  it('max right steering (-π/4) → negative omega', () => {
    const omega = steeringAngleToOmega(-Math.PI / 4)
    expect(omega).toBeCloseTo((-STEER_SPEED_GAIN * Math.PI) / 4, 4)
    expect(omega).toBeLessThan(0)
  })

  it('straight ahead (0) → zero omega', () => {
    const omega = steeringAngleToOmega(0)
    expect(omega).toBe(0)
  })

  it('STEER_SPEED_GAIN = 2.5 → at max steering, omega ≈ 1.96 rad/s', () => {
    // 2.5 * π/4 ≈ 1.96 rad/s — a car can sweep 90° in ~0.45s.
    const omega = steeringAngleToOmega(Math.PI / 4)
    expect(omega).toBeCloseTo(1.9635, 2)
  })
})

describe('DEFAULT_PURE_PURSUIT', () => {
  it('has valid wheelbase and lookahead', () => {
    expect(DEFAULT_PURE_PURSUIT.wheelbase).toBeGreaterThan(0)
    expect(DEFAULT_PURE_PURSUIT.lookahead).toBeGreaterThan(0)
  })
})
