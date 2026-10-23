// src/application/services/tick.laneChangeFallback.spec.ts
//
// The lane change of the **physics-free fallback path**.
//
// The defect: the fallback path did not move the vehicle sideways at
// all — it *blended* the position from the current lane to the target
// lane over a fixed duration (a time mix). The physics path, on the
// other hand, applies a lateral **velocity**: a P-controller on the
// offset from the road's centreline (`STEER_GAIN` = 2 /s, capped at
// `MAX_LATERAL_MS` = 4 m/s). Two different manoeuvres, two different
// outcomes.
//
// What is pinned here:
//
//   1. The fallback path now places the body where the same
//      P-controller would have put it: the lateral rate starts at
//      `min(error · gain, cap)` and never exceeds the cap.
//   2. Both paths converge into the target lane and commit it.
//   3. The two offset trajectories agree — the fallback is not a
//      different manoeuvre any more.
//
// The physics double is behavioural: it integrates the bodies
// (`position += linvel · dt`) and applies the lateral velocity the way
// `RapierWorld.setVehicleLateralVelocity` does (perpendicular to the
// current linear velocity).

import { describe, it, expect, beforeEach } from 'vitest'
import { tick, fallbackLateralOffset, type TickContext } from './tick'
import { createRoadNetwork } from '@domain/entities/RoadNetwork'
import { LaneId } from '@domain/value-objects/LaneId'
import { laneOffset, lanePoint } from '@domain/services/laneGeometry'
import { perpendicularOffsetAlongRoad } from '@domain/services/laneChange'
import type { RapierWorld } from '@infrastructure/physics'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Vehicle } from '@domain/entities/Vehicle'

const ROAD_LEN = 400
const LANE_COUNT = 4
/** The controller's constants (they live in tick.ts). */
const STEER_GAIN = 2.0
const MAX_LATERAL_MS = 4.0

interface FakeBody {
  x: number
  z: number
  heading: number
  vx: number
  vz: number
}

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
    setVehicleLateralVelocity: (id: string, lateralMs: number): void => {
      const b = bodies.get(id)
      if (!b) return
      const speed = Math.hypot(b.vx, b.vz)
      if (speed < 0.01) return
      const dirX = b.vx / speed
      const dirZ = b.vz / speed
      b.vx += -dirZ * lateralMs
      b.vz += dirX * lateralMs
    },
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
    desiredLaneIndex: 1,
    laneChangeStartedAt: 0,
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

interface RunResult {
  /** Lateral offset relative to the TARGET lane (m). 0 = on target. */
  offsets: number[]
  /** The lateral speed (m/s) between two samples of an active change. */
  rates: number[]
  /** The biggest position jump of the whole run (m) — the commit snap. */
  maxJump: number
  /** Sim time at which the lane change was committed. */
  convergedAt: number | null
  laneIndex: number
}

/** Run a lane change and measure the lateral offset it produces. */
const runLaneChange = (withPhysics: boolean, seconds = 3): RunResult => {
  const net = buildRoad()
  const v = addVehicle(net, 'v-1', 20, 10)
  const bodies = new Map<string, FakeBody>()
  if (withPhysics) {
    bodies.set('v-1', { x: v.position.x, z: v.position.z, heading: v.heading, vx: 0, vz: 0 })
  }
  const ctx = makeCtx(withPhysics ? makeFakeWorld(bodies) : null)
  const road = net.roads['r-1']!
  const targetLat = laneOffset(1, LANE_COUNT)

  const offsets: number[] = []
  const rates: number[] = []
  const active: boolean[] = []
  let maxJump = 0
  let convergedAt: number | null = null
  const dt = 1 / 60
  const frames = Math.round(seconds * 60)
  for (let i = 0; i < frames; i++) {
    const simTime = (i + 1) * dt
    tick(net, dt, simTime, ctx)
    const offset = perpendicularOffsetAlongRoad(road, v.s, v.position) - targetLat
    if (offsets.length > 0) {
      const jump = Math.abs(offset - offsets[offsets.length - 1]!)
      if (jump > maxJump) maxJump = jump
      // The rate is only meaningful while the change is running: the
      // commit itself moves the body onto the lane centreline.
      if (active[i - 1]! && v.desiredLaneIndex !== null) {
        rates.push((offset - offsets[offsets.length - 1]!) / dt)
      }
    }
    offsets.push(offset)
    active.push(v.desiredLaneIndex !== null)
    if (convergedAt === null && v.desiredLaneIndex === null) convergedAt = simTime
  }
  return { offsets, rates, maxJump, convergedAt, laneIndex: v.laneIndex }
}

