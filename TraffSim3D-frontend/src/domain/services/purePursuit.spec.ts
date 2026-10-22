import { describe, it, expect } from 'vitest'
import {
  computeSteeringAngle,
  steeringAngleToOmega,
  STEER_SPEED_GAIN,
  DEFAULT_PURE_PURSUIT,
} from './purePursuit'
import { pythonSteer } from './egoKernel'
import { PYTHON_SIM } from '@shared/constants/simulation'
import { makePolylineRoad } from '@__fixtures__/testNetwork'
import { lanePoint } from './laneGeometry'

/** Wrap an angle to (-π, π]. */
const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a))

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

  it('steering always turns the heading TOWARD the lookahead point', () => {
    // The property that matters, stated so a sign error cannot pass again:
    // applying the steering must bring the heading *closer* to the direction
    // of the lookahead point.
    //
    // How the browser integrates it: `delta` becomes an angular velocity
    // about the world +Y axis (`setVehicleAngularVelocity` → `setAngvel`),
    // and the heading the sim reports is that same +Y yaw (`readPose`). So a
    // positive delta *increases* the reported heading, at `delta * GAIN` rad/s.
    //
    // This test previously asserted a hard-coded sign and thereby pinned the
    // inverted alpha that made the browser's traffic steer away from its lane
    // (fixed 2026-10-22).
    const lookaheadAngle = Math.PI / 2 // the NS road's forward direction
    const lp = lanePoint(nsRoad, 0, 10)

    for (const offset of [-0.6, -0.2, 0.2, 0.6]) {
      const heading = lookaheadAngle + offset
      const delta = computeSteeringAngle(lp.position.x, lp.position.z, heading, nsRoad, 0, 10)

      const errBefore = Math.abs(wrapPi(heading - lookaheadAngle))
      const headingAfter = heading + delta * STEER_SPEED_GAIN * (1 / 60)
      const errAfter = Math.abs(wrapPi(headingAfter - lookaheadAngle))

      expect(errAfter).toBeLessThan(errBefore)
    }
  })

  it('agrees with the training sim kernel (pythonSteer) on the same geometry', () => {
    // `egoKernel.ts` is the training sim's 1:1 TypeScript port, and the
    // cross-language contract pins it against Python. This controller is the
    // browser's Rapier path — it must not drift from the kernel's alpha sign.
    //
    // On a straight road the lookahead point sits exactly LOOKAHEAD_DISTANCE
    // ahead, so the denominator and the wheelbase match and the two steering
    // laws must agree exactly (both stay inside the ±MAX_STEER clamp here).
    const lp = lanePoint(nsRoad, 0, 10)
    const heading = Math.PI / 2 + 0.5
    const target: readonly [number, number] = [
      lanePoint(nsRoad, 0, 10 + PYTHON_SIM.LOOKAHEAD_DISTANCE).position.x,
      lanePoint(nsRoad, 0, 10 + PYTHON_SIM.LOOKAHEAD_DISTANCE).position.z,
    ]

    const browserDelta = computeSteeringAngle(
      lp.position.x,
      lp.position.z,
      heading,
      nsRoad,
      0,
      10,
      {
        wheelbase: PYTHON_SIM.EGO_WHEELBASE,
        lookahead: PYTHON_SIM.LOOKAHEAD_DISTANCE,
      },
    )
    const kernelDelta = pythonSteer(
      { x: lp.position.x, z: lp.position.z, heading, speed: 0 },
      target,
    )

    expect(browserDelta).toBeCloseTo(kernelDelta, 12)
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
