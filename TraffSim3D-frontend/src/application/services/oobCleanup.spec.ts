// Out-of-bounds cleanup tests.
//
// The behaviour that is pinned here:
//
//   1. A vehicle that has left the road network is **not** teleported
//      back to `s = 0` in the frame it is detected. It enters an exit
//      phase: it brakes under MAX_DECEL and is only put back once it
//      has come to a stop (or has rolled far / long enough).
//   2. Every entry and every reset is **recorded** — the reset is
//      never a silent blink back to the origin.
//   3. The skip conditions still hold: a vehicle that is mid
//      lane-change, one that was spawned less than a second ago and
//      the one the editor is dragging are not judged.
//   4. No ghost state: once the vehicle is back on the road it is not
//      "exiting" any more, and a vehicle that was put back does not
//      trigger the reset again on the next frame.

import { describe, it, expect, beforeEach } from 'vitest'
import { lanePoint } from '@domain/services/laneGeometry'
import { buildTestNetwork, makeTestVehicle } from '@__fixtures__/testNetwork'
import { MAX_DECEL, OUT_OF_BOUNDS_M } from '@shared/constants/simulation'
import {
  tickOobCleanup,
  isOobExiting,
  getOobEvents,
  clearOobEvents,
  subscribeOobEvents,
  recordLaneGuard,
  OOB_EXIT_MAX_DISTANCE_M,
  OOB_EXIT_MAX_SECONDS,
  type TickOobDeps,
} from './oobCleanup'
import { tick, type TickContext } from './tick'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Vehicle } from '@domain/entities/Vehicle'
import type { RapierWorld } from '@infrastructure/physics'

