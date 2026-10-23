// src/application/services/tick.stopLine.spec.ts
//
// The stop line of a traffic light used to sit at `len / 2 - radius` —
// the **midpoint** of the road. An imported OSM junction sits at a way
// *endpoint*, so the stop line has to follow the projection of the
// intersection position onto the road (see
// `domain/services/laneGeometry.ts`).
//
// This spec locks:
//   - the built-in demo scene: the numbers the old midpoint formula
//     produced, bit for bit (the intersection of the cross scene sits
//     exactly at the road midpoint, so the projection agrees with it),
//   - an imported-style network whose junction is NOT at the midpoint:
//     the stop line follows the projection, in BOTH travel directions,
//   - the degradation path (a junction that does not fit the road falls
//     back to the midpoint assumption).

import { describe, it, expect } from 'vitest'
import { tick } from './tick'
import type { TickContext } from './tick'
import { buildCrossIntersectionNetwork } from './defaultScene'
import { createRoadNetwork } from '@domain/entities/RoadNetwork'
import { LaneId } from '@domain/value-objects/LaneId'
import { LightPhase } from '@domain/value-objects/Phase'
import { intersectionSRange, lanePoint, roadLength } from '@domain/services/laneGeometry'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Vehicle } from '@domain/entities/Vehicle'

const DT = 1 / 60

