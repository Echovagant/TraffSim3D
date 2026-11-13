import { describe, it, expect } from 'vitest'
import { vehicleSteeringAngle, turnSteeringAngle } from './steeringAngle'
import { lanePoint } from './laneGeometry'
import { VEHICLE_PURE_PURSUIT } from '@shared/constants/simulation'
import { makePolylineRoad } from '@__fixtures__/testNetwork'
import type { Vehicle } from '@domain/entities/Vehicle'

/** NS road: startNode (0,0,-30) → endNode (0,0,30) — forward tangent +Z. */
const nsRoad = makePolylineRoad(
  'r-steer',
  [
    { x: 0, z: -30 },
    { x: 0, z: 30 },
  ],
  // Four lanes: lanes 0 and 1 both travel the forward direction, so a
  // lane change between them is a legal manoeuvre (with two lanes the
  // second one is oncoming traffic).
  4,
)

/**
 * A vehicle sitting on `laneIndex` at `s`, pointing along that lane
 * (which is what the lane guard keeps true). Only the fields the
 * steering law reads are filled in.
 */
const vehicleOn = (overrides: Partial<Vehicle> = {}): Vehicle => {
  const lp = lanePoint(nsRoad, 0, 10)
  return {
    id: 'v1',
    type: 'car',
    roadId: nsRoad.id,
    laneIndex: 0,
    desiredLaneIndex: null,
    s: 10,
    speed: 12,
    heading: lp.heading,
    position: { x: lp.position.x, y: 0, z: lp.position.z },
    status: 'driving',
    ...overrides,
  } as Vehicle
}

describe('vehicleSteeringAngle', () => {
  it('straight lane → wheel essentially straight', () => {
    const deg = (vehicleSteeringAngle(vehicleOn(), nsRoad) * 180) / Math.PI
    expect(Math.abs(deg)).toBeLessThan(3)
  })

  it('a lane change steers toward the TARGET lane, not the one it is leaving', () => {
    // Lane 0 is the rightmost, so moving to lane 1 is a turn to the left —
    // positive in the simulation's convention. This is the property the
    // old HUD faked with a hard-coded ±26°.
    const left = vehicleSteeringAngle(vehicleOn({ desiredLaneIndex: 1 }), nsRoad)
    expect(left).toBeGreaterThan(0.03)
    // Mirrored: a change to a lower lane index (from lane 1 to 0) is right.
    const lp = lanePoint(nsRoad, 1, 10)
    const right = vehicleSteeringAngle(
      vehicleOn({
        laneIndex: 1,
        desiredLaneIndex: 0,
        heading: lp.heading,
        position: { x: lp.position.x, y: 0, z: lp.position.z },
      }),
      nsRoad,
    )
    expect(right).toBeLessThan(-0.03)
  })

  it('a stopped car is not being steered — tick sets no angular velocity below 0.5 m/s', () => {
    expect(vehicleSteeringAngle(vehicleOn({ speed: 0.2, desiredLaneIndex: 1 }), nsRoad)).toBe(0)
  })

  it('mid-turn the wheel follows the arc curvature and stays inside a real lock', () => {
    // A quarter turn from +X to +Z: heading increases, so the wheel is left.
    const turn = {
      s: 0,
      heading: 0,
      p0x: 0,
      p0z: 0,
      p1x: 10,
      p1z: 0,
      p2x: 10,
      p2z: 10,
      length: 15.7,
      dist: 7.85,
    }
    const delta = turnSteeringAngle(turn, VEHICLE_PURE_PURSUIT.car.wheelbase)
    expect(delta).toBeGreaterThan(0)
    expect((delta * 180) / Math.PI).toBeLessThanOrEqual(45)
    // The mirrored arc turns right.
    const mirrored = turnSteeringAngle({ ...turn, p2z: -10 }, VEHICLE_PURE_PURSUIT.car.wheelbase)
    expect(mirrored).toBeLessThan(0)
    expect(mirrored).toBeCloseTo(-delta, 6)
  })

  it('the turn angle scales with the wheelbase — a bus steers less for the same arc', () => {
    const turn = {
      s: 0,
      heading: 0,
      p0x: 0,
      p0z: 0,
      p1x: 10,
      p1z: 0,
      p2x: 10,
      p2z: 10,
      length: 15.7,
      dist: 7.85,
    }
    const car = turnSteeringAngle(turn, VEHICLE_PURE_PURSUIT.car.wheelbase)
    const bus = turnSteeringAngle(turn, VEHICLE_PURE_PURSUIT.bus.wheelbase)
    expect(bus).toBeGreaterThan(car)
  })
})
