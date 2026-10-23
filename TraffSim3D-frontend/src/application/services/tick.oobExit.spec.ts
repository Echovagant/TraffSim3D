// src/application/services/tick.oobExit.spec.ts
//
// The out-of-bounds exit phase, measured end to end through `tick()`.
//
// What is pinned here:
//
//   1. A vehicle that has left the road network does **not** vanish in
//      the frame it is detected: it **brakes** (the speed comes down
//      under the simulation's own stop deceleration, MAX_DECEL) and is
//      only put back at the road start once it has come to a stop.
//   2. The vehicle really ends up back at the road start (`s = 0`, the
//      lane point) — and it does not get reset again on the next
//      frames.
//   3. The other vehicles are not affected: they keep driving, and the
//      leaving vehicle is **not** a leader for the car behind it.
//
// The physics double below is behavioural: it integrates the bodies
// (`position += linvel · dt`) and it can be told to "lose" a vehicle
// (no body for it) — which is the situation the out-of-bounds branch
// exists for: the simulator cannot re-derive the pose of a vehicle it
// has lost track of.

import { describe, it, expect, beforeEach } from 'vitest'
import { tick, type TickContext } from './tick'
import { getOobEvents, clearOobEvents } from './oobCleanup'
import { createRoadNetwork } from '@domain/entities/RoadNetwork'
import { LaneId } from '@domain/value-objects/LaneId'
import { lanePoint } from '@domain/services/laneGeometry'
import { MAX_DECEL } from '@shared/constants/simulation'
import type { RapierWorld } from '@infrastructure/physics'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Vehicle } from '@domain/entities/Vehicle'

const ROAD_LEN = 200
const LANE_COUNT = 4

interface FakeBody {
  x: number
  z: number
  heading: number
  vx: number
  vz: number
}

/**
 * A minimal behavioural physics double: it holds the bodies, applies
 * the control the tick asks for, and integrates them.
 */
const makeFakeWorld = (bodies: Map<string, FakeBody>): RapierWorld => {
  const world = {
    applyControl: (id: string, _control: unknown, targetSpeed: number, heading: number): void => {
      const b = bodies.get(id)
      if (!b) return
      b.vx = Math.max(0, targetSpeed) * Math.cos(heading)
      b.vz = Math.max(0, targetSpeed) * Math.sin(heading)
    },
    setVehicleSpeed: (id: string, speed: number, heading: number): void => {
      const b = bodies.get(id)
      if (!b) return
      b.vx = Math.max(0, speed) * Math.cos(heading)
      b.vz = Math.max(0, speed) * Math.sin(heading)
    },
    setVehicleLateralVelocity: (): void => {},
    setVehicleAngularVelocity: (): void => {},
    setVehiclePosition: (id: string, position: { x: number; z: number }): void => {
      const b = bodies.get(id)
      if (!b) return
      b.x = position.x
      b.z = position.z
      b.vx = 0
      b.vz = 0
    },
    setVehicleHeading: (id: string, heading: number): void => {
      const b = bodies.get(id)
      if (!b) return
      b.heading = heading
    },
    readPose: (id: string) => {
      const b = bodies.get(id)
      if (!b) return null
      return {
        position: { x: b.x, y: 0, z: b.z },
        heading: b.heading,
        speed: Math.hypot(b.vx, b.vz),
      }
    },
    step: (dt: number) => {
      for (const b of bodies.values()) {
        b.x += b.vx * dt
        b.z += b.vz * dt
      }
      return { contactEvents: [] }
    },
  }
  return world as unknown as RapierWorld
}

const buildRoad = (): RoadNetwork => {
  const net = createRoadNetwork()
  net.roads['r-1'] = {
    id: 'r-1',
    startNode: { x: 0, y: 0, z: 0 },
    endNode: { x: 0, y: 0, z: ROAD_LEN },
    laneCount: LANE_COUNT,
    speedLimit: 16.67,
    level: 0,
  }
  return net
}

const addVehicle = (net: RoadNetwork, id: string, s: number, speed: number): Vehicle => {
  const road = net.roads['r-1']!
  const lp = lanePoint(road, 0, s)
  const v: Vehicle = {
    id,
    type: 'car',
    color: '#3a86ff',
    position: { ...lp.position },
    heading: lp.heading,
    speed,
    targetSpeed: road.speedLimit,
    roadId: 'r-1',
    laneIndex: 0,
    s,
    lane: LaneId.make('r-1', 0),
    status: 'driving',
    desiredStatus: 'driving',
    enteredIntersectionAt: null,
    desiredLaneIndex: null,
    laneChangeStartedAt: null,
    spawnedAt: -10,
  }
  net.vehicles[id] = v
  return v
}

