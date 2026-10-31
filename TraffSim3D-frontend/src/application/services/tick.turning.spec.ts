// src/application/services/tick.turning.spec.ts
//
// The junction turn: a vehicle that runs past the end of its lane
// continues onto the road that meets it there, instead of being
// teleported back to the other end of its own road.
//
// ## What was wrong
//
// The travel end of a lane used to be a **wrap point**: the vehicle
// re-entered the same lane from the other end of the same road. The
// road network is a graph — `Intersection.connectedRoads` says which
// roads meet where — and the wrap threw the graph away.
//
// Measured on the real imported OSM city (391 roads / 450 junctions,
// 8 cars, 90 s): 43 200 vehicle-frames produced **0 road changes**. The
// city was fully drawn and the traffic never travelled it: every car
// looped on its own way.
//
// ## What the rules are
//
//   1. A junction at the travel END of the road → the vehicle turns
//      onto one of the junction's other roads.
//   2. A junction in the MIDDLE of the road → the vehicle keeps
//      driving on the same road (the cross scene's case). This is the
//      regression guard: the cross scene must behave exactly as before.
//   3. No junction at the travel end → the historical wrap, unchanged.
//
// The turn picks the candidate whose travel direction best continues
// the vehicle's heading; a tie goes to the lexicographically smaller
// road id, so the simulation stays reproducible.
//
// The file uses the REAL Rapier WASM (`importOriginal` bypasses the
// global no-op stub in `tests/setup.ts`) for the physics path: the
// turn's body handling (teleport + re-orient + re-apply the speed) is
// a property of the solver, so a fake solver would test the fake.

import { buildGridNetwork } from './defaultScene'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@dimforge/rapier3d-compat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dimforge/rapier3d-compat')>()
  return actual
})

const { RapierWorld } = await import('@infrastructure/physics')
const { buildRigidBodySpec } = await import('@infrastructure/physics/RapierBodySpec')
const { tick } = await import('./tick')
const { buildRectangularLoopNetwork } = await import('./defaultScene')
const { lanePoint, laneOffset, roadLength } = await import('@domain/services/laneGeometry')
const { roadContinuation } = await import('@domain/services/roadTransition')
const { junctionRadius } = await import('@domain/services/junctionRadius')
const { createRoadNetwork } = await import('@domain/entities/RoadNetwork')
const { LaneId } = await import('@domain/value-objects/LaneId')
const { clearOobEvents, getOobEvents } = await import('./oobCleanup')
import type { TickContext } from './tick'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Road } from '@domain/entities/Road'
import type { Vehicle } from '@domain/entities/Vehicle'

const DT = 1 / 60

