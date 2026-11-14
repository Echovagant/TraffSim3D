// src/application/services/tick.driverYaw.spec.ts
//
// The manual driver's wheel owns the vehicle's heading while it is held:
// the bicycle model `ω = v · tan(δ) / L` capped by the friction circle
// `a_lat = v · ω ≤ 8 m/s²` (dry asphalt). Before this existed the car
// shifted inside its lane but never yawed — full lock at 22 m/s would
// have been a 6 rad/s spin, which is exactly why the cap is there.
//
// This spec locks:
//   - the yaw rate formula and its two regimes (geometry at low speed,
//     grip cap at high speed — 22 m/s ⇒ 61 m radius),
//   - the wheel replacing the lane keeper while held, and the keeper
//     taking straight back over on release / during a lane change,
//   - the lane-edge kerb for the nose, on BOTH travel directions —
//     the slide kerb it mirrors lacked the travelSign flip and guarded
//     the wrong edge on backward lanes (fixed here with it).

import { describe, it, expect, vi } from 'vitest'
import { tick, type TickContext } from './tick'
import { createRoadNetwork } from '@domain/entities/RoadNetwork'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Vehicle } from '@domain/entities/Vehicle'
import { LaneId } from '@domain/value-objects/LaneId'
import { lanePoint } from '@domain/services/laneGeometry'
import { computeSteeringAngle, steeringAngleToOmega } from '@domain/services/purePursuit'
import { makeTestRoad } from '@__fixtures__/testNetwork'
import {
  DRIVER_MAX_LAT_ACCEL_MS2,
  DRIVER_WHEELBASE_M,
  VEHICLE_PURE_PURSUIT,
} from '@shared/constants/simulation'
import type { RapierWorld } from '@infrastructure/physics'

const DT = 1 / 60
/** The full-lock front-wheel angle tick.ts derives from the ±1 wheel. */
const FULL_LOCK = (35 * Math.PI) / 180

/** A stub Rapier world: every method records, nothing integrates. */
const makeStub = () => ({
  applyControl: vi.fn(),
  setVehicleHeight: vi.fn(),
  setVehicleLateralVelocity: vi.fn(),
  setVehicleAngularVelocity: vi.fn(),
  setVehicleHeading: vi.fn(),
  setVehicleSpeed: vi.fn(),
  setVehiclePosition: vi.fn(),
  readPose: vi.fn(() => null),
  step: vi.fn(() => ({ dt: DT, subSteps: 1, contactEvents: [] })),
})
type Stub = ReturnType<typeof makeStub>

const makeCtx = (stub: Stub, steer: ((id: string) => number | null) | null): TickContext =>
  ({
    rapierWorld: stub as unknown as RapierWorld,
    signal: null,
    trajectoryExporter: null,
    sensorRegistry: null,
    lidarEnabled: false,
    getHostPose: () => null,
    fixedStepScheduler: null,
    draggingId: null,
    removeVehicle: () => {},
    policy: null,
    replayTargetId: null,
    driverSteer: steer ?? undefined,
  }) as TickContext

/** A straight NS road with `laneCount` lanes (lane 1 of a 2-lane road is backward). */
const makeNet = (laneCount = 2): RoadNetwork => {
  const net = createRoadNetwork()
  net.roads['r-1'] = makeTestRoad('r-1', 'ns', laneCount)
  return net
}

const addVehicle = (net: RoadNetwork, overrides: Partial<Vehicle> = {}): Vehicle => {
  const road = net.roads['r-1']!
  const laneIndex = overrides.laneIndex ?? 0
  const s = overrides.s ?? 20
  const lp = lanePoint(road, laneIndex, s)
  const v: Vehicle = {
    id: 'v-1',
    type: 'car',
    color: '#3a86ff',
    position: { ...lp.position },
    heading: lp.heading,
    speed: 5,
    targetSpeed: road.speedLimit,
    roadId: 'r-1',
    laneIndex,
    s,
    lane: LaneId.make('r-1', laneIndex),
    status: 'driving',
    desiredStatus: 'driving',
    enteredIntersectionAt: null,
    desiredLaneIndex: null,
    laneChangeStartedAt: null,
    spawnedAt: 0,
    ...overrides,
  }
  net.vehicles[v.id] = v
  return v
}

