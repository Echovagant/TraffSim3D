// src/application/services/tick.physics.spec.ts
//
// The physics-backed behaviours of the tick, measured end to end.
//
// The fake Rapier module below is *behavioural*: it integrates the
// bodies (position += linvel · timestep, yaw += ω · timestep), so the
// distances, the lane changes and the frame-rate numbers in this file
// are the numbers the simulation actually produces — not assertions
// about call counts.
//
// What is pinned here:
//   1. F4 — the distance a vehicle covers in one wall-clock second is
//      the same at 15, 30, 60 and 120 fps.
//   2. The lane change really moves the vehicle into the target lane
//      and converges.
//   3. A vehicle spawned at s = 0 drives away instead of deadlocking.
//   4. The red light holds a vehicle at the stop line.
//   5. The acceleration / deceleration ramp is applied.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// The behavioural fake of the Rapier WASM module.
// ---------------------------------------------------------------------------

const R = vi.hoisted(() => {
  type Vec = { x: number; y: number; z: number }
  type Quat = { x: number; y: number; z: number; w: number }

  const state = {
    bodies: new Map<number, any>(),
    nextHandle: 0,
    colliders: [] as any[],
    stepCalls: 0,
    timestep: 0,
  }

  const makeBodyDesc = (kind: string) => {
    const rec: any = {
      kind,
      translation: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    }
    rec.setTranslation = (x: number, y: number, z: number) => {
      rec.translation = { x, y, z }
      return rec
    }
    rec.setRotation = (q: Quat) => {
      rec.rotation = q
      return rec
    }
    rec.setLinearDamping = () => rec
    rec.setAngularDamping = () => rec
    return rec
  }

  const makeColliderDesc = (hx: number, hy: number, hz: number) => {
    const rec: any = { halfExtents: { x: hx, y: hy, z: hz } }
    rec.setMass = () => rec
    rec.setFriction = () => rec
    rec.setFrictionCombineRule = () => rec
    rec.setRestitution = () => rec
    return rec
  }

  /** Hamilton product (the order Rapier uses: x, y, z, w). */
  const qMul = (a: Quat, b: Quat): Quat => ({
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  })

  class FakeWorld {
    timestep = 0
    constructor(_gravity: Vec) {}
    createRigidBody(desc: any) {
      const handle = state.nextHandle++
      const body: any = {
        handle,
        desc,
        _t: { ...desc.translation },
        _r: { ...desc.rotation },
        _lv: { x: 0, y: 0, z: 0 },
        _av: { x: 0, y: 0, z: 0 },
        removed: false,
        translation() {
          return { ...this._t }
        },
        rotation() {
          return { ...this._r }
        },
        linvel() {
          return { ...this._lv }
        },
        angvel() {
          return { ...this._av }
        },
        setTranslation(t: Vec, _wake: boolean) {
          this._t = { x: t.x, y: t.y, z: t.z }
        },
        setRotation(q: Quat, _wake: boolean) {
          this._r = { x: q.x, y: q.y, z: q.z, w: q.w }
        },
        setLinvel(v: Vec, _wake: boolean) {
          this._lv = { x: v.x, y: v.y, z: v.z }
        },
        setAngvel(v: Vec, _wake: boolean) {
          this._av = { x: v.x, y: v.y, z: v.z }
        },
      }
      state.bodies.set(handle, body)
      return body
    }
    createCollider(desc: any, _body: any) {
      const handle = 1000 + state.colliders.length
      state.colliders.push({ handle, desc })
      return { handle }
    }
    getRigidBody(handle: number) {
      const b = state.bodies.get(handle)
      return b && !b.removed ? b : null
    }
    removeRigidBody(body: any) {
      body.removed = true
      state.bodies.delete(body.handle)
    }
    /** The integration the real solver does. */
    step(_eq: unknown) {
      state.stepCalls += 1
      state.timestep = this.timestep
      const dt = this.timestep
      for (const body of state.bodies.values()) {
        if (body.desc.kind === 'fixed') continue
        body._t.x += body._lv.x * dt
        body._t.z += body._lv.z * dt
        const omega = body._av.y
        if (omega !== 0) {
          const half = (omega * dt) / 2
          body._r = qMul(body._r, { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) })
          const n = Math.hypot(body._r.x, body._r.y, body._r.z, body._r.w)
          body._r = { x: body._r.x / n, y: body._r.y / n, z: body._r.z / n, w: body._r.w / n }
        }
      }
    }
    castRay() {
      return undefined
    }
    free() {}
  }

  class FakeEventQueue {
    constructor(_autoDrain: boolean) {}
    drainCollisionEvents(_cb: (h1: number, h2: number, started: boolean) => void) {}
  }

  class FakeRay {
    constructor(_origin: Vec, _dir: Vec) {}
    pointAt() {
      return { x: 0, y: 0, z: 0 }
    }
  }

  return { state, makeBodyDesc, makeColliderDesc, FakeWorld, FakeEventQueue, FakeRay }
})