const makeCtx = (): TickContext => ({
  rapierWorld: null,
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

interface NetOptions {
  /** Where the junction sits along the road (metres from the start node). */
  junctionS?: number
  /** Road length (metres). */
  length?: number
  /** Lanes per direction (total = 2 × lanesPerDirection). */
  lanesPerDirection?: number
  /** Light phase at the junction. */
  phase?: LightPhase
  /** Offset the junction sideways — used to test the degradation path. */
  junctionOffsetX?: number
  /** Junction radius (metres). */
  radius?: number
}

/**
 * A straight NS road with one red light. The junction sits at
 * `junctionS` along the road — the shape an imported OSM map has
 * (a junction at a way endpoint), NOT the built-in midpoint.
 */
const buildNetwork = (opts: NetOptions = {}): RoadNetwork => {
  const {
    junctionS = 20,
    length = 100,
    lanesPerDirection = 2,
    phase = LightPhase.Red,
    junctionOffsetX = 0,
    radius = 8,
  } = opts
  const net = createRoadNetwork()
  net.roads['r-1'] = {
    id: 'r-1',
    startNode: { x: 0, y: 0, z: -length / 2 },
    endNode: { x: 0, y: 0, z: length / 2 },
    laneCount: lanesPerDirection * 2,
    speedLimit: 16.67,
    level: 0,
  }
  net.intersections['i-1'] = {
    id: 'i-1',
    position: { x: junctionOffsetX, y: 0, z: -length / 2 + junctionS },
    connectedRoads: ['r-1'],
    trafficLights: [
      {
        id: 'tl-1',
        position: { x: junctionOffsetX, y: 0, z: -length / 2 + junctionS },
        phase,
        phaseRemaining: 300,
        cycleSeconds: 63,
        axis: 'ns',
      },
    ],
    intersectionRadius: radius,
  }
  return net
}

const addVehicle = (
  net: RoadNetwork,
  id: string,
  s: number,
  speed: number,
  laneIndex = 0,
): Vehicle => {
  const road = net.roads['r-1']!
  const lp = lanePoint(road, laneIndex, s)
  const v: Vehicle = {
    id,
    type: 'car',
    color: '#3a86ff',
    position: { ...lp.position },
    heading: lp.heading,
    speed,
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
  }
  net.vehicles[id] = v
  return v
}

const run = (net: RoadNetwork, ticks: number, ctx: TickContext = makeCtx()): void => {
  for (let i = 0; i < ticks; i++) tick(net, DT, (i + 1) * DT, ctx)
}

// ---------------------------------------------------------------------------
// 1. The built-in scene must not move
// ---------------------------------------------------------------------------

describe('the built-in cross scene keeps its numbers', () => {
  const net = buildCrossIntersectionNetwork()
  const road = net.roads['r-ns']!
  const inter = net.intersections['i-center']!

  it('projects the junction onto the road midpoint exactly', () => {
    const len = roadLength(road)
    // The old assumption was `len / 2`; the projection must agree with
    // it to the last bit, because the junction of the cross scene sits
    // exactly at the road midpoint.
    expect(len).toBe(60)
    expect(inter.position).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('keeps the intersection box range identical to `len / 2 ± radius`', () => {
    const radius = inter.intersectionRadius
    const [lo, hi] = intersectionSRange(road, radius, inter)
    expect(lo).toBe(roadLength(road) / 2 - radius)
    expect(hi).toBe(roadLength(road) / 2 + radius)
    expect([lo, hi]).toEqual([22, 38])
  })

  it('holds a forward-lane vehicle at the very same place as before', () => {
    // Golden captured from the pre-change code (300 ticks, dt = 1/60):
    // the vehicle rolled to s = 18.052222222222223 and stopped there.
    // The junction sits at the road midpoint (s = 30 of 60), exactly like
    // the cross scene, so the projection agrees with the old formula.
    const golden = buildNetwork({ junctionS: 30, length: 60, lanesPerDirection: 3 })
    const v = addVehicle(golden, 'v-1', 5, 12, 0)
    run(golden, 300)
    expect(v.s).toBe(18.052222222222223)
    expect(v.speed).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. An imported-style junction that is NOT at the midpoint
// ---------------------------------------------------------------------------

describe('an imported junction places the stop line at the projection', () => {
  it('holds a forward vehicle at `junctionS - radius`, not at the midpoint', () => {
    const net = buildNetwork({ junctionS: 20, length: 100 })
    // The old midpoint assumption would have put the line at 50 - 8 = 42.
    const v = addVehicle(net, 'v-1', 0, 0, 0)
    tick(net, DT, DT, makeCtx())
    // Standing ON the projected stop line (20 - 8 = 12) is held.
    v.s = 12
    tick(net, DT, 2 * DT, makeCtx())
    expect(v.targetSpeed).toBe(0)
    // Just past it the vehicle is committed (the dilemma-zone rule).
    v.s = 13
    tick(net, DT, 3 * DT, makeCtx())
    expect(v.targetSpeed).toBeGreaterThan(0)
  })

  it('mirrors the stop line for the backward lanes', () => {
    const net = buildNetwork({ junctionS: 20, length: 100 })
    const v = addVehicle(net, 'v-1', 28, 0, 2) // lane 2 = backward lane
    tick(net, DT, DT, makeCtx())
    // The backward approach stops at `junctionS + radius` = 28.
    expect(v.targetSpeed).toBe(0)
    // Past it (a smaller s) the vehicle is committed.
    v.s = 27
    tick(net, DT, 2 * DT, makeCtx())
    expect(v.targetSpeed).toBeGreaterThan(0)
    // Before it (a larger s) it is still held.
    v.s = 29
    tick(net, DT, 3 * DT, makeCtx())
    expect(v.targetSpeed).toBe(0)
  })

  it('stops the vehicle before the junction, not at the road midpoint', () => {
    const net = buildNetwork({ junctionS: 20, length: 100 })
    const v = addVehicle(net, 'v-1', 0, 12, 0)
    run(net, 300)
    // It stopped near the projected stop line (12), roughly 4 m before
    // it (STOP_LINE_BUFFER) — and 30 m earlier than the old midpoint
    // assumption (42) would have stopped it.
    expect(v.s).toBeLessThan(12)
    expect(v.s).toBeGreaterThan(12 - 8)
    expect(v.speed).toBe(0)
    expect(v.s).toBeLessThan(20) // never inside the junction
  })

  it('runs a backward vehicle up to the junction and stops it there', () => {
    const net = buildNetwork({ junctionS: 20, length: 100 })
    // Lane 2 travels towards a SMALLER s, so it starts high on the road.
    const v = addVehicle(net, 'v-1', 60, 12, 2)
    run(net, 300)
    // It stopped just before the backward stop line (28) — a backward
    // lane approaches the junction from a LARGER s, so it halts above
    // the line, never inside the junction (centre at s = 20).
    expect(v.s).toBeGreaterThan(28)
    expect(v.s).toBeLessThan(28 + 8)
    expect(v.speed).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. Degradation: a junction that does not fit the road
// ---------------------------------------------------------------------------

describe('a junction that is off the road falls back to the midpoint', () => {
  it('uses the historical midpoint assumption', () => {
    const net = buildNetwork({ junctionS: 20, length: 100, junctionOffsetX: 300 })
    const v = addVehicle(net, 'v-1', 0, 0, 0)
    // The projected stop line would be nonsense; the fallback is 50 - 8.
    v.s = 42
    tick(net, DT, DT, makeCtx())
    expect(v.targetSpeed).toBe(0)
    v.s = 43
    tick(net, DT, 2 * DT, makeCtx())
    expect(v.targetSpeed).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 4. The car-following layer is untouched by the stop-line change
// ---------------------------------------------------------------------------

describe('car following is unaffected', () => {
  it('a follower still brakes for its leader', () => {
    const net = buildNetwork({ junctionS: 20, length: 100, phase: LightPhase.Green })
    const leader = addVehicle(net, 'v-leader', 40, 0, 0)
    const follower = addVehicle(net, 'v-follower', 30, 10, 0)
    tick(net, DT, DT, makeCtx())
    expect(follower.targetSpeed).toBe(0)
    expect(follower.targetSpeed).toBeLessThan(leader.targetSpeed)
  })

  it('a follower with a clear gap keeps its speed', () => {
    const net = buildNetwork({ junctionS: 20, length: 100, phase: LightPhase.Green })
    addVehicle(net, 'v-leader', 80, 0, 0)
    const follower = addVehicle(net, 'v-follower', 30, 10, 0)
    tick(net, DT, DT, makeCtx())
    expect(follower.targetSpeed).toBe(16.67)
  })
})
