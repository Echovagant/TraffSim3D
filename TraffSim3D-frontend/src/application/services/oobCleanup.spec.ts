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
  OOB_EXIT_MAX_DISTANCE_M,
  OOB_EXIT_MAX_SECONDS,
  type TickOobDeps,
} from './oobCleanup'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'

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