const makeCtx = (rapierWorld: RapierWorld | null): TickContext => ({
  rapierWorld,
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
})

describe('the out-of-bounds exit phase (through tick)', () => {
  let net: RoadNetwork
  let bodies: Map<string, FakeBody>
  let world: RapierWorld

  beforeEach(() => {
    net = buildRoad()
    bodies = new Map()
    world = makeFakeWorld(bodies)
    clearOobEvents()
  })

  it('brakes the vehicle that left the network, then puts it back at the road start', () => {
    const healthy = addVehicle(net, 'v-ok', 40, 8)
    bodies.set('v-ok', {
      x: healthy.position.x,
      z: healthy.position.z,
      heading: healthy.heading,
      vx: 0,
      vz: 0,
    })
    // The lost vehicle: the simulator has no body for it, so it cannot
    // re-derive its pose — this is the situation the out-of-bounds
    // branch exists for.
    const lost = addVehicle(net, 'v-lost', 20, 12)
    lost.position = { x: 1000, y: 0, z: 1000 }

    const ctx = makeCtx(world)
    const speeds: number[] = []
    const sSeries: number[] = []
    let resetAt: number | null = null

    const dt = 1 / 60
    for (let i = 0; i < 180; i++) {
      const simTime = (i + 1) * dt
      tick(net, dt, simTime, ctx)
      speeds.push(lost.speed)
      sSeries.push(lost.s)
      if (resetAt === null && lost.s === 0) resetAt = simTime
    }

    console.log(
      '[oob exit] speed every 6th frame:',
      speeds
        .filter((_, i) => i % 6 === 0)
        .map((s) => s.toFixed(2))
        .join(' '),
    )
    console.log('[oob exit] reset at t =', resetAt, 's | s series:', sSeries.join(','))

    // The speed comes down — it is a braking process, not a cut. The
    // detection frame itself leaves the speed alone (the vehicle is
    // only *marked* as leaving); the braking starts on the next tick.
    expect(speeds[0]).toBeCloseTo(12, 6)
    expect(speeds[1]!).toBeCloseTo(12 - MAX_DECEL * dt, 6)
    for (let i = 1; i < speeds.length; i++) {
      expect(speeds[i]!).toBeLessThanOrEqual(speeds[i - 1]! + 1e-9)
    }
    // It takes real time to stop: 12 m/s at 10 m/s² is 1.2 s.
    expect(resetAt).not.toBeNull()
    expect(resetAt!).toBeGreaterThan(1.0)
    expect(resetAt!).toBeLessThan(2.0)

    // …and it really ends up back at the road start.
    const expected = lanePoint(net.roads['r-1']!, 0, 0)
    expect(lost.s).toBe(0)
    expect(lost.position.x).toBeCloseTo(expected.position.x, 6)
    expect(lost.position.z).toBeCloseTo(expected.position.z, 6)
    expect(lost.speed).toBe(0)

    // It is not reset again on the following frames.
    const resets = getOobEvents().filter((e) => e.kind === 'reset')
    expect(resets).toHaveLength(1)
    expect(resets[0]!.reason).toContain('stopped')
    expect(getOobEvents()[0]!.kind).toBe('exit-start')

    // The healthy vehicle kept driving.
    expect(healthy.s).toBeGreaterThan(40)
  })

  it('does not let the leaving vehicle hold up the car behind it', () => {
    // The leaving vehicle is 20 m ahead of the follower, on the same
    // lane. It is off the road and stopping — it must not be a leader.
    const follower = addVehicle(net, 'v-ok', 10, 0)
    bodies.set('v-ok', {
      x: follower.position.x,
      z: follower.position.z,
      heading: follower.heading,
      vx: 0,
      vz: 0,
    })
    const lost = addVehicle(net, 'v-lost', 20, 12)
    lost.position = { x: 1000, y: 0, z: 1000 }

    const ctx = makeCtx(world)
    const dt = 1 / 60
    for (let i = 0; i < 60; i++) tick(net, dt, (i + 1) * dt, ctx)

    console.log('[oob exit] follower speed after 1 s:', follower.speed.toFixed(3))
    // The follower accelerates normally (2 m/s² comfort ramp) instead
    // of braking for a car that is not on the road any more.
    expect(follower.speed).toBeGreaterThan(1)
  })
})