describe('tickOobCleanup', () => {
  let net: RoadNetwork
  let respawned: string[]
  let removed: string[]
  let snapped: Array<{ id: string; x: number; y: number; z: number; heading: number }>
  let dragging: string | null

  beforeEach(() => {
    net = buildTestNetwork(0)
    respawned = []
    removed = []
    snapped = []
    dragging = null
    clearOobEvents()
  })

  const makeDeps = (): TickOobDeps => ({
    getRoad: (id) => net.roads[id],
    removeVehicle: (id) => {
      removed.push(id)
      delete net.vehicles[id]
    },
    snapVehicle: (id, pos, heading) => {
      respawned.push(id)
      snapped.push({ id, x: pos.x, y: pos.y, z: pos.z, heading })
      const v = net.vehicles[id]
      if (v) {
        v.position = { x: pos.x, y: v.position.y, z: pos.z }
        v.heading = heading
        v.s = 0
        v.speed = 0
      }
    },
    draggingId: () => dragging,
  })

  /** A vehicle that has left the network (1000 m off its lane). */
  const makeLostVehicle = (id = 'v-far', speed = 12): ReturnType<typeof makeTestVehicle> => {
    const v = makeTestVehicle({ id, roadId: 'r-ns', laneIndex: 0, s: 10, spawnedAt: -10 })
    v.position = { x: 1000, y: 0, z: 1000 }
    v.speed = speed
    net.vehicles[id] = v
    return v
  }

  it('does NOT teleport the vehicle back on the frame it is detected', () => {
    const v = makeLostVehicle()
    tickOobCleanup(makeDeps(), Object.values(net.vehicles), 5.0, 1 / 60)

    // The old implementation reset `s`, the speed and the position in
    // this very frame — the car blinked back to the origin.
    expect(respawned).toHaveLength(0)
    expect(v.s).toBe(10)
    expect(v.position.x).toBe(1000)
    expect(v.speed).toBe(12)
    // …but it IS leaving now: the tick brakes it instead of handing it
    // the road's speed limit.
    expect(isOobExiting(v)).toBe(true)
    expect(v.targetSpeed).toBe(0)
  })

  it('brakes the vehicle down and puts it back once it has stopped', () => {
    const v = makeLostVehicle('v-far', 12)
    const deps = makeDeps()
    const speeds: number[] = []
    const sSeries: number[] = []

    tickOobCleanup(deps, Object.values(net.vehicles), 5.0, 1 / 60)
    // One second of ticks: the speed has to come down, not stay put.
    for (let i = 0; i < 60; i++) {
      tickOobCleanup(deps, Object.values(net.vehicles), 5.0 + (i + 1) / 60, 1 / 60)
      speeds.push(v.speed)
      sSeries.push(v.s)
    }

    // The brake uses the simulation's own stop deceleration.
    expect(speeds[0]).toBeCloseTo(12 - MAX_DECEL / 60, 6)
    expect(speeds[59]).toBeCloseTo(12 - MAX_DECEL, 6)
    // Monotonically down, never below zero.
    for (let i = 1; i < speeds.length; i++) {
      expect(speeds[i]!).toBeLessThanOrEqual(speeds[i - 1]! + 1e-9)
      expect(speeds[i]!).toBeGreaterThanOrEqual(0)
    }

    // It has not stopped yet (12 m/s → 2 m/s after one second), so it
    // is still out there — the reset has not happened.
    expect(respawned).toHaveLength(0)
    expect(v.s).toBe(10)

    // …and once it has stopped it is put back at the road start.
    for (let i = 0; i < 120; i++) {
      tickOobCleanup(deps, Object.values(net.vehicles), 6.0 + (i + 1) / 60, 1 / 60)
    }
    expect(respawned).toEqual(['v-far'])
    expect(v.s).toBe(0)
    expect(v.speed).toBe(0)
    const expected = lanePoint(net.roads['r-ns']!, 0, 0)
    expect(v.position.x).toBeCloseTo(expected.position.x, 6)
    expect(v.position.z).toBeCloseTo(expected.position.z, 6)
    // No ghost state: it is on the road again, not "exiting".
    expect(isOobExiting(v)).toBe(false)
  })

  it('records every entry and every reset — the reset is never silent', () => {
    const seen: string[] = []
    const unsubscribe = subscribeOobEvents((e) => seen.push(`${e.kind}:${e.vehicleId}`))
    const v = makeLostVehicle('v-far', 6)
    const deps = makeDeps()

    tickOobCleanup(deps, Object.values(net.vehicles), 5.0, 1 / 60)
    for (let i = 0; i < 120; i++) {
      tickOobCleanup(deps, Object.values(net.vehicles), 5.0 + (i + 1) / 60, 1 / 60)
    }
    unsubscribe()

    expect(seen).toEqual(['exit-start:v-far', 'reset:v-far'])
    const events = getOobEvents()
    expect(events).toHaveLength(2)
    expect(events[0]!.kind).toBe('exit-start')
    expect(events[0]!.distance).toBeGreaterThan(OUT_OF_BOUNDS_M)
    expect(events[1]!.kind).toBe('reset')
    expect(events[1]!.reason).toContain('stopped')
    expect(events[1]!.reason).toContain('r-ns')
  })

  it('does not reset the same vehicle again on the following frames', () => {
    // The risk the audit asked about: a vehicle that is put back at
    // s = 0 but whose distance to the lane geometry is still larger
    // than the threshold would be reset again — every frame.
    const v = makeLostVehicle('v-far', 4)
    const deps = makeDeps()
    tickOobCleanup(deps, Object.values(net.vehicles), 5.0, 1 / 60)
    for (let i = 0; i < 120; i++) {
      tickOobCleanup(deps, Object.values(net.vehicles), 5.0 + (i + 1) / 60, 1 / 60)
    }
    expect(respawned).toEqual(['v-far'])

    // Ten more frames: the vehicle stays on the road and is not reset
    // a second time.
    const sSeries: number[] = []
    for (let i = 0; i < 10; i++) {
      tickOobCleanup(deps, Object.values(net.vehicles), 7.0 + (i + 1) / 60, 1 / 60)
      sSeries.push(v.s)
    }
    expect(respawned).toEqual(['v-far'])
    expect(getOobEvents().filter((e) => e.kind === 'reset')).toHaveLength(1)
    // s stays at the road start — no repeated reset, no flicker.
    expect(sSeries.every((s) => s === 0)).toBe(true)
  })

  it('ends the exit phase when the vehicle has rolled far enough', () => {
    const v = makeLostVehicle('v-far', 30)
    const deps = makeDeps()
    tickOobCleanup(deps, Object.values(net.vehicles), 5.0, 1 / 60)
    // The vehicle keeps rolling (it never comes to a stop).
    for (let i = 0; i < 200; i++) {
      v.position = { x: v.position.x + 1, y: 0, z: v.position.z }
      v.speed = 30
      tickOobCleanup(deps, Object.values(net.vehicles), 5.0 + (i + 1) / 60, 1 / 60)
      if (respawned.length > 0) break
    }
    expect(respawned).toEqual(['v-far'])
    const reset = getOobEvents().find((e) => e.kind === 'reset')
    expect(reset!.reason).toContain('distance')
    expect(OOB_EXIT_MAX_DISTANCE_M).toBeGreaterThan(0)
  })

  it('ends the exit phase on the timeout when the vehicle never stops', () => {
    const v = makeLostVehicle('v-far', 30)
    const deps = makeDeps()
    tickOobCleanup(deps, Object.values(net.vehicles), 5.0, 1 / 60)
    // The speed is pinned from the outside (the physics keeps it
    // alive): only the timeout can end the phase.
    for (let i = 0; i < 60 * (OOB_EXIT_MAX_SECONDS + 1); i++) {
      v.speed = 30
      tickOobCleanup(deps, Object.values(net.vehicles), 5.0 + (i + 1) / 60, 1 / 60)
      if (respawned.length > 0) break
    }
    expect(respawned).toEqual(['v-far'])
    const reset = getOobEvents().find((e) => e.kind === 'reset')
    expect(reset!.reason).toContain('timeout')
  })

  it('does not start an exit phase for vehicles within 50m', () => {
    const v = makeTestVehicle({ id: 'v-ok', roadId: 'r-ns', laneIndex: 0, s: 10, spawnedAt: -10 })
    net.vehicles['v-ok'] = v
    tickOobCleanup(makeDeps(), Object.values(net.vehicles), 5.0, 1 / 60)
    expect(respawned).not.toContain('v-ok')
    expect(isOobExiting(v)).toBe(false)
  })

  it('hard-deletes vehicles whose road is missing — and says so', () => {
    const v = makeTestVehicle({
      id: 'v-orphan',
      roadId: 'r-deleted',
      laneIndex: 0,
      s: 5,
      spawnedAt: -10,
    })
    net.vehicles['v-orphan'] = v
    tickOobCleanup(makeDeps(), Object.values(net.vehicles), 5.0, 1 / 60)
    expect(removed).toContain('v-orphan')
    expect(respawned).not.toContain('v-orphan')
    const event = getOobEvents().find((e) => e.kind === 'orphan-removed')
    expect(event).toBeDefined()
    expect(event!.reason).toContain('road')
  })

  it('skips vehicles mid lane-change', () => {
    const v = makeTestVehicle({
      id: 'v-changing',
      roadId: 'r-ns',
      laneIndex: 0,
      s: 10,
      spawnedAt: -10,
      desiredLaneIndex: 1,
      laneChangeStartedAt: 0,
    })
    net.vehicles['v-changing'] = v
    v.position = { x: 1000, y: 0, z: 1000 }
    tickOobCleanup(makeDeps(), Object.values(net.vehicles), 5.0, 1 / 60)
    expect(respawned).not.toContain('v-changing')
    expect(removed).not.toContain('v-changing')
    expect(isOobExiting(v)).toBe(false)
  })

  it('skips vehicles spawned < 1s ago', () => {
    const v = makeTestVehicle({ id: 'v-new', roadId: 'r-ns', laneIndex: 0, s: 10, spawnedAt: 4.5 })
    net.vehicles['v-new'] = v
    v.position = { x: 1000, y: 0, z: 1000 }
    tickOobCleanup(makeDeps(), Object.values(net.vehicles), 5.0, 1 / 60)
    expect(respawned).not.toContain('v-new')
    expect(isOobExiting(v)).toBe(false)
  })

  it('skips the vehicle the editor is dragging', () => {
    const v = makeLostVehicle('v-dragged', 10)
    dragging = 'v-dragged'
    tickOobCleanup(makeDeps(), Object.values(net.vehicles), 5.0, 1 / 60)
    // The user is moving it: it must not be braked away or teleported.
    expect(respawned).not.toContain('v-dragged')
    expect(isOobExiting(v)).toBe(false)
  })

  it('leaves the other vehicles alone', () => {
    const lost = makeLostVehicle('v-lost', 12)
    const other = makeTestVehicle({
      id: 'v-other',
      roadId: 'r-ns',
      laneIndex: 1,
      s: 20,
      spawnedAt: -10,
    })
    other.speed = 8
    net.vehicles['v-other'] = other
    const deps = makeDeps()

    for (let i = 0; i < 30; i++) {
      tickOobCleanup(deps, Object.values(net.vehicles), 5.0 + (i + 1) / 60, 1 / 60)
    }

    // The healthy vehicle is untouched — its speed, its lane and its
    // position are exactly what they were.
    expect(other.speed).toBe(8)
    expect(other.laneIndex).toBe(1)
    expect(other.s).toBe(20)
    expect(respawned).not.toContain('v-other')
    expect(lost.speed).toBeLessThan(12)
  })
})

