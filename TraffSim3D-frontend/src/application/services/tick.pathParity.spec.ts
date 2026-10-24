// src/application/services/tick.pathParity.spec.ts
//
// The physics-vs-fallback **path parity** regression.
//
// The simulator has two motion paths inside `tick()`:
//
//   - the PHYSICS path (`ctx.rapierWorld` set): Rapier rigid bodies carry
//     the vehicle — mass, collision footprint, contacts, turning radius;
//   - the FALLBACK path (`ctx.rapierWorld` null): no bodies, the
//     application-layer model (speed ramp + lane geometry) directly.
//
// The fallback is the faithful implementation of the application-layer
// model; the physics path has to CONVERGE on it. This spec runs both
// paths from bit-identical initial states and pins the convergence:
//
//   1. the signal phase sequence is identical frame by frame (A1);
//   2. the per-vehicle `targetSpeed` sequence has NO mismatching frame
//      (A2) — the two paths must make the same *decisions*, not merely
//      travel a similar distance;
//   3. the cumulative driving distance is within 5 % (A4) on a clean
//      straight road — a scene without an intersection, so the only
//      variable between the two paths is the motion model;
//   4. the physics path reaches the road's speed limit (A5) — no second,
//      physics-level longitudinal model may cap it;
//   5. a vehicle on a BACKWARD lane keeps its heading and its lane
//      (A6) — the Pure Pursuit lookahead has to follow the lane's travel
//      direction;
//   6. a vehicle that stands still at a red light does not rotate — the
//      physics ground must not push a buried body around.
//
// The file uses the REAL Rapier WASM (`importOriginal` bypasses the
// global no-op stub in `tests/setup.ts`): the parity is a property of the
// solver, so a fake solver would test the fake.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@dimforge/rapier3d-compat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dimforge/rapier3d-compat')>()
  return actual
})

const { RapierWorld } = await import('@infrastructure/physics')
const { buildRigidBodySpec } = await import('@infrastructure/physics/RapierBodySpec')
const { tick } = await import('./tick')
const { buildCrossIntersectionNetwork } = await import('./defaultScene')
const { lanePoint, laneForwardSign } = await import('@domain/services/laneGeometry')
const { createRoadNetwork } = await import('@domain/entities/RoadNetwork')
const { LaneId } = await import('@domain/value-objects/LaneId')
const { LightPhase } = await import('@domain/value-objects/Phase')
import type { TickContext } from './tick'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Road } from '@domain/entities/Road'
import type { Vehicle } from '@domain/entities/Vehicle'

const DT = 1 / 60
/** A per-step position jump above this (m) is a teleport, not driving.
 *  At 60 Hz and ≤16.67 m/s the largest legitimate step is 0.278 m. */
const JUMP_TELEPORT = 1.0

// ---------------------------------------------------------------------------
// scene builders
// ---------------------------------------------------------------------------

const at = (
  road: Road,
  laneIndex: number,
  s: number,
  speed: number,
  v: Omit<
    Vehicle,
    | 'position'
    | 'heading'
    | 'lane'
    | 's'
    | 'speed'
    | 'targetSpeed'
    | 'roadId'
    | 'laneIndex'
    | 'enteredIntersectionAt'
    | 'desiredLaneIndex'
    | 'laneChangeStartedAt'
    | 'spawnedAt'
    | 'desiredStatus'
  >,
): Vehicle => {
  const lp = lanePoint(road, laneIndex, s)
  return {
    ...v,
    roadId: road.id,
    laneIndex,
    s,
    speed,
    targetSpeed: road.speedLimit,
    position: lp.position,
    heading: lp.heading,
    lane: LaneId.make(road.id, laneIndex),
    enteredIntersectionAt: null,
    desiredLaneIndex: null,
    laneChangeStartedAt: null,
    spawnedAt: 0,
    desiredStatus: 'driving',
  }
}

/** A clean straight road: 200 m, 4 lanes (2 forward / 2 backward), no
 *  intersection, no traffic light. The only variable between the two
 *  paths is the motion model itself. */