describe('the physics-free fallback lane change', () => {
  beforeEach(() => {
    // Nothing global to reset — each run builds its own network.
  })

  it('moves sideways under the same P-controller as the physics path', () => {
    const fallback = runLaneChange(false)
    const physics = runLaneChange(true)

    console.log(
      '[lane change / fallback] offset every 6th frame:',
      fallback.offsets
        .filter((_, i) => i % 6 === 0)
        .map((o) => o.toFixed(3))
        .join(' '),
    )
    console.log(
      '[lane change / physics ] offset every 6th frame:',
      physics.offsets
        .filter((_, i) => i % 6 === 0)
        .map((o) => o.toFixed(3))
        .join(' '),
    )
    console.log(
      '[lane change] fallback converged at',
      fallback.convergedAt,
      's | physics converged at',
      physics.convergedAt,
      's',
    )

    // The error to close is one lane width (3.5 m): the controller is
    // saturated at the start, so the lateral rate is the cap.
    const error = laneOffset(1, LANE_COUNT) - laneOffset(0, LANE_COUNT)
    expect(error).toBeCloseTo(-3.5, 6)
    expect(Math.abs(error) * STEER_GAIN).toBeGreaterThan(MAX_LATERAL_MS)

    // The fallback moves sideways at all — the old time mix moved it
    // too, but with a completely different rate: the old blend covered
    // 3.5 m in 2 s (1.75 m/s average, and 3.5 m/s in the first half),
    // the controller saturates at 4 m/s and then eases off.
    expect(Math.abs(fallback.rates[0]!)).toBeGreaterThan(2)
    // …and never faster than the cap.
    for (const rate of fallback.rates) {
      expect(Math.abs(rate)).toBeLessThanOrEqual(MAX_LATERAL_MS + 1e-6)
    }
    for (const rate of physics.rates) {
      expect(Math.abs(rate)).toBeLessThanOrEqual(MAX_LATERAL_MS + 1e-6)
    }

    // The one place the two paths still differ: when the change is
    // committed, the fallback puts the body on the lane centreline and
    // the physics path keeps the (≤ 0.3 m) residual and lets Pure
    // Pursuit pull it back. The snap is bounded by the convergence
    // threshold, so it is a tenth of a lane width at most.
    expect(fallback.maxJump).toBeLessThanOrEqual(0.3 + 1e-6)
    console.log(
      '[lane change] biggest single-frame jump — fallback:',
      fallback.maxJump.toFixed(4),
      'm | physics:',
      physics.maxJump.toFixed(4),
      'm',
    )

    // Both paths end up in the target lane.
    expect(fallback.laneIndex).toBe(1)
    expect(physics.laneIndex).toBe(1)
    expect(Math.abs(fallback.offsets[fallback.offsets.length - 1]!)).toBeLessThan(0.3)
    expect(Math.abs(physics.offsets[physics.offsets.length - 1]!)).toBeLessThan(0.3)

    // Both paths converge, and they converge at the same time.
    expect(fallback.convergedAt).not.toBeNull()
    expect(physics.convergedAt).not.toBeNull()
    expect(Math.abs(fallback.convergedAt! - physics.convergedAt!)).toBeLessThan(0.5)

    // The two trajectories describe the same manoeuvre: the offsets
    // stay within half a lane of each other at every sample.
    let maxDiff = 0
    for (let i = 0; i < fallback.offsets.length; i++) {
      const diff = Math.abs(fallback.offsets[i]! - physics.offsets[i]!)
      if (diff > maxDiff) maxDiff = diff
      expect(diff).toBeLessThan(1.75)
    }
    console.log(
      '[lane change] biggest offset difference between the two paths:',
      maxDiff.toFixed(4),
      'm',
    )
  })

  it('the closed form obeys the gain and the cap', () => {
    const from = laneOffset(0, LANE_COUNT)
    const to = laneOffset(1, LANE_COUNT)
    // One lane width: the controller saturates at the cap.
    const saturated = fallbackLateralOffset(from, to, 0.001) - from
    expect(Math.abs(saturated) / 0.001).toBeCloseTo(MAX_LATERAL_MS, 6)
    // A small error: the proportional term is below the cap. The measured
    // rate is the *average* over the interval, and the exponential
    // decay makes it a hair below the instantaneous rate at t = 0
    // (1 - gain·t/2), so the tolerance is 1 %.
    const near = fallbackLateralOffset(0, 0.5, 0.001) - 0
    expect(near / 0.001).toBeCloseTo(0.5 * STEER_GAIN, 2)
    // It converges to the target and never overshoots it.
    expect(fallbackLateralOffset(from, to, 10)).toBeCloseTo(to, 6)
    let previous = from
    for (let t = 0; t <= 3; t += 0.01) {
      const offset = fallbackLateralOffset(from, to, t)
      expect(offset).toBeLessThanOrEqual(from + 1e-9)
      expect(offset).toBeGreaterThanOrEqual(to - 1e-9)
      previous = offset
    }
    // The exponential never reaches the target exactly — after 3 s the
    // remaining error is 1 cm, far below the 0.3 m the tick needs to
    // commit the change.
    expect(Math.abs(previous - to)).toBeLessThan(0.05)
  })
})