const makeCtx = (rapierWorld: TickContext['rapierWorld']): TickContext => ({
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

// ---------------------------------------------------------------------------
// scene builders
// ---------------------------------------------------------------------------

const straight = (
  id: string,
  from: { x: number; z: number },
  to: { x: number; z: number },
  laneCount = 4,
): Road => ({
  id,
  startNode: { x: from.x, y: 0, z: from.z },
  endNode: { x: to.x, y: 0, z: to.z },
  laneCount,
  speedLimit: 16.67,
  level: 0,
})

/**
 * The junction sits at the travel END of `r-in`:
 *
 *   r-in        (0,0,0) ─────────▶ (0,0,100)
 *                                │
 *                            i-j (0,0,100)
 *                                │
 *   r-straight  (0,0,100) ───────▶ (0,0,200)     continues straight
 *   r-right     (0,0,100) ───────▶ (100,0,100)   turns right
 */
const buildEndJunctionNetwork = (): RoadNetwork => {
  const net = createRoadNetwork()
  net.roads['r-in'] = straight('r-in', { x: 0, z: 0 }, { x: 0, z: 100 })
  net.roads['r-straight'] = straight('r-straight', { x: 0, z: 100 }, { x: 0, z: 200 })
  net.roads['r-right'] = straight('r-right', { x: 0, z: 100 }, { x: 100, z: 100 })
  net.intersections['i-j'] = {
    id: 'i-j',
    position: { x: 0, y: 0, z: 100 },
    trafficLights: [],
    connectedRoads: ['r-in', 'r-straight', 'r-right'],
    intersectionRadius: junctionRadius(4),
  }
  return net
}

/**
 * The junction sits in the MIDDLE of both roads — the cross scene's
 * shape. A vehicle passes through it and stays on its own road.
 */
const buildMiddleJunctionNetwork = (): RoadNetwork => {
  const net = createRoadNetwork()
  net.roads['r-ns'] = straight('r-ns', { x: 0, z: -100 }, { x: 0, z: 100 })
  net.roads['r-ew'] = straight('r-ew', { x: -100, z: 0 }, { x: 100, z: 0 })
  net.intersections['i-center'] = {
    id: 'i-center',
    position: { x: 0, y: 0, z: 0 },
    trafficLights: [],
    connectedRoads: ['r-ns', 'r-ew'],
    intersectionRadius: junctionRadius(4),
  }
  return net
}

/** A road with no junction at all. */
const buildLonelyRoadNetwork = (): RoadNetwork => {
  const net = createRoadNetwork()
  net.roads['r-lonely'] = straight('r-lonely', { x: 0, z: 0 }, { x: 0, z: 100 })
  return net
}

/**
 * Two candidates, both 90° away from the vehicle's heading — a tie.
 * The tie must go to the lexicographically smaller road id.
 */
const buildTieNetwork = (): RoadNetwork => {
  const net = createRoadNetwork()
  net.roads['r-in'] = straight('r-in', { x: 0, z: 0 }, { x: 0, z: 100 })
  net.roads['r-next'] = straight('r-next', { x: 0, z: 100 }, { x: 100, z: 100 })
  net.roads['r-side'] = straight('r-side', { x: 0, z: 100 }, { x: -100, z: 100 })
  net.intersections['i-j'] = {
    id: 'i-j',
    position: { x: 0, y: 0, z: 100 },
    trafficLights: [],
    connectedRoads: ['r-in', 'r-next', 'r-side'],
    intersectionRadius: junctionRadius(4),
  }
  return net
}

/**
 * The junction sits at the travel end of a **backward** lane — that is
 * at the road's START (a backward lane runs end → start, so its travel
 * end is `s = 0`):
 *
 *   r-out   (0,0,-100) ──────▶ (0,0,0)      the junction is at its END
 *            │
 *         i-j (0,0,0)
 *            │
 *   r-in    (0,0,0) ─────────▶ (0,0,100)    the junction is at its START
 *
 * The vehicle therefore enters `r-out` at its end and drives backward
 * on it — the keep-right BACKWARD lane (`laneCount - 1`).
 */
const buildBackwardJunctionNetwork = (): RoadNetwork => {
  const net = createRoadNetwork()
  net.roads['r-in'] = straight('r-in', { x: 0, z: 0 }, { x: 0, z: 100 })
  net.roads['r-out'] = straight('r-out', { x: 0, z: -100 }, { x: 0, z: 0 })
  net.intersections['i-j'] = {
    id: 'i-j',
    position: { x: 0, y: 0, z: 0 },
    trafficLights: [],
    connectedRoads: ['r-in', 'r-out'],
    intersectionRadius: junctionRadius(4),
  }
  return net
}

const addVehicle = (
  net: RoadNetwork,
  id: string,
  roadId: string,
  laneIndex: number,
  s: number,
  speed: number,
): Vehicle => {
  const road = net.roads[roadId]!
  const lp = lanePoint(road, laneIndex, s)
  const v: Vehicle = {
    id,
    type: 'car',
    color: '#3a86ff',
    position: { ...lp.position },
    heading: lp.heading,
    speed,
    targetSpeed: road.speedLimit,
    roadId,
    laneIndex,
    s,
    lane: LaneId.make(roadId, laneIndex),
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

// ---------------------------------------------------------------------------
// runners
// ---------------------------------------------------------------------------

/** One frame of the physics-free path. */
const stepFallback = (net: RoadNetwork, ctx: TickContext, t: number): void => {
  tick(net, DT, t, ctx)
}

const runFallback = (net: RoadNetwork, steps: number): void => {
  const ctx = makeCtx(null)
  for (let i = 0; i < steps; i++) stepFallback(net, ctx, (i + 1) * DT)
}

/**
 * Run the physics-free path until the vehicle changes road, and return
 * the state of the frame in which the turn happened (-1 when it never
 * did).
 */
const runFallbackUntilTurn = (
  net: RoadNetwork,
  v: Vehicle,
  steps: number,
): { frame: Frame; index: number } | null => {
  const ctx = makeCtx(null)
  for (let i = 0; i < steps; i++) {
    const before = v.roadId
    stepFallback(net, ctx, (i + 1) * DT)
    if (v.roadId === before) continue
    return {
      frame: {
        roadId: v.roadId,
        laneIndex: v.laneIndex,
        s: v.s,
        speed: v.speed,
        heading: v.heading,
        x: v.position.x,
        z: v.position.z,
      },
      index: i,
    }
  }
  return null
}

interface Frame {
  roadId: string
  laneIndex: number
  s: number
  speed: number
  heading: number
  x: number
  z: number
}

/** Run the physics path and record what the vehicle looked like each frame. */
const runPhysics = async (
  net: RoadNetwork,
  steps: number,
  watchId: string,
): Promise<{ frames: Frame[]; world: InstanceType<typeof RapierWorld> }> => {
  const world = new RapierWorld()
  await world.init()
  for (const v of Object.values(net.vehicles)) {
    world.registerVehicle(buildRigidBodySpec(v.id, v.type, v.position, v.heading))
  }
  const ctx = makeCtx(world)
  const frames: Frame[] = []
  for (let i = 0; i < steps; i++) {
    tick(net, DT, (i + 1) * DT, ctx)
    const v = net.vehicles[watchId]
    if (!v) continue
    frames.push({
      roadId: v.roadId,
      laneIndex: v.laneIndex,
      s: v.s,
      speed: v.speed,
      heading: v.heading,
      x: v.position.x,
      z: v.position.z,
    })
  }
  return { frames, world }
}

/** The frame index at which the vehicle changed road (-1 when it never did). */
const roadChangeFrame = (frames: Frame[]): number =>
  frames.findIndex((f, k) => k > 0 && f.roadId !== frames[k - 1]!.roadId)

// ---------------------------------------------------------------------------
// 0. the pivot-to-arc headline metric: overlap frames on the grid
// ---------------------------------------------------------------------------
//
// The pivot measured **5 frames of overlap in 135 000 vehicle frames**
// (0.0037 %, worst 0.271 m) on a 90 s run of the shipped 5 x 5 grid:
// a turning body teleported across the junction corner and a follower
// drove into that corner. The arc removes the teleport, and with it
// the sweep - this is the before/after measurement, on the REAL
// physics path (a body that overlaps gets crashed by Rapier, exactly
// as it did when the pivot's number was taken).

describe('the grid under the arc turn model (real physics)', () => {
  beforeEach(() => {
    clearOobEvents()
  })

  it('runs 90 s without an overlapping pair of bodies', async () => {
    const net = buildGridNetwork()
    const world = new RapierWorld()
    await world.init()
    for (const v of Object.values(net.vehicles)) {
      world.registerVehicle(buildRigidBodySpec(v.id, v.type, v.position, v.heading))
    }
    const ctx = makeCtx(world)
    const steps = Math.round(90 / DT)
    let overlapFrames = 0
    let worst = 0
    for (let i = 0; i < steps; i += 1) {
      tick(net, DT, (i + 1) * DT, ctx)
      const vehicles = Object.values(net.vehicles)
      for (let a = 0; a < vehicles.length; a += 1) {
        for (let b = a + 1; b < vehicles.length; b += 1) {
          const va = vehicles[a]!
          const vb = vehicles[b]!
          const distance = Math.hypot(
            va.position.x - vb.position.x,
            va.position.z - vb.position.z,
          )
          if (distance < 2.5) {
            overlapFrames += 1
            worst = Math.max(worst, 2.5 - distance)
          }
        }
      }
    }
    expect(
      overlapFrames,
      'worst overlap ' + worst.toFixed(3) + ' m over ' + steps + ' frames',
    ).toBe(0)
  }, 600_000)
})

// ---------------------------------------------------------------------------
// 1. the turn itself (physics-free path)
// ---------------------------------------------------------------------------

describe('a vehicle that runs past the end of its lane turns at the junction', () => {
  beforeEach(() => {
    clearOobEvents()
  })

  it('continues onto the road that meets it at the junction', () => {
    const net = buildEndJunctionNetwork()
    const v = addVehicle(net, 'v-1', 'r-in', 0, 90, 10)
    runFallback(net, 120)
    // The road changed — the vehicle did NOT wrap back onto r-in.
    expect(v.roadId).not.toBe('r-in')
    // It continued STRAIGHT: r-straight's entry heading is the same
    // direction it was already driving in, r-right's is 90° away.
    expect(v.roadId).toBe('r-straight')
  })

  it('ends up on a lane of the NEW road, at the junction', () => {
    const net = buildEndJunctionNetwork()
    const v = addVehicle(net, 'v-1', 'r-in', 0, 90, 10)
    const turn = runFallbackUntilTurn(net, v, 120)
    expect(turn).not.toBeNull()
    const newRoad = net.roads[turn!.frame.roadId]!
    expect(newRoad).toBeDefined()
    expect(turn!.frame.laneIndex).toBeGreaterThanOrEqual(0)
    expect(turn!.frame.laneIndex).toBeLessThan(newRoad.laneCount)
    // The entry is at the junction: the arc length is the new road's
    // start, and the lane point sits exactly one lane offset away from
    // the junction (the keep-right lane of the new road).
    expect(turn!.frame.s).toBe(0)
    const entry = lanePoint(newRoad, turn!.frame.laneIndex, turn!.frame.s)
    const fromJunction = Math.hypot(entry.position.x - 0, entry.position.z - 100)
    expect(fromJunction).toBeCloseTo(laneOffset(turn!.frame.laneIndex, newRoad.laneCount), 6)
    // … and the vehicle body sits on that lane point.
    expect(
      Math.hypot(turn!.frame.x - entry.position.x, turn!.frame.z - entry.position.z),
    ).toBeLessThan(0.5)
  })

  it('keeps its speed through the turn', () => {
    const net = buildEndJunctionNetwork()
    const v = addVehicle(net, 'v-1', 'r-in', 0, 90, 10)
    const ctx = makeCtx(null)
    let speedBefore = v.speed
    for (let i = 0; i < 120; i++) {
      const before = v.roadId
      speedBefore = v.speed
      stepFallback(net, ctx, (i + 1) * DT)
      if (v.roadId !== before) break
    }
    expect(v.roadId).toBe('r-straight')
    // The turn is a pivot, not a stop: the speed is carried over.
    expect(v.speed).toBeGreaterThan(0.5)
    expect(v.speed).toBeGreaterThanOrEqual(speedBefore - 0.05)
  })

  it('prefers the road that continues straight over the one that turns', () => {
    const net = buildEndJunctionNetwork()
    const v = addVehicle(net, 'v-1', 'r-in', 0, 90, 10)
    runFallback(net, 120)
    expect(v.roadId).toBe('r-straight')
  })

  it('breaks a tie between two equally good candidates by road id', () => {
    const net = buildTieNetwork()
    const v = addVehicle(net, 'v-1', 'r-in', 0, 90, 10)
    runFallback(net, 120)
    // r-next and r-side are both 90° away from the vehicle's heading.
    expect(v.roadId).toBe('r-next')
    // … and the same input gives the same output every time.
    const again = buildTieNetwork()
    const v2 = addVehicle(again, 'v-1', 'r-in', 0, 90, 10)
    runFallback(again, 120)
    expect(v2.roadId).toBe(v.roadId)
  })

  it('never turns back onto the road it came from', () => {
    const net = buildEndJunctionNetwork()
    const v = addVehicle(net, 'v-1', 'r-in', 0, 90, 10)
    runFallback(net, 120)
    expect(v.roadId).not.toBe('r-in')
  })

  it('turns a BACKWARD lane onto the keep-right backward lane of the new road', () => {
    const net = buildBackwardJunctionNetwork()
    // Lane 3 of a 4-lane road is the rightmost BACKWARD lane: it runs
    // end → start, so its travel end is s = 0 — where the junction is.
    const v = addVehicle(net, 'v-1', 'r-in', 3, 20, 10)
    const turn = runFallbackUntilTurn(net, v, 240)
    expect(turn).not.toBeNull()
    expect(turn!.frame.roadId).toBe('r-out')
    // The new road is entered at its END and driven backward, on the
    // keep-right backward lane.
    expect(turn!.frame.laneIndex).toBe(net.roads['r-out']!.laneCount - 1)
    expect(turn!.frame.s).toBeCloseTo(roadLength(net.roads['r-out']!), 6)
  })
})

// ---------------------------------------------------------------------------
// 2. the cases that must NOT turn
// ---------------------------------------------------------------------------

describe('a vehicle keeps driving on its own road when there is no junction at the travel end', () => {
  beforeEach(() => {
    clearOobEvents()
  })

  it('keeps the same road when the junction is in the MIDDLE of it (the cross scene)', () => {
    const net = buildMiddleJunctionNetwork()
    const v = addVehicle(net, 'v-1', 'r-ns', 0, 90, 10)
    runFallback(net, 120)
    // The junction sits at s = 50 of a 200 m road — it is not at the
    // travel end, so the vehicle wraps onto its own road as before.
    expect(v.roadId).toBe('r-ns')
    expect(v.laneIndex).toBe(0)
    expect(v.s).toBeGreaterThanOrEqual(0)
    expect(v.s).toBeLessThan(roadLength(net.roads['r-ns']!))
  })

  it('keeps the same road on a road with no junction at all', () => {
    const net = buildLonelyRoadNetwork()
    const v = addVehicle(net, 'v-1', 'r-lonely', 0, 90, 10)
    runFallback(net, 120)
    expect(v.roadId).toBe('r-lonely')
    expect(v.laneIndex).toBe(0)
    expect(v.s).toBeGreaterThanOrEqual(0)
    expect(v.s).toBeLessThan(roadLength(net.roads['r-lonely']!))
  })

  it('wraps the same way as before: the arc length stays inside the road', () => {
    const net = buildLonelyRoadNetwork()
    const len = roadLength(net.roads['r-lonely']!)
    const v = addVehicle(net, 'v-1', 'r-lonely', 0, 90, 10)
    let seen = false
    for (let i = 0; i < 120; i++) {
      const before = v.s
      runFallback(net, 1)
      if (v.s < before) {
        // The wrap: s -= len, exactly as the historical rule does.
        expect(before - v.s).toBeGreaterThan(len - 1)
        expect(before - v.s).toBeLessThan(len + 1)
        seen = true
        break
      }
    }
    expect(seen).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. the physics path
// ---------------------------------------------------------------------------

describe('the physics path turns at the junction too', () => {
  beforeEach(() => {
    clearOobEvents()
  })

  it('moves the body onto the new road and keeps its speed', async () => {
    const net = buildEndJunctionNetwork()
    addVehicle(net, 'v-1', 'r-in', 0, 90, 10)
    const { frames, world } = await runPhysics(net, 240, 'v-1')
    const changeAt = roadChangeFrame(frames)
    expect(changeAt).toBeGreaterThan(0)
    expect(frames[changeAt]!.roadId).toBe('r-straight')
    // The speed is carried over the turn — the vehicle does not stop.
    // (pivot→arc: mid-turn the BODY is a passenger on the arc — its
    // linvel is zero and the arc drags it — so the speed that matters
    // is the entity's, which the ramp keeps feeding.)
    expect(frames[changeAt]!.speed).toBeGreaterThan(0.5)
    expect(frames[changeAt - 1]!.speed).toBeGreaterThan(0.5)
    // Once the arc is done, the body moves under its own velocity again.
    const pose = world.readPose('v-1')
    expect(pose).not.toBeNull()
    expect(frames[frames.length - 1]!.speed).toBeGreaterThan(0.5)
  })

  it('does not fire the lane guard because of the turn', async () => {
    const net = buildEndJunctionNetwork()
    addVehicle(net, 'v-1', 'r-in', 0, 90, 10)
    await runPhysics(net, 240, 'v-1')
    const guards = getOobEvents().filter(
      (e) => e.kind === 'lane-guard' || e.kind === 'lateral-guard',
    )
    expect(guards.map((g) => g.reason)).toEqual([])
  })

  it('keeps the same road when the junction is in the middle of it', async () => {
    const net = buildMiddleJunctionNetwork()
    addVehicle(net, 'v-1', 'r-ns', 0, 90, 10)
    const { frames } = await runPhysics(net, 240, 'v-1')
    expect(roadChangeFrame(frames)).toBe(-1)
    expect(frames.every((f) => f.roadId === 'r-ns')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. the rectangular-loop scene circulates
// ---------------------------------------------------------------------------

describe('the rectangular-loop scene circulates', () => {
  beforeEach(() => {
    clearOobEvents()
  })

  it('carries a vehicle around all four loop roads', () => {
    const net = buildRectangularLoopNetwork()
    // One vehicle of our own; the scene's eight default cars would only
    // add traffic noise to the test.
    for (const id of Object.keys(net.vehicles)) delete net.vehicles[id]
    const road = net.roads['r-loop-0']!
    const len = roadLength(road)
    const v = addVehicle(net, 'v-loop', 'r-loop-0', 0, len - 20, 7)

    const visited: string[] = []
    const ctx = makeCtx(null)
    // The loop's corners are signalised, so the vehicle waits for the
    // green at every one of them — a full circuit takes minutes of
    // simulation time, not seconds.
    for (let i = 0; i < 36000; i++) {
      stepFallback(net, ctx, (i + 1) * DT)
      const last = visited[visited.length - 1]
      if (last !== v.roadId) visited.push(v.roadId)
      if (visited.length >= 5) break
    }
    // The loop's four roads, in order, and back to the first one.
    expect(visited.slice(0, 4)).toEqual(['r-loop-0', 'r-loop-1', 'r-loop-2', 'r-loop-3'])
    expect(visited[4]).toBe('r-loop-0')
  })
})

// ---------------------------------------------------------------------------
// 5. the pure domain function
// ---------------------------------------------------------------------------

describe('roadContinuation — the pure geometry of the turn', () => {
  it('returns null when the junction is in the middle of the road', () => {
    const net = buildMiddleJunctionNetwork()
    const road = net.roads['r-ns']!
    expect(roadContinuation(net, road, 0, Math.PI / 2)).toBeNull()
  })

  it('returns null when there is no junction at the travel end', () => {
    const net = buildLonelyRoadNetwork()
    const road = net.roads['r-lonely']!
    expect(roadContinuation(net, road, 0, Math.PI / 2)).toBeNull()
  })

  it('returns the keep-right lane and the entry arc length of the new road', () => {
    const net = buildEndJunctionNetwork()
    const road = net.roads['r-in']!
    const turn = roadContinuation(net, road, 0, Math.PI / 2)
    expect(turn).not.toBeNull()
    expect(turn!.roadId).toBe('r-straight')
    expect(turn!.laneIndex).toBe(0)
    expect(turn!.s).toBe(0)
    expect(turn!.heading).toBeCloseTo(Math.PI / 2, 6)
  })

  it('is deterministic: the same input gives the same continuation', () => {
    const net = buildTieNetwork()
    const road = net.roads['r-in']!
    const a = roadContinuation(net, road, 0, Math.PI / 2)
    const b = roadContinuation(net, road, 0, Math.PI / 2)
    expect(a).toEqual(b)
  })
})