const buildStraightRoadNetwork = (): RoadNetwork => {
  const net = createRoadNetwork()
  const road: Road = {
    id: 'r-straight',
    startNode: { x: 0, y: 0, z: -100 },
    endNode: { x: 0, y: 0, z: 100 },
    laneCount: 4,
    speedLimit: 16.67,
    level: 0,
  }
  net.roads[road.id] = road
  const vehicles: Vehicle[] = [
    at(road, 0, 20, 8, { id: 's-1', type: 'car', color: '#3a86ff', status: 'driving' }),
    at(road, 1, 80, 6, { id: 's-2', type: 'truck', color: '#f5f5f4', status: 'driving' }),
    at(road, 2, 140, 8, { id: 's-3', type: 'car', color: '#ef4444', status: 'driving' }),
    at(road, 3, 60, 6, { id: 's-4', type: 'bus', color: '#22c55e', status: 'driving' }),
  ]
  for (const v of vehicles) net.vehicles[v.id] = v
  return net
}

/** One straight road, ONE intersection with a permanently red light on the
 *  vehicle's axis, ONE vehicle. It drives up to the stop line, stops, and
 *  stands there — which is where a buried body used to be pushed around by
 *  the contact solver. */
const buildRedLightNetwork = (): RoadNetwork => {
  const net = createRoadNetwork()
  const road: Road = {
    id: 'r-red',
    startNode: { x: 0, y: 0, z: -100 },
    endNode: { x: 0, y: 0, z: 100 },
    laneCount: 4,
    speedLimit: 16.67,
    level: 0,
  }
  net.roads[road.id] = road
  const light = {
    id: 'tl-red',
    position: { x: 0, y: 0, z: 0 },
    phase: LightPhase.Red,
    phaseRemaining: 600,
    cycleSeconds: 63,
    axis: 'ns' as const,
  }
  net.intersections['i-red'] = {
    id: 'i-red',
    position: { x: 0, y: 0, z: 0 },
    trafficLights: [light],
    connectedRoads: [road.id],
    intersectionRadius: 8,
  }
  net.vehicles['r-1'] = at(road, 0, 20, 8, {
    id: 'r-1',
    type: 'car',
    color: '#3a86ff',
    status: 'driving',
  })
  return net
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

interface VehicleTrace {
  id: string
  type: string
  roadId: string
  lane0: number
  backward: boolean
  x: number[]
  z: number[]
  heading: number[]
  speed: number[]
  s: number[]
  lane: number[]
  target: number[]
  status: string[]
}
interface RunResult {
  path: 'physics' | 'fallback'
  vehicles: VehicleTrace[]
  phases: Record<string, string[]>
}

const signalCtx = (controllerKind: 'actuated' | 'fixed-cycle'): TickContext['signal'] => ({
  controllers: new Map(),
  controllerKind,
  getCoordinatedOffsets: () => new Map(),
  isCoordinatedEnabled: () => false,
  getRlActionSource: () => undefined,
})

const run = async (
  build: () => RoadNetwork,
  path: 'physics' | 'fallback',
  steps: number,
  controllerKind: 'actuated' | 'fixed-cycle' = 'actuated',
): Promise<RunResult> => {
  const net = build()
  const ids = Object.keys(net.vehicles)
  let world: InstanceType<typeof RapierWorld> | null = null
  if (path === 'physics') {
    world = new RapierWorld()
    await world.init()
    for (const v of Object.values(net.vehicles)) {
      world.registerVehicle(buildRigidBodySpec(v.id, v.type, v.position, v.heading))
    }
  }
  const traces = new Map<string, VehicleTrace>()
  for (const id of ids) {
    const v = net.vehicles[id]!
    const road = net.roads[v.roadId]!
    traces.set(id, {
      id,
      type: v.type,
      roadId: v.roadId,
      lane0: v.laneIndex,
      backward: laneForwardSign(v.laneIndex, road.laneCount) === -1,
      x: [],
      z: [],
      heading: [],
      speed: [],
      s: [],
      lane: [],
      target: [],
      status: [],
    })
  }
  const phaseIds: string[] = []
  for (const inter of Object.values(net.intersections)) {
    for (const light of inter.trafficLights) phaseIds.push(light.id)
  }
  const phases: Record<string, string[]> = {}
  for (const id of phaseIds) phases[id] = []

  let simTime = 0
  for (let step = 0; step < steps; step++) {
    simTime += DT
    const ctx: TickContext = {
      rapierWorld: world,
      signal: signalCtx(controllerKind),
      trajectoryExporter: null,
      sensorRegistry: null,
      lidarEnabled: false,
      getHostPose: () => null,
      fixedStepScheduler: null,
      draggingId: null,
      removeVehicle: (id: string) => {
        delete net.vehicles[id]
      },
      policy: null,
      replayTargetId: null,
    }
    tick(net, DT, simTime, ctx)
    for (const id of ids) {
      const v = net.vehicles[id]
      if (!v) continue
      const tr = traces.get(id)!
      tr.x.push(v.position.x)
      tr.z.push(v.position.z)
      tr.heading.push(v.heading)
      tr.speed.push(v.speed)
      tr.s.push(v.s)
      tr.lane.push(v.laneIndex)
      tr.target.push(v.targetSpeed)
      tr.status.push(v.status)
    }
    for (const id of phaseIds) {
      const light = Object.values(net.intersections)
        .flatMap((i) => i.trafficLights)
        .find((l) => l.id === id)
      phases[id]!.push(light ? light.phase : 'missing')
    }
  }
  return { path, vehicles: [...traces.values()], phases }
}

/** The driving distance: the sum of the per-frame XZ displacements, with
 *  the teleports (the travel-end wrap moves a body ~60 m in one frame)
 *  excluded. */
const driveDistance = (v: VehicleTrace): number => {
  let d = 0
  for (let k = 1; k < v.x.length; k++) {
    const jump = Math.hypot(v.x[k]! - v.x[k - 1]!, v.z[k]! - v.z[k - 1]!)
    if (jump <= JUMP_TELEPORT) d += jump
  }
  return d
}

/** The XZ distance from the body to the centre of the lane it occupies. */
const lateralOffset = (net: RoadNetwork, v: VehicleTrace, k: number): number => {
  const road = net.roads[v.roadId]
  if (!road) return 0
  const lp = lanePoint(road, v.lane[k]!, v.s[k]!)
  return Math.hypot(v.x[k]! - lp.position.x, v.z[k]! - lp.position.z)
}

// ---------------------------------------------------------------------------
// the parity itself
// ---------------------------------------------------------------------------

describe('path parity — the physics path converges on the fallback path', () => {
  it('the straight-road scene: the two paths drive the same distance (≤ 5 %) and make the same decisions', async () => {
    const STEPS = 1200 // 20 s — long enough to reach the speed limit and wrap the road
    const net = buildStraightRoadNetwork()
    const phys = await run(buildStraightRoadNetwork, 'physics', STEPS)
    const fall = await run(buildStraightRoadNetwork, 'fallback', STEPS)

    // A2 — the per-vehicle targetSpeed sequences must match frame by frame.
    for (const pv of phys.vehicles) {
      const fv = fall.vehicles.find((v) => v.id === pv.id)!
      const mismatches = pv.target.filter((t, k) => Math.abs(t - fv.target[k]!) > 1e-9)
      expect(
        mismatches.length,
        `${pv.id}: ${mismatches.length} targetSpeed mismatching frames of ${STEPS}`,
      ).toBe(0)
    }

    // A4 — the cumulative driving distance.
    let physTotal = 0
    let fallTotal = 0
    for (const pv of phys.vehicles) {
      const fv = fall.vehicles.find((v) => v.id === pv.id)!
      const p = driveDistance(pv)
      const f = driveDistance(fv)
      physTotal += p
      fallTotal += f
      expect(
        Math.abs(p / f - 1),
        `${pv.id}: physics ${p.toFixed(1)} m vs fallback ${f.toFixed(1)} m`,
      ).toBeLessThanOrEqual(0.05)
    }
    expect(
      Math.abs(physTotal / fallTotal - 1),
      `fleet: physics ${physTotal.toFixed(1)} m vs fallback ${fallTotal.toFixed(1)} m`,
    ).toBeLessThanOrEqual(0.05)
    void net
  })

  it('the straight-road scene: the physics path reaches the road speed limit', async () => {
    // The physics body carries NO linear damping: the longitudinal
    // dynamics belong to the application layer. With a damping
    // coefficient the body's speed equilibrated at `accel / damping`
    // (10 m/s for a car, 7 for a truck, 6 for a bus) — a ceiling the
    // application layer never asked for.
    const phys = await run(buildStraightRoadNetwork, 'physics', 600)
    for (const v of phys.vehicles) {
      expect(Math.max(...v.speed), `${v.id} (${v.type}) top speed`).toBeCloseTo(16.67, 2)
    }
  })

  it('the straight-road scene: a vehicle on a BACKWARD lane keeps its heading and its lane', async () => {
    // The Pure Pursuit lookahead has to point along the lane's TRAVEL
    // direction. A backward lane's arc length decreases as the vehicle
    // drives on, so an unconditional `s + lookahead` put the target
    // BEHIND the vehicle and the steering pulled it off course: a vehicle
    // on a backward lane turned 180° within 7 s and ended up 4.99 m off
    // the centreline — exactly on the 5 m lane guard.
    const net = buildStraightRoadNetwork()
    const phys = await run(buildStraightRoadNetwork, 'physics', 600)
    for (const v of phys.vehicles) {
      let maxDheading = 0
      for (let k = 1; k < v.heading.length; k++) {
        let dh = v.heading[k]! - v.heading[k - 1]!
        if (dh > Math.PI) dh -= 2 * Math.PI
        if (dh < -Math.PI) dh += 2 * Math.PI
        maxDheading = Math.max(maxDheading, Math.abs(dh))
      }
      let maxLateral = 0
      for (let k = 0; k < v.x.length; k++)
        maxLateral = Math.max(maxLateral, lateralOffset(net, v, k))
      expect(
        maxDheading,
        `${v.id} (${v.backward ? 'backward' : 'forward'}) max |Δheading|`,
      ).toBeLessThanOrEqual(2e-2)
      expect(
        maxLateral,
        `${v.id} (${v.backward ? 'backward' : 'forward'}) max lateral offset`,
      ).toBeLessThanOrEqual(0.2)
    }
  })

  it('a vehicle standing at a red light does not rotate', async () => {
    // The physics ground used to have its top surface AT the road level,
    // so every vehicle was buried 0.75 m into it and the contact solver
    // pushed it back out with an impulse that torqued the body: a car
    // stopped at a red light drifted from heading 0 to 0.79 rad (45°)
    // while standing still.
    const net = buildRedLightNetwork()
    const phys = await run(buildRedLightNetwork, 'physics', 1800, 'fixed-cycle')
    const v = phys.vehicles[0]!
    // The vehicle must have come to a stand-still at the stop line.
    const stoppedAt = v.speed.findIndex((s, k) => k > 60 && s < 0.05)
    expect(stoppedAt, 'the vehicle never came to a stop at the red light').toBeGreaterThan(0)
    let drift = 0
    for (let k = stoppedAt + 1; k < v.heading.length; k++) {
      let dh = v.heading[k]! - v.heading[k - 1]!
      if (dh > Math.PI) dh -= 2 * Math.PI
      if (dh < -Math.PI) dh += 2 * Math.PI
      drift += Math.abs(dh)
    }
    expect(drift, 'heading drift while standing at the red light (rad)').toBeLessThan(0.02)
    void net
  })

  it('the straight-road scene: the physics path tracks its lane exactly', async () => {
    // The physics ground sits one vehicle collider half-height below the
    // road, so the body RESTS on the ground instead of being buried 0.75 m
    // inside it. A buried body is pushed back out by the contact solver
    // with an impulse that torqued it — and the tick's height guard
    // snapped it back down every frame, so the body wobbled instead of
    // resting. Measured on this scene: with the ground in the right
    // place the lateral offset is < 5e-5 m and the per-frame heading
    // change is < 5e-8 rad; with the ground back at the road level they
    // are 2.8e-2 m and 4.2e-4 rad — three to four orders of magnitude
    // worse.
    const net = buildStraightRoadNetwork()
    const phys = await run(buildStraightRoadNetwork, 'physics', 600)
    for (const v of phys.vehicles) {
      let maxDheading = 0
      for (let k = 1; k < v.heading.length; k++) {
        let dh = v.heading[k]! - v.heading[k - 1]!
        if (dh > Math.PI) dh -= 2 * Math.PI
        if (dh < -Math.PI) dh += 2 * Math.PI
        maxDheading = Math.max(maxDheading, Math.abs(dh))
      }
      let maxLateral = 0
      for (let k = 0; k < v.x.length; k++)
        maxLateral = Math.max(maxLateral, lateralOffset(net, v, k))
      expect(maxLateral, `${v.id} max lateral offset (m)`).toBeLessThanOrEqual(5e-3)
      expect(maxDheading, `${v.id} max |Δheading| per frame (rad)`).toBeLessThanOrEqual(1e-5)
    }
  })

  it('a backward-lane vehicle steers BACK to its lane when it is knocked off course', async () => {
    // The Pure Pursuit lookahead has to point along the lane's TRAVEL
    // direction. A backward lane's arc length decreases as the vehicle
    // drives on, so an unconditional `s + lookahead` puts the target
    // BEHIND the vehicle — and the steering law then pushes it further
    // off course instead of pulling it back. The vehicle starts with a
    // 0.01 rad heading error: with a direction-aware lookahead the Pure
    // Pursuit pulls the heading back onto the lane; with the wrong one it
    // amplifies the error until the vehicle drives off the lane.
    const net = buildStraightRoadNetwork()
    const v = net.vehicles['s-3']!
    const laneHeading = lanePoint(net.roads['r-straight']!, v.laneIndex, v.s).heading
    v.heading = laneHeading + 0.01
    const phys = await run(() => net, 'physics', 300)
    const trace = phys.vehicles.find((x) => x.id === 's-3')!
    const finalHeadingError = Math.abs(trace.heading[trace.heading.length - 1]! - laneHeading)
    expect(
      finalHeadingError,
      'the heading error did not converge back onto the lane (rad)',
    ).toBeLessThan(0.02)
    let maxLateral = 0
    for (let k = 0; k < trace.x.length; k++)
      maxLateral = Math.max(maxLateral, lateralOffset(net, trace, k))
    expect(maxLateral, 'the vehicle drifted off its lane (m)').toBeLessThan(0.5)
  })

  it('the cross road: a vehicle that is already inside the junction is NOT stopped by the cross-road yield', async () => {
    // The cross-road yield is a priority rule for vehicles that have NOT
    // entered the junction yet. A vehicle that is already inside the
    // intersection box is committed — it clears the junction — and the
    // old "the later arrival yields" rule stopped it THERE, in the
    // middle of the junction, blocking the axis it was yielding to.
    //
    // The scene: one vehicle already inside the junction box on the NS
    // road, one on the EW road that enters the box 0.72 s later (it is
    // too close to the stop line to stop, so it rolls in). From that
    // moment on both are inside: the committed one must keep going.
    const net = createRoadNetwork()
    const ns: Road = {
      id: 'r-ns',
      startNode: { x: 0, y: 0, z: -100 },
      endNode: { x: 0, y: 0, z: 100 },
      laneCount: 4,
      speedLimit: 16.67,
      level: 0,
    }
    const ew: Road = {
      id: 'r-ew',
      startNode: { x: -100, y: 0, z: 0 },
      endNode: { x: 100, y: 0, z: 0 },
      laneCount: 4,
      speedLimit: 16.67,
      level: 0,
    }
    net.roads[ns.id] = ns
    net.roads[ew.id] = ew
    net.intersections['i-x'] = {
      id: 'i-x',
      position: { x: 0, y: 0, z: 0 },
      trafficLights: [],
      connectedRoads: [ns.id, ew.id],
      intersectionRadius: 8,
    }
    net.vehicles['x-ns'] = at(ns, 0, 100, 1, {
      id: 'x-ns',
      type: 'car',
      color: '#3a86ff',
      status: 'driving',
    })
    net.vehicles['x-ew'] = at(ew, 0, 80, 16.67, {
      id: 'x-ew',
      type: 'car',
      color: '#ef4444',
      status: 'driving',
    })

    const phys = await run(() => net, 'physics', 120)
    const ewTrace = phys.vehicles.find((x) => x.id === 'x-ew')!
    // The EW vehicle enters the junction box (s = 92) at t ≈ 1.05 s and
    // the NS vehicle is inside it until t ≈ 2.37 s, so from 1.05 s on
    // both of them are committed.
    const afterEntry = ewTrace.speed.slice(72, 133) // t = 1.2 s .. 2.2 s
    expect(
      Math.min(...afterEntry),
      'the vehicle was brought to a stand-still inside the junction (m/s)',
    ).toBeGreaterThan(2)
    expect(
      ewTrace.speed[119]!,
      'the vehicle was stopped inside the junction (m/s)',
    ).toBeGreaterThan(5)
    expect(ewTrace.s[119]!, 'the vehicle never reached the junction').toBeGreaterThan(92)
  })

  it('the cross scene: the signal phase sequence is identical frame by frame', async () => {
    // The actuated controller reacts to the queue, so a difference in the
    // traffic would show up as a difference in the light schedule. The
    // two paths have to agree on it.
    const STEPS = 2700 // 45 s — covers two phase changes
    const phys = await run(buildCrossIntersectionNetwork, 'physics', STEPS)
    const fall = await run(buildCrossIntersectionNetwork, 'fallback', STEPS)
    for (const lightId of Object.keys(phys.phases)) {
      const p = phys.phases[lightId]!
      const f = fall.phases[lightId]!
      const mismatches = p.filter((ph, k) => ph !== f[k]).length
      expect(mismatches, `${lightId}: ${mismatches} phase mismatching frames of ${STEPS}`).toBe(0)
    }
  })
})