vi.mock('@dimforge/rapier3d-compat', () => ({
  default: {},
  init: vi.fn().mockResolvedValue(undefined),
  World: R.FakeWorld,
  EventQueue: R.FakeEventQueue,
  RigidBodyDesc: {
    dynamic: () => R.makeBodyDesc('dynamic'),
    fixed: () => R.makeBodyDesc('fixed'),
  },
  ColliderDesc: { cuboid: R.makeColliderDesc },
  Ray: R.FakeRay,
  // The ground's friction combine rule (see `RapierWorld.buildGround`).
  CoefficientCombineRule: { Average: 0, Min: 1, Multiply: 2, Max: 3 },
}))

const { RapierWorld, buildRigidBodySpec } = await import('@infrastructure/physics')
const { tick } = await import('./tick')
const { spawnVehicle } = await import('./spawnVehicle')
const { createRoadNetwork } = await import('@domain/entities/RoadNetwork')
const { LaneId } = await import('@domain/value-objects/LaneId')
const { LightPhase } = await import('@domain/value-objects/Phase')
const { laneOffset, lanePoint, laneForwardSign, roadForward, roadLength } = await import(
  '@domain/services/laneGeometry'
)
const { perpendicularOffsetAlongRoad } = await import('@domain/services/laneChange')
const { VEHICLE_DYN } = await import('@shared/constants/simulation')
const { buildCrossIntersectionNetwork } = await import('./defaultScene')
import type { TickContext } from './tick'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Road } from '@domain/entities/Road'
import type { Vehicle } from '@domain/entities/Vehicle'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROAD_LEN = 200
const LANE_COUNT = 4

interface NetOptions {
  /** Put a red light at the middle of the road. */
  redLight?: boolean
  /** Register a spawn point at s = 0 on lane 0. */
  spawnAtZero?: boolean
}

/** A straight north-south road (along +Z) with `LANE_COUNT` lanes. */
const buildRoad = (opts: NetOptions = {}): RoadNetwork => {
  const net = createRoadNetwork()
  net.roads['r-1'] = {
    id: 'r-1',
    startNode: { x: 0, y: 0, z: 0 },
    endNode: { x: 0, y: 0, z: ROAD_LEN },
    laneCount: LANE_COUNT,
    speedLimit: 16.67,
    level: 0,
  }
  if (opts.redLight) {
    net.intersections['i-1'] = {
      id: 'i-1',
      position: { x: 0, y: 0, z: ROAD_LEN / 2 },
      connectedRoads: ['r-1'],
      trafficLights: [
        {
          id: 'tl-1',
          position: { x: 0, y: 0, z: ROAD_LEN / 2 },
          phase: LightPhase.Red,
          phaseRemaining: 30,
          cycleSeconds: 63,
          axis: 'ns',
        },
      ],
      intersectionRadius: 8,
    }
  }
  if (opts.spawnAtZero) {
    net.spawnPoints['sp-1'] = {
      id: 'sp-1',
      roadId: 'r-1',
      laneIndex: 0,
      s: 0,
      occupiedBy: null,
    }
  }
  return net
}

/** Put a vehicle on lane 0 of the test road at arc-length `s`. */
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

const makeCtx = (overrides: Partial<TickContext> = {}): TickContext => ({
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
  ...overrides,
})

/** Run `seconds` of wall clock at `fps`, driving the tick. */
const run = (
  net: RoadNetwork,
  ctx: TickContext,
  seconds: number,
  fps: number,
  onTick?: (simTime: number) => void,
): number => {
  const dt = 1 / fps
  const frames = Math.round(seconds * fps)
  let simTime = 0
  for (let i = 0; i < frames; i++) {
    simTime += dt
    tick(net, dt, simTime, ctx)
    onTick?.(simTime)
  }
  return simTime
}

beforeEach(() => {
  R.state.bodies.clear()
  R.state.colliders.length = 0
  R.state.nextHandle = 0
  R.state.stepCalls = 0
  R.state.timestep = 0
})

// ---------------------------------------------------------------------------
// 1. F4 — the simulation speed must not depend on the frame rate
// ---------------------------------------------------------------------------