/** Shift the vehicle's position `d` metres toward its own left. */
const shiftLeft = (v: Vehicle, d: number): void => {
  const h = v.heading + Math.PI / 2
  v.position.x += Math.cos(h) * d
  v.position.z += Math.sin(h) * d
}

/** The omega the lane keeper (Pure Pursuit) would command for this pose. */
const keeperOmega = (net: RoadNetwork, v: Vehicle): number => {
  const road = net.roads[v.roadId]!
  const delta = computeSteeringAngle(
    v.position.x,
    v.position.z,
    v.heading,
    road,
    v.desiredLaneIndex ?? v.laneIndex,
    v.s,
    VEHICLE_PURE_PURSUIT[v.type],
  )
  return steeringAngleToOmega(delta)
}

describe('the manual driver wheel owns the heading', () => {
  it('yaws at the bicycle-model rate at low speed (geometry dominates)', () => {
    const net = makeNet()
    const v = addVehicle(net, { speed: 5 })
    const stub = makeStub()
    tick(
      net,
      DT,
      DT,
      makeCtx(stub, () => 1),
    )

    const expected = (5 * Math.tan(FULL_LOCK)) / DRIVER_WHEELBASE_M.car
    // 5 · tan(35°) / 2.7 ≈ 1.306 rad/s; lateral accel 5·1.306 = 6.5 < 8 —
    // the grip cap must NOT bite here.
    expect(stub.setVehicleAngularVelocity).toHaveBeenCalledTimes(1)
    expect(stub.setVehicleAngularVelocity).toHaveBeenCalledWith('v-1', expect.closeTo(expected, 3))
    expect(expected * 5).toBeLessThan(DRIVER_MAX_LAT_ACCEL_MS2)
  })

  it('caps the yaw rate at the friction circle: 22 m/s full lock is a 61 m radius', () => {
    const net = makeNet()
    addVehicle(net, { speed: 22 })
    const stub = makeStub()
    tick(
      net,
      DT,
      DT,
      makeCtx(stub, () => 1),
    )

    const cap = DRIVER_MAX_LAT_ACCEL_MS2 / 22
    // Raw geometry would ask for 22·tan(35°)/2.7 ≈ 5.7 rad/s — a spin.
    expect((22 * Math.tan(FULL_LOCK)) / DRIVER_WHEELBASE_M.car).toBeGreaterThan(5)
    expect(stub.setVehicleAngularVelocity).toHaveBeenCalledWith('v-1', expect.closeTo(cap, 6))
    // The radius the cap implies: v² / a_lat = 484 / 8 = 60.5 m ≈ 61 m.
    expect(22 / cap).toBeCloseTo(60.5, 1)
  })

  it('yaws the other way for a right-hand lock', () => {
    const net = makeNet()
    addVehicle(net, { speed: 5 })
    const stub = makeStub()
    tick(
      net,
      DT,
      DT,
      makeCtx(stub, () => -1),
    )

    const expected = -(5 * Math.tan(FULL_LOCK)) / DRIVER_WHEELBASE_M.car
    expect(stub.setVehicleAngularVelocity).toHaveBeenCalledWith('v-1', expect.closeTo(expected, 3))
  })

  it("uses the vehicle type's real wheelbase (a bus yaws slower than a car)", () => {
    const net = makeNet()
    addVehicle(net, { type: 'bus', speed: 5 })
    const stub = makeStub()
    tick(
      net,
      DT,
      DT,
      makeCtx(stub, () => 1),
    )

    const expected = (5 * Math.tan(FULL_LOCK)) / DRIVER_WHEELBASE_M.bus
    expect(stub.setVehicleAngularVelocity).toHaveBeenCalledWith('v-1', expect.closeTo(expected, 3))
    expect(Math.abs(expected)).toBeLessThan((5 * Math.tan(FULL_LOCK)) / DRIVER_WHEELBASE_M.car)
  })

  it('hands the heading straight back to the lane keeper on release', () => {
    const net = makeNet()
    const v = addVehicle(net, { speed: 5 })
    const stub = makeStub()
    tick(
      net,
      DT,
      DT,
      makeCtx(stub, () => null),
    )

    // The body sits exactly on the lane, so the keeper commands ~0 —
    // distinctly NOT the driver's 1.306 rad/s.
    expect(stub.setVehicleAngularVelocity).toHaveBeenCalledWith(
      'v-1',
      expect.closeTo(keeperOmega(net, v), 6),
    )
  })

  it('lets the keeper own the heading while a lane change is in progress', () => {
    const net = makeNet()
    const v = addVehicle(net, { speed: 5, desiredLaneIndex: 1, laneChangeStartedAt: 0 })
    const stub = makeStub()
    tick(
      net,
      DT,
      DT,
      makeCtx(stub, () => 1),
    )

    expect(stub.setVehicleAngularVelocity).toHaveBeenCalledWith(
      'v-1',
      expect.closeTo(keeperOmega(net, v), 6),
    )
  })

  it('never yaws a stationary car, even at full lock', () => {
    const net = makeNet()
    addVehicle(net, { speed: 0 })
    const stub = makeStub()
    tick(
      net,
      DT,
      DT,
      makeCtx(stub, () => 1),
    )

    expect(stub.setVehicleAngularVelocity).not.toHaveBeenCalled()
  })
})