// ---------------------------------------------------------------------------
// The lane guards of the physics path
// ---------------------------------------------------------------------------
//
// The physics path (tick.ts) has two guards that put a vehicle back onto
// its lane when it has drifted off it:
//
//   - the 5 m guard: the body was more than 5 m from its expected lane
//     point → snapped onto that point, speed zeroed;
//   - the lateral-drift guard (15 m): pulled back onto the lane, speed
//     clamped.
//
// They used to be **silent**: the car blinked back onto the road with no
// explanation and no record. The out-of-bounds exit phase never got a
// chance to announce the common case either, because the 5 m guard fires
// first — a vehicle pushed 80 m sideways produced ZERO events.
//
// What is pinned here:
//   1. Both guards record an event with the right kind, the distance it
//      was off its lane, and the speed it was carrying.
//   2. The behaviour of the guards themselves is unchanged — the vehicle
//      is still put back on its lane, at the same speed handling.
//   3. A vehicle that is on its lane records nothing (no event spam).

/**
 * A minimal physics double for the tick's guard path.
 *
 * It holds one body per vehicle and hands its pose back to the tick.
 * `pushOffLane` moves a body sideways so the tick's guard sees it.
 */
interface GuardBody {
  x: number
  z: number
  heading: number
  vx: number
  vz: number
}