describe('F4 — the distance covered per wall-clock second is frame-rate independent', () => {
  const measure = async (fps: number): Promise<number> => {
    const world = new RapierWorld()
    await world.init()
    const net = buildRoad()
    const v = addVehicle(net, 'v-1', 10, 0)
    world.registerVehicle(buildRigidBodySpec(v.id, v.type, v.position, v.heading))
    const ctx = makeCtx({ rapierWorld: world })
    // The tick rewrites `v.position` from the physics pose, so the
    // start point has to be captured before the run.
    const start = { x: v.position.x, z: v.position.z }
    // One wall-clock second.
    run(net, ctx, 1, fps)
    const pose = world.readPose('v-1')!
    return Math.hypot(pose.position.x - start.x, pose.position.z - start.z)
  }

  it('covers the same distance at 15 / 30 / 60 / 120 fps (within ±10 %)', async () => {
    const results: Array<[number, number]> = []
    for (const fps of [15, 30, 60, 120]) {
      results.push([fps, await measure(fps)])
    }

    console.log(
      '[F4] distance covered in 1 wall-clock second:',
      results.map(([fps, d]) => `${fps} fps → ${d.toFixed(3)} m`).join(' | '),
    )
    const distances = results.map(([, d]) => d)
    const mean = distances.reduce((a, b) => a + b, 0) / distances.length
    for (const [fps, d] of results) {
      expect(Math.abs(d - mean) / mean, `${fps} fps → ${d} m vs mean ${mean} m`).toBeLessThan(0.1)
    }
  })

  it('the physics runs the same number of fixed sub-steps per wall-clock second', async () => {
    const counts: Array<[number, number]> = []
    for (const fps of [15, 30, 60, 120]) {
      const world = new RapierWorld()
      await world.init()
      const net = buildRoad()
      const v = addVehicle(net, 'v-1', 10, 0)
      world.registerVehicle(buildRigidBodySpec(v.id, v.type, v.position, v.heading))
      const ctx = makeCtx({ rapierWorld: world })
      R.state.stepCalls = 0
      run(net, ctx, 1, fps)
      counts.push([fps, R.state.stepCalls])
    }

    console.log('[F4] physics sub-steps per wall-clock second:', JSON.stringify(counts))
    // 60 fixed steps per second at every frame rate.
    for (const [fps, n] of counts) {
      expect(n, `${fps} fps`).toBe(60)
    }
  })

  it('the "2× speed" control speeds the vehicles up, not only the lights', async () => {
    const measure = async (
      rate: number,
      seconds: number,
    ): Promise<{ distance: number; lightElapsed: number }> => {
      const world = new RapierWorld()
      await world.init()
      const net = buildRoad({ redLight: true })
      const v = addVehicle(net, 'v-1', 10, 0)
      world.registerVehicle(buildRigidBodySpec(v.id, v.type, v.position, v.heading))
      const ctx = makeCtx({ rapierWorld: world })
      // The renderer multiplies the wall-clock dt by the rate; the store
      // then clamps it.
      const dt = (1 / 60) * rate
      const start = { x: v.position.x, z: v.position.z }
      const light = net.intersections['i-1']!.trafficLights[0]!
      const lightStart = light.phaseRemaining
      let simTime = 0
      const frames = Math.round(seconds * 60)
      for (let i = 0; i < frames; i++) {
        simTime += dt
        tick(net, dt, simTime, ctx)
      }
      const pose = world.readPose('v-1')!
      return {
        distance: Math.hypot(pose.position.x - start.x, pose.position.z - start.z),
        lightElapsed: lightStart - light.phaseRemaining,
      }
    }

    // One wall-clock second at 2× == two wall-clock seconds at 1×.
    const at2x = await measure(2, 1)
    const at1xTwoSeconds = await measure(1, 2)

    console.log(
      `[F4] 2× for 1 s → ${at2x.distance.toFixed(3)} m (light ${at2x.lightElapsed.toFixed(2)} s) | ` +
        `1× for 2 s → ${at1xTwoSeconds.distance.toFixed(3)} m (light ${at1xTwoSeconds.lightElapsed.toFixed(2)} s)`,
    )
    expect(at2x.distance).toBeCloseTo(at1xTwoSeconds.distance, 1)
    // (The residual is the Euler discretisation of the acceleration:
    // 4.067 m vs 4.033 m — 0.8 %, not a rate mismatch.)
    // The light burns exactly as much time as the vehicles get.
    expect(at2x.lightElapsed).toBeCloseTo(2, 6)
    expect(at1xTwoSeconds.lightElapsed).toBeCloseTo(2, 6)
    expect(at2x.distance).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 2. The lane change
// ---------------------------------------------------------------------------

describe('the lane change moves the vehicle into the target lane', () => {
  it('converges: laneIndex becomes the target and the lateral offset drops below 0.3 m', async () => {
    const world = new RapierWorld()
    await world.init()
    const net = buildRoad()
    const v = addVehicle(net, 'v-1', 20, 10)
    world.registerVehicle(buildRigidBodySpec(v.id, v.type, v.position, v.heading))
    const ctx = makeCtx({ rapierWorld: world })

    // Request the change (what worldStore.requestLaneChange does).
    v.desiredLaneIndex = 1
    v.laneChangeStartedAt = 0

    const road = net.roads['r-1']!
    const targetLat = laneOffset(1, LANE_COUNT)
    let convergedAt: number | null = null
    const samples: Array<{ t: number; offset: number; lane: number }> = []
    run(net, ctx, 6, 60, (simTime) => {
      const offset = perpendicularOffsetAlongRoad(road, v.s, v.position) - targetLat
      samples.push({ t: simTime, offset, lane: v.laneIndex })
      if (convergedAt === null && Math.abs(offset) < 0.3) convergedAt = simTime
    })

    console.log(
      '[lane change] final laneIndex =',
      v.laneIndex,
      '| residual lateral offset =',
      perpendicularOffsetAlongRoad(road, v.s, v.position) - targetLat,
      '| converged at t =',
      convergedAt,
      's |',
      samples
        .filter((_, i) => i % 10 === 0)
        .map((s) => `t=${s.t.toFixed(2)} off=${s.offset.toFixed(2)}`)
        .join(' '),
    )

    expect(v.laneIndex).toBe(1)
    expect(v.desiredLaneIndex).toBeNull()
    const finalOffset = Math.abs(perpendicularOffsetAlongRoad(road, v.s, v.position) - targetLat)
    expect(finalOffset).toBeLessThan(0.3)
    expect(convergedAt).not.toBeNull()
    expect(convergedAt!).toBeLessThan(5)
  })

  it('the vehicle really moves sideways (the old implementation was a no-op)', async () => {
    const world = new RapierWorld()
    await world.init()
    const net = buildRoad()
    const v = addVehicle(net, 'v-1', 20, 10)
    world.registerVehicle(buildRigidBodySpec(v.id, v.type, v.position, v.heading))
    const ctx = makeCtx({ rapierWorld: world })
    const road = net.roads['r-1']!
    const startOffset = perpendicularOffsetAlongRoad(road, v.s, v.position)
    v.desiredLaneIndex = 1
    v.laneChangeStartedAt = 0
    run(net, ctx, 3, 60)
    const endOffset = perpendicularOffsetAlongRoad(road, v.s, v.position)
    // The offset moved by ~one lane width (3.5 m) towards the target.
    expect(startOffset - endOffset).toBeGreaterThan(3.0)
  })

  it('the physics-free fallback path converges too', () => {
    // No Rapier → the hand-rolled path, which blends the position from
    // the current lane to the target lane over the change's duration.
    const net = buildRoad()
    const v = addVehicle(net, 'v-1', 20, 10)
    const ctx = makeCtx()
    const road = net.roads['r-1']!
    const targetLat = laneOffset(1, LANE_COUNT)
    v.desiredLaneIndex = 1
    v.laneChangeStartedAt = 0
    run(net, ctx, 4, 60)

    console.log(
      '[lane change / no physics] final laneIndex =',
      v.laneIndex,
      '| residual lateral offset =',
      perpendicularOffsetAlongRoad(road, v.s, v.position) - targetLat,
    )
    expect(v.laneIndex).toBe(1)
    expect(v.desiredLaneIndex).toBeNull()
    expect(Math.abs(perpendicularOffsetAlongRoad(road, v.s, v.position) - targetLat)).toBeLessThan(
      0.3,
    )
  })
})

// ---------------------------------------------------------------------------
// 3. The s = 0 spawn point
// ---------------------------------------------------------------------------

describe('a vehicle spawned at s = 0 drives away', () => {
  it('accelerates and its arc-length grows (the old code deadlocked it at 0)', async () => {
    const world = new RapierWorld()
    await world.init()
    const net = buildRoad({ spawnAtZero: true })
    const res = spawnVehicle(net, 'v-1', { type: 'car', speed: 0 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const v = res.vehicle
    net.vehicles[v.id] = v
    world.registerVehicle(buildRigidBodySpec(v.id, v.type, v.position, v.heading))
    const ctx = makeCtx({ rapierWorld: world })

    const series: Array<{ t: number; s: number; speed: number }> = []
    run(net, ctx, 3, 60, (simTime) => {
      series.push({ t: simTime, s: v.s, speed: v.speed })
    })

    console.log(
      '[spawn s=0] series:',
      series
        .filter((_, i) => i % 30 === 0)
        .map((s) => `t=${s.t.toFixed(2)} s=${s.s.toFixed(2)} v=${s.speed.toFixed(2)}`)
        .join(' | '),
    )

    expect(v.speed).toBeGreaterThan(0)
    expect(v.s).toBeGreaterThan(0.5)
    // The speed grows monotonically (the accel ramp).
    for (let i = 1; i < series.length; i++) {
      expect(series[i]!.speed).toBeGreaterThanOrEqual(series[i - 1]!.speed - 1e-9)
    }
    // The spawn point is released once the vehicle has driven past it.
    run(net, ctx, 10, 60)
    expect(net.spawnPoints['sp-1']!.occupiedBy).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4. The red light
// ---------------------------------------------------------------------------

describe('the red light holds the vehicle at the stop line', () => {
  const stopLineS = ROAD_LEN / 2 - 8

  it('a vehicle approaching a red light stops before the stop line', async () => {
    const world = new RapierWorld()
    await world.init()
    const net = buildRoad({ redLight: true })
    const v = addVehicle(net, 'v-1', stopLineS - 40, 12)
    world.registerVehicle(buildRigidBodySpec(v.id, v.type, v.position, v.heading))
    const ctx = makeCtx({ rapierWorld: world })
    run(net, ctx, 6, 60)

    console.log(
      `[red light] final s = ${v.s.toFixed(2)} (stop line at ${stopLineS}), speed = ${v.speed.toFixed(2)}`,
    )
    expect(v.s).toBeLessThan(stopLineS)
    expect(v.speed).toBeLessThan(0.5)
  })

  it('a vehicle standing ON the stop line is held (it has not crossed it yet)', () => {
    const net = buildRoad({ redLight: true })
    const v = addVehicle(net, 'v-1', stopLineS, 0)
    const ctx = makeCtx()
    tick(net, 1 / 60, 1 / 60, ctx)
    expect(v.targetSpeed).toBe(0)
  })

  it('a vehicle that has crossed the stop line is committed and clears the intersection', () => {
    const net = buildRoad({ redLight: true })
    const v = addVehicle(net, 'v-1', stopLineS + 2, 8)
    const ctx = makeCtx()
    tick(net, 1 / 60, 1 / 60, ctx)
    // The red light no longer demands a stop — the vehicle is past the
    // stop line and has the right of way over the crossing traffic.
    expect(v.targetSpeed).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 5. The acceleration / deceleration ramp
// ---------------------------------------------------------------------------

describe('the accel / decel ramp', () => {
  it('a vehicle accelerates at the per-type cap instead of jumping to the limit', async () => {
    const world = new RapierWorld()
    await world.init()
    const net = buildRoad()
    const v = addVehicle(net, 'v-1', 10, 0)
    world.registerVehicle(buildRigidBodySpec(v.id, v.type, v.position, v.heading))
    const ctx = makeCtx({ rapierWorld: world })
    run(net, ctx, 1, 60)
    // 1 s at VEHICLE_DYN.car.accel = 2.0 m/s² — NOT the 16.67 m/s the
    // old "throttle = 1" code produced on the very first tick.
    expect(v.speed).toBeCloseTo(VEHICLE_DYN.car.accel, 3)
    expect(v.speed).toBeLessThan(5)
  })

  it('a vehicle brakes at the stop ceiling instead of stopping instantly', async () => {
    const world = new RapierWorld()
    await world.init()
    // A red light ahead: the constraint demands a stop, so the ramp
    // has to decelerate the vehicle to it.
    const net = buildRoad({ redLight: true })
    const v = addVehicle(net, 'v-1', ROAD_LEN / 2 - 8 - 10, 16)
    world.registerVehicle(buildRigidBodySpec(v.id, v.type, v.position, v.heading))
    const ctx = makeCtx({ rapierWorld: world })
    run(net, ctx, 0.5, 60)
    // 0.5 s at MAX_DECEL = 10 m/s² → 16 − 5 = 11 m/s, not 0.
    expect(v.speed).toBeCloseTo(11, 1)
    expect(v.speed).toBeGreaterThan(5)
  })
})

// ---------------------------------------------------------------------------
// 6. The travel-end wrap
// ---------------------------------------------------------------------------

/** The signed travel along the lane between two samples of `s`.
 *
 *  A wrap — the vehicle re-entering the road from the other end —
 *  shows up as a jump of one road length; it is unwrapped here so
 *  the travelled distance stays continuous. */
const sDelta = (prevS: number, s: number, len: number): { ds: number; wrapped: boolean } => {
  const raw = s - prevS
  if (raw < -len / 2) return { ds: raw + len, wrapped: true }
  if (raw > len / 2) return { ds: raw - len, wrapped: true }
  return { ds: raw, wrapped: false }
}

const normalizeAngle = (a: number): number => {
  let r = a % (2 * Math.PI)
  if (r > Math.PI) r -= 2 * Math.PI
  if (r < -Math.PI) r += 2 * Math.PI
  return r
}

/** The heading a vehicle travelling in `laneIndex` has to have at `s`:
 *  the road tangent for a forward lane, the REVERSED tangent for a
 *  backward lane. */
const travelHeading = (road: Road, laneIndex: number, s: number): number => {
  const fwd = roadForward(road, s)
  const sign = laneForwardSign(laneIndex, road.laneCount)
  return Math.atan2(fwd.uz * sign, fwd.ux * sign)
}

interface WrapSample {
  s: number
  x: number
  z: number
  heading: number
  speed: number
}

describe('the travel-end wrap keeps the traffic moving', () => {
  it('a forward-lane vehicle drives past the road end and comes back on the same lane', async () => {
    const world = new RapierWorld()
    await world.init()
    const net = buildRoad()
    const road = net.roads['r-1']!
    const len = roadLength(road)
    // `let`, not `const`: the vehicle is mutated by the tick loop, and a
    // `const` binding makes TypeScript narrow its properties to `never`
    // inside the callback (the compiler assumes the binding cannot
    // change, so it treats every property read as unreachable).
    let v: Vehicle = addVehicle(net, 'v-1', 10, 0)
    world.registerVehicle(buildRigidBodySpec(v.id, v.type, v.position, v.heading))
    const ctx = makeCtx({ rapierWorld: world })

    let prevS = v.s
    let total = 0
    let wraps = 0
    let lastWindow = 0 // distance travelled over the last 5 s
    let wrapSample: WrapSample | null = null

    run(net, ctx, 30, 60, (t) => {
      const d = sDelta(prevS, v.s, len)
      total += d.ds
      if (d.wrapped) {
        wraps += 1
        if (!wrapSample) {
          wrapSample = {
            s: v.s,
            x: v.position.x,
            z: v.position.z,
            heading: v.heading,
            speed: v.speed,
          }
        }
      }
      if (t > 25) lastWindow += d.ds
      prevS = v.s
    })

    // Read the sample through a thunk: TypeScript narrows a `let` that is
    // assigned inside a callback to its value *before* the callback ran
    // (`null` here), so a direct `wrapSample?.s` outside the callback is
    // typed `never`. The thunk defers the read to a point where the
    // narrowing no longer applies.
    const sample = (): WrapSample | null => wrapSample
    console.log(
      `[wrap / forward] total = ${total.toFixed(2)} m | wraps = ${wraps} | ` +
        `last 5 s = ${lastWindow.toFixed(2)} m | final s = ${v.s.toFixed(2)} | ` +
        `final speed = ${v.speed.toFixed(2)} | re-entered at s = ${sample()?.s.toFixed(3)}`,
    )

    // It really wrapped (the old code parked it at the end instead).
    expect(wraps).toBeGreaterThanOrEqual(1)
    // It kept driving: more than 5 m in the last 5 s.
    expect(lastWindow).toBeGreaterThan(5)
    // And it is not parked at the road end.
    expect(v.s >= len - 0.5 && v.speed < 0.1).toBe(false)

    // The re-entry point is the START of the same lane (the overshoot
    // past the end is carried over), on the lane line — not on the
    // road centreline — and pointing along the lane.
    const ws = wrapSample!
    expect(ws.s).toBeLessThan(5)
    const lp = lanePoint(road, 0, ws.s)
    expect(Math.hypot(ws.x - lp.position.x, ws.z - lp.position.z)).toBeLessThan(0.05)
    expect(Math.abs(normalizeAngle(ws.heading - travelHeading(road, 0, ws.s)))).toBeLessThan(0.01)
    // The wrap is a teleport, not a stop: the speed survives it.
    expect(ws.speed).toBeGreaterThan(5)
  })

  it('a backward-lane vehicle re-enters at the far end and keeps driving against the road tangent', async () => {
    const world = new RapierWorld()
    await world.init()
    const net = buildRoad()
    const road = net.roads['r-1']!
    const len = roadLength(road)
    const backLane = LANE_COUNT - 1 // >= laneCount/2 → travels end → start
    expect(laneForwardSign(backLane, LANE_COUNT)).toBe(-1)
    // `let` — see the note on the forward-lane case above: a `const`
    // binding makes TypeScript narrow the vehicle's properties to
    // `never` inside the tick callback.
    let v: Vehicle = addVehicle(net, 'v-1', len - 10, 0, backLane)
    world.registerVehicle(buildRigidBodySpec(v.id, v.type, v.position, v.heading))
    const ctx = makeCtx({ rapierWorld: world })

    let prevS = v.s
    let wraps = 0
    let wrapSample: WrapSample | null = null
    run(net, ctx, 30, 60, () => {
      const d = sDelta(prevS, v.s, len)
      if (d.wrapped) {
        wraps += 1
        if (!wrapSample) {
          wrapSample = {
            s: v.s,
            x: v.position.x,
            z: v.position.z,
            heading: v.heading,
            speed: v.speed,
          }
        }
      }
      prevS = v.s
    })

    // Read the sample through a thunk: TypeScript narrows a `let` that is
    // assigned inside a callback to its value *before* the callback ran
    // (`null` here), so a direct `wrapSample?.s` outside the callback is
    // typed `never`. The thunk defers the read to a point where the
    // narrowing no longer applies.
    const sample = (): WrapSample | null => wrapSample
    const ws = sample()
    console.log(
      `[wrap / backward] wraps = ${wraps} | re-entered at s = ${ws?.s.toFixed(3)} | ` +
        `heading = ${ws?.heading.toFixed(4)} | road heading = ` +
        `${travelHeading(road, backLane, ws?.s ?? 0).toFixed(4)} | ` +
        `final s = ${v.s.toFixed(2)} | final speed = ${v.speed.toFixed(2)}`,
    )

    expect(wraps).toBeGreaterThanOrEqual(1)
    expect(ws).not.toBeNull()
    const w = ws!
    // A backward lane re-enters at the FAR end of the road (s = len),
    // not at s = 0 — otherwise it would drive against its own lane.
    expect(w.s).toBeGreaterThan(len - 5)
    // The heading follows the lane (the reversed tangent), not the road.
    expect(Math.abs(normalizeAngle(w.heading - travelHeading(road, backLane, w.s)))).toBeLessThan(
      0.01,
    )
    const roadHeading = Math.atan2(roadForward(road, w.s).uz, roadForward(road, w.s).ux)
    expect(Math.abs(normalizeAngle(w.heading - roadHeading))).toBeGreaterThan(3.0)
    // It landed on the lane line, not on the centreline.
    const lp = lanePoint(road, backLane, w.s)
    expect(Math.hypot(w.x - lp.position.x, w.z - lp.position.z)).toBeLessThan(0.05)
    // And it keeps driving: `s` goes DOWN (towards s = 0) after the wrap.
    expect(v.s).toBeLessThan(w.s)
    expect(v.speed).toBeGreaterThan(1)
  })

  it('the traffic light still holds a wrapped vehicle at the stop line', async () => {
    const world = new RapierWorld()
    await world.init()
    const net = buildRoad({ redLight: true })
    const road = net.roads['r-1']!
    const len = roadLength(road)
    const light = net.intersections['i-1']!.trafficLights[0]!
    const stopLineS = len / 2 - 8
    const v = addVehicle(net, 'v-1', 10, 0)
    world.registerVehicle(buildRigidBodySpec(v.id, v.type, v.position, v.heading))
    const ctx = makeCtx({ rapierWorld: world })

    // Phase 1 — green: the vehicle drives to the end of the road and
    // wraps back to the start.
    light.phase = LightPhase.Green
    light.phaseRemaining = 999
    const dt = 1 / 60
    let simTime = 0
    let prevS = v.s
    let wrapped = false
    while (simTime < 60 && !wrapped) {
      simTime += dt
      tick(net, dt, simTime, ctx)
      const d = sDelta(prevS, v.s, len)
      prevS = v.s
      if (d.wrapped) wrapped = true
    }
    expect(wrapped).toBe(true)
    expect(v.s).toBeLessThan(5)

    // Phase 2 — red: the wrapped vehicle must stop at the stop line
    // instead of running through the intersection.
    light.phase = LightPhase.Red
    light.phaseRemaining = 999
    run(net, ctx, 25, 60)

    console.log(
      `[wrap / red light] after the wrap: s = ${v.s.toFixed(2)} (stop line at ${stopLineS}) | ` +
        `speed = ${v.speed.toFixed(2)}`,
    )
    expect(v.s).toBeLessThan(stopLineS)
    expect(v.speed).toBeLessThan(0.5)
    // It stopped AT the stop line, not somewhere far before it.
    expect(v.s).toBeGreaterThan(stopLineS - 8)
  })

  it('the physics path and the fallback path wrap identically', async () => {
    const measure = async (withPhysics: boolean) => {
      const world = new RapierWorld()
      if (withPhysics) await world.init()
      const net = buildRoad()
      const road = net.roads['r-1']!
      const len = roadLength(road)
      const v = addVehicle(net, 'v-1', 10, 0)
      if (withPhysics) {
        world.registerVehicle(buildRigidBodySpec(v.id, v.type, v.position, v.heading))
      }
      const ctx = makeCtx({ rapierWorld: withPhysics ? world : null })

      let prevS = v.s
      let total = 0
      let wraps = 0
      let firstWrap: { total: number; s: number } | null = null
      run(net, ctx, 30, 60, () => {
        const d = sDelta(prevS, v.s, len)
        total += d.ds
        if (d.wrapped) {
          wraps += 1
          if (!firstWrap) firstWrap = { total, s: v.s }
        }
        prevS = v.s
      })
      return { total, wraps, firstWrap: firstWrap!, len }
    }

    const physics = await measure(true)
    const fallback = await measure(false)

    console.log(
      `[wrap / both paths] physics: total = ${physics.total.toFixed(2)} m, ` +
        `wraps = ${physics.wraps}, first re-entry s = ${physics.firstWrap.s.toFixed(3)} | ` +
        `fallback: total = ${fallback.total.toFixed(2)} m, wraps = ${fallback.wraps}, ` +
        `first re-entry s = ${fallback.firstWrap.s.toFixed(3)}`,
    )

    // Both paths wrap.
    expect(physics.wraps).toBeGreaterThanOrEqual(1)
    expect(fallback.wraps).toBeGreaterThanOrEqual(1)
    // Both re-enter at the same place (the overshoot past the end).
    expect(Math.abs(physics.firstWrap.s - fallback.firstWrap.s)).toBeLessThan(1)
    // And they travel the same distance.
    expect(Math.abs(physics.total - fallback.total)).toBeLessThan(3)
    expect(physics.firstWrap.total).toBeCloseTo(fallback.firstWrap.total, 0)
  })

  it('the built-in cross scene keeps moving (the reported bug)', async () => {
    const world = new RapierWorld()
    await world.init()
    const net = buildCrossIntersectionNetwork()
    const ctx = makeCtx({ rapierWorld: world })
    const vehicles = Object.values(net.vehicles)
    for (const v of vehicles) {
      world.registerVehicle(buildRigidBodySpec(v.id, v.type, v.position, v.heading))
    }

    // Per-vehicle travel bookkeeping (unwrapped) + the road length of
    // each vehicle's road. The distance is absolute: a backward lane
    // travels with a DECREASING `s`, a forward lane with an
    // increasing one.
    const prev = new Map<string, number>()
    const total = new Map<string, number>()
    for (const v of vehicles) {
      prev.set(v.id, v.s)
      total.set(v.id, 0)
    }
    const windowDistance = new Map<string, number>()
    for (const v of vehicles) windowDistance.set(v.id, 0)

    let simTime = 0
    const dt = 1 / 60
    const frames = 60 * 90 // 90 s of simulation
    for (let i = 0; i < frames; i++) {
      simTime += dt
      tick(net, dt, simTime, ctx)
      for (const v of Object.values(net.vehicles)) {
        const road = net.roads[v.roadId]
        if (!road) continue
        const len = roadLength(road)
        const d = sDelta(prev.get(v.id) ?? v.s, v.s, len)
        prev.set(v.id, v.s)
        const moved = Math.abs(d.ds)
        total.set(v.id, (total.get(v.id) ?? 0) + moved)
        if (simTime > 60) windowDistance.set(v.id, (windowDistance.get(v.id) ?? 0) + moved)
      }
    }

    const fleet = Object.values(net.vehicles)
    const travelled = fleet.map((v) => ({
      id: v.id,
      roadId: v.roadId,
      total: total.get(v.id) ?? 0,
      last30s: windowDistance.get(v.id) ?? 0,
      s: v.s,
      speed: v.speed,
      status: v.status,
      len: roadLength(net.roads[v.roadId]!),
    }))

    console.log(
      '[cross scene] 90 s:',
      travelled
        .map(
          (t) =>
            `${t.id} total=${t.total.toFixed(1)} m (last 30 s: ${t.last30s.toFixed(1)} m, ` +
            `s=${t.s.toFixed(1)}/${t.len}, v=${t.speed.toFixed(1)}, ${t.status})`,
        )
        .join(' | '),
    )

    // Every vehicle drove a long way — none of them is parked at the
    // end of its road.
    for (const t of travelled) {
      expect(t.total, `${t.id} total`).toBeGreaterThan(50)
      const parkedAtEnd = (t.s >= t.len - 0.5 || t.s <= 0.5) && t.speed < 0.1
      expect(parkedAtEnd, `${t.id} parked at the road end`).toBe(false)
      // The teleport must not trigger a crash — a crashed vehicle
      // stops for good, which is the old freeze all over again.
      expect(t.status, `${t.id} status`).not.toBe('crashed')
    }
    // The fleet is still moving in the last 30 s of the run.
    const moving = travelled.filter((t) => t.last30s > 5)
    expect(moving.length).toBeGreaterThanOrEqual(Math.ceil(fleet.length / 2))
  })
})