describe('the lane edge is a kerb for the nose (both travel directions)', () => {
  it('blocks an outward lock at the left edge and lets the keeper pull back (lane 0)', () => {
    const net = makeNet()
    const v = addVehicle(net, { speed: 5 })
    shiftLeft(v, 1.2) // 1.2 m past the kerb threshold toward the vehicle's left
    const stub = makeStub()
    tick(
      net,
      DT,
      DT,
      makeCtx(stub, () => 1),
    ) // further left = outward

    expect(stub.setVehicleAngularVelocity).toHaveBeenCalledWith(
      'v-1',
      expect.closeTo(keeperOmega(net, v), 6),
    )
  })

  it('still turns inward from the left edge (lane 0)', () => {
    const net = makeNet()
    const v = addVehicle(net, { speed: 5 })
    shiftLeft(v, 1.2)
    const stub = makeStub()
    tick(
      net,
      DT,
      DT,
      makeCtx(stub, () => -1),
    ) // back toward the lane centre

    const expected = -(5 * Math.tan(FULL_LOCK)) / DRIVER_WHEELBASE_M.car
    expect(stub.setVehicleAngularVelocity).toHaveBeenCalledWith('v-1', expect.closeTo(expected, 3))
  })

  it('guards the correct edge on a BACKWARD lane (lane 1 of a two-way road)', () => {
    const net = makeNet()
    const v = addVehicle(net, { speed: 5, laneIndex: 1 })
    shiftLeft(v, 1.2) // toward the VEHICLE's left — the road's right on a backward lane
    const stub = makeStub()

    // Outward (the driver's left) is blocked; the keeper pulls the nose back.
    tick(
      net,
      DT,
      DT,
      makeCtx(stub, () => 1),
    )
    expect(stub.setVehicleAngularVelocity).toHaveBeenCalledWith(
      'v-1',
      expect.closeTo(keeperOmega(net, v), 6),
    )

    // Inward still turns.
    const stub2 = makeStub()
    tick(
      net,
      DT,
      DT,
      makeCtx(stub2, () => -1),
    )
    const expected = -(5 * Math.tan(FULL_LOCK)) / DRIVER_WHEELBASE_M.car
    expect(stub2.setVehicleAngularVelocity).toHaveBeenCalledWith('v-1', expect.closeTo(expected, 3))
  })
})

describe('the lateral-slide kerb mirrors the same travelSign rule', () => {
  it('zeroes an outward slide at the edge on a backward lane (the 5b fix)', () => {
    const net = makeNet()
    const v = addVehicle(net, { speed: 5, laneIndex: 1 })
    shiftLeft(v, 1.2)
    const stub = makeStub()
    tick(
      net,
      DT,
      DT,
      makeCtx(stub, () => 1),
    ) // outward slide must be kerbed

    expect(stub.setVehicleLateralVelocity).toHaveBeenCalledWith('v-1', 0)
  })

  it('lets an inward slide through on a backward lane', () => {
    const net = makeNet()
    const v = addVehicle(net, { speed: 5, laneIndex: 1 })
    shiftLeft(v, 1.2)
    const stub = makeStub()
    tick(
      net,
      DT,
      DT,
      makeCtx(stub, () => -1),
    )

    // v·tan(35°) = 3.5 m/s, capped at the 2.5 m/s the slide allows.
    expect(stub.setVehicleLateralVelocity).toHaveBeenCalledWith('v-1', -2.5)
  })
})