const makeGuardWorld = (bodies: Map<string, GuardBody>): RapierWorld => {
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
    setVehiclePosition: (id: string, position: { x: number; y: number; z: number }): void => {
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
    setVehicleHeight: (): void => {},
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

const makeGuardCtx = (rapierWorld: RapierWorld | null): TickContext => ({
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

describe('the lane guards of the physics path', () => {
  let net: RoadNetwork
  let bodies: Map<string, GuardBody>
  let world: RapierWorld

  beforeEach(() => {
    net = buildTestNetwork(0)
    bodies = new Map()
    world = makeGuardWorld(bodies)
    clearOobEvents()
  })

  /**
   * Put a vehicle on lane 0 of `r-ns` and register its body, so the tick
   * has a pose to read.
   */
  const addVehicle = (id: string, s: number, speed: number): Vehicle => {
    const road = net.roads['r-ns']!
    const lp = lanePoint(road, 0, s)
    const v = makeTestVehicle({
      id,
      roadId: 'r-ns',
      laneIndex: 0,
      s,
      speed,
      spawnedAt: -10,
    })
    v.position = { x: lp.position.x, y: 0, z: lp.position.z }
    v.heading = lp.heading
    net.vehicles[id] = v
    bodies.set(id, {
      x: lp.position.x,
      z: lp.position.z,
      heading: lp.heading,
      vx: 0,
      vz: 0,
    })
    return v
  }

  it('records the 5 m guard: the vehicle is put back on its lane, and the event says so', () => {
    const v = addVehicle('v-1', 10, 12)
    const body = bodies.get('v-1')!
    // Push it 8 m sideways — past the 5 m guard's threshold.
    body.x += 8

    tick(net, 1 / 60, 1.0, makeGuardCtx(world))

    const guard = getOobEvents().find((e) => e.kind === 'lane-guard')
    expect(guard).toBeDefined()
    expect(guard!.vehicleId).toBe('v-1')
    expect(guard!.distance).toBeCloseTo(8, 1)
    // The speed it was carrying when the guard fired — NOT the 0 the
    // guard left it with (that is what makes the event diagnosable).
    expect(guard!.speed).toBeGreaterThan(0)
    expect(guard!.reason).toContain('snapped back onto its lane')

    // The behaviour is unchanged: the vehicle is back on its lane, at
    // zero speed (that is what the guard has always done).
    const lp = lanePoint(net.roads['r-ns']!, 0, v.s)
    expect(v.position.x).toBeCloseTo(lp.position.x, 6)
    expect(v.position.z).toBeCloseTo(lp.position.z, 6)
    expect(v.speed).toBe(0)
  })

  it('records a guard event however far the vehicle was pushed off its lane', () => {
    // 80 m sideways — the case that used to produce ZERO events.
    const v = addVehicle('v-1', 10, 12)
    bodies.get('v-1')!.x += 80

    tick(net, 1 / 60, 1.0, makeGuardCtx(world))

    const guards = getOobEvents().filter(
      (e) => e.kind === 'lane-guard' || e.kind === 'lateral-guard',
    )
    expect(guards).toHaveLength(1)
    console.log(
      '[lane guard] event log after an 80 m sideways push:',
      JSON.stringify(getOobEvents()),
    )
    // Whichever guard fired, it reports the truth: how far off the lane
    // the vehicle was, and the speed it was carrying.
    expect(guards[0]!.distance).toBeCloseTo(80, 1)
    expect(guards[0]!.speed).toBeGreaterThan(0)
    // And the vehicle is back on its lane.
    const lp = lanePoint(net.roads['r-ns']!, 0, v.s)
    expect(v.position.x).toBeCloseTo(lp.position.x, 6)
  })

  it('records ONE event per excursion, not one per frame', () => {
    // The guard puts the vehicle back on its lane, so the next frame it
    // is on the lane and the guard does not fire again. (A per-frame
    // event would drown the log — it keeps 64 entries — and would make
    // the panel's "last reason" meaningless.)
    addVehicle('v-1', 10, 12)
    bodies.get('v-1')!.x += 80

    for (let i = 0; i < 30; i++) {
      tick(net, 1 / 60, 1.0 + (i + 1) / 60, makeGuardCtx(world))
    }

    expect(getOobEvents().filter((e) => e.kind === 'lane-guard')).toHaveLength(1)
  })

  it('records the lateral-drift guard with the right kind, distance and speed', () => {
    // The lateral-drift guard is **not reachable through the tick today**:
    // both guards measure against the same reference point
    // (`lanePoint(vRoad, v.laneIndex, v.s)`) and the 5 m guard is the
    // stricter one, so it snaps the vehicle back first and leaves the
    // lateral guard a distance of exactly 0. The recording path is
    // therefore pinned directly — the guard is wired up, and it will
    // report the moment the shadowing is lifted.
    recordLaneGuard({
      kind: 'lateral-guard',
      vehicleId: 'v-9',
      simTime: 4.5,
      distance: 17.5,
      speed: 9.25,
      reason:
        'pulled back onto its lane — it had drifted 17.5 m sideways at 9.2 m/s, and its speed was clamped',
    })

    const guard = getOobEvents().find((e) => e.kind === 'lateral-guard')
    expect(guard).toBeDefined()
    expect(guard!.vehicleId).toBe('v-9')
    expect(guard!.simTime).toBeCloseTo(4.5, 6)
    expect(guard!.distance).toBeCloseTo(17.5, 6)
    expect(guard!.speed).toBeCloseTo(9.25, 6)
    expect(guard!.reason).toContain('pulled back onto its lane')
  })

  it('records nothing for a vehicle that is on its lane', () => {
    addVehicle('v-1', 10, 12)

    tick(net, 1 / 60, 1.0, makeGuardCtx(world))

    expect(getOobEvents().filter((e) => e.kind === 'lane-guard')).toHaveLength(0)
    expect(getOobEvents().filter((e) => e.kind === 'lateral-guard')).toHaveLength(0)
  })

  it('the recorded event reaches the subscribers (the UI panel)', () => {
    const seen: string[] = []
    const unsubscribe = subscribeOobEvents((e) => seen.push(`${e.kind}:${e.vehicleId}`))
    const v = addVehicle('v-1', 10, 12)
    bodies.get('v-1')!.x += 8

    tick(net, 1 / 60, 1.0, makeGuardCtx(world))
    unsubscribe()

    expect(seen).toContain('lane-guard:v-1')
    expect(v.speed).toBe(0)
  })
})
