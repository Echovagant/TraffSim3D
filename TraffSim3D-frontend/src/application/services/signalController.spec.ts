import { describe, it, expect } from 'vitest'
import { getQueueLength, getAxisQueueLength, roadAxis } from './signalController'
import { buildTestNetwork, makeTestLight, makeTestVehicle } from '@__fixtures__/testNetwork'
import { STOP_LINE_DISTANCE } from '@shared/constants/simulation'
import { roadLength } from '@domain/services/laneGeometry'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { TrafficLight } from '@domain/entities/TrafficLight'
import { buildCrossIntersectionNetwork } from '@application/services/defaultScene'
import {
  buildImportedNetwork,
  importedNsLight,
  importedEwLight,
  IMPORTED_EW_ROAD_ID,
  IMPORTED_BRANCH_ROAD_ID,
  IMPORTED_NS_ROAD_ID,
} from '@__fixtures__/importedNetwork'

describe('getQueueLength', () => {
  it('returns 0 for empty network', () => {
    const net = buildTestNetwork(0)
    const light = makeTestLight()
    expect(getQueueLength(light, net)).toBe(0)
  })
  it("counts a single car on the light's axis lane before stop line", () => {
    const net = buildTestNetwork(1)
    const light = makeTestLight()
    expect(getQueueLength(light, net)).toBe(1)
  })
  it('excludes cars past the stop line', () => {
    const net = buildTestNetwork(1)
    const light = makeTestLight()
    const len = roadLength(net.roads['r-ns']!)
    net.vehicles['v-1']!.s = len / 2 + STOP_LINE_DISTANCE + 1
    expect(getQueueLength(light, net)).toBe(0)
  })
  it('excludes crashed cars (007 R2 mitigation)', () => {
    const net = buildTestNetwork(1)
    const light = makeTestLight()
    net.vehicles['v-1']!.status = 'crashed'
    expect(getQueueLength(light, net)).toBe(0)
  })
  it('excludes cars in the intersection box (enteredIntersectionAt !== null)', () => {
    const net = buildTestNetwork(1)
    const light = makeTestLight()
    net.vehicles['v-1']!.enteredIntersectionAt = 1.5
    expect(getQueueLength(light, net)).toBe(0)
  })
  it('respects controlledLane filter', () => {
    const net = buildTestNetwork(2)
    const light = makeTestLight({ controlledLane: 0 })
    net.vehicles['v-1']!.laneIndex = 0
    net.vehicles['v-2']!.laneIndex = 1
    expect(getQueueLength(light, net)).toBe(1)
  })
  it('ignores cars on the wrong road', () => {
    const net = buildTestNetwork(2)
    const light = makeTestLight()
    net.vehicles['v-2']!.roadId = 'r-ew'
    expect(getQueueLength(light, net)).toBe(1)
  })
  it('getAxisQueueLength counts across all lanes on the axis', () => {
    const net = buildTestNetwork(2)
    const light = makeTestLight()
    net.vehicles['v-1']!.laneIndex = 0
    net.vehicles['v-2']!.laneIndex = 1
    expect(getAxisQueueLength(light, net)).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// The queue lookup: topology, not the `r-${axis}` id convention
// ---------------------------------------------------------------------------

/**
 * The queue lookup **as it was before the fix** (commit 1f72158,
 * `src/application/services/signalController.ts`): the road was found by
 * the `r-${axis}` id convention.
 *
 * It is kept here as the reference the new implementation is measured
 * against. The point of the fix is the shape of the difference: the two
 * agree **bit for bit** on the built-in demo network, and the old one
 * is structurally 0 on an imported map.
 */
const legacyAxisQueueLength = (light: TrafficLight, network: RoadNetwork): number => {
  const roadId = `r-${light.axis}`
  const road = network.roads[roadId]
  if (!road) return 0
  const stopLineS = roadLength(road) / 2 - STOP_LINE_DISTANCE
  let count = 0
  for (const v of Object.values(network.vehicles)) {
    if (v.roadId !== road.id) continue
    if (v.status === 'crashed') continue
    if (v.enteredIntersectionAt !== null) continue
    if (v.s >= stopLineS) continue
    if (v.s < 0) continue
    count += 1
  }
  return count
}

const legacyQueueLength = (light: TrafficLight, network: RoadNetwork): number => {
  const roadId = `r-${light.axis}`
  const road = network.roads[roadId]
  if (!road) return 0
  const stopLineS = roadLength(road) / 2 - STOP_LINE_DISTANCE
  let count = 0
  for (const v of Object.values(network.vehicles)) {
    if (v.roadId !== road.id) continue
    if (v.status === 'crashed') continue
    if (light.controlledLane !== undefined && v.laneIndex !== light.controlledLane) continue
    if (v.enteredIntersectionAt !== null) continue
    if (v.s >= stopLineS) continue
    if (v.s < 0) continue
    count += 1
  }
  return count
}

describe('roadAxis — the geometric axis of a road', () => {
  it('classifies a straight NS road (runs along Z) as ns', () => {
    const net = buildTestNetwork(0)
    expect(roadAxis(net.roads['r-ns']!)).toBe('ns')
  })
  it('classifies a straight EW road (runs along X) as ew', () => {
    const net = buildTestNetwork(0)
    expect(roadAxis(net.roads['r-ew']!)).toBe('ew')
  })
  it('classifies a polyline road by the distance it travels on each axis', () => {
    const net = buildImportedNetwork()
    // The branch road runs mostly along X (45 m east, 25 m north).
    expect(roadAxis(net.roads[IMPORTED_BRANCH_ROAD_ID]!)).toBe('ew')
    expect(roadAxis(net.roads[IMPORTED_NS_ROAD_ID]!)).toBe('ns')
    expect(roadAxis(net.roads[IMPORTED_EW_ROAD_ID]!)).toBe('ew')
  })
})

describe('queue lookup — the built-in demo scene', () => {
  it('agrees with the legacy numbers except where the legacy window was wrong', () => {
    const net = buildCrossIntersectionNetwork()
    const lights = net.intersections['i-center']!.trafficLights
    const ns = lights.find((l) => l.axis === 'ns')!
    const ew = lights.find((l) => l.axis === 'ew')!

    // The legacy lookup, for reference.
    expect(legacyAxisQueueLength(ns, net)).toBe(2)
    expect(legacyAxisQueueLength(ew, net)).toBe(2)

    // The new lookup counts one more vehicle — and it is right to.
    //
    // The legacy queue window was the road's midpoint minus a fixed 5 m
    // (25 m on a 60 m road), while the line the simulation actually
    // enforces is the edge of the intersection box (22 m for a forward
    // lane, **38 m for a backward lane** — the backward lane approaches
    // the junction from the far end). The legacy window therefore
    // excluded the backward-lane vehicle that was visibly queueing for
    // the red light: it sat at s = 41.99, which is 4 m *before* the
    // stop line it was waiting for, but 17 m *past* the legacy window.
    //
    // The queue now forms against the line the light actually holds
    // vehicles at, so the actuated controller reasons about the traffic
    // that is really waiting.
    expect(getAxisQueueLength(ns, net)).toBe(3)
    expect(getAxisQueueLength(ew, net)).toBe(3)

    // The backward-lane vehicle is the one the legacy window missed.
    const backward = Object.values(net.vehicles).find(
      (v) => v.roadId === 'r-ns' && v.laneIndex >= 3,
    )
    expect(backward).toBeDefined()
    expect(backward!.s).toBeGreaterThan(38) // still approaching the stop line
    expect(backward!.s).toBeLessThan(60)
  })
})

describe('queue lookup — an imported OSM map is no longer structurally 0', () => {
  /** A fresh sim time per assertion — a new tick re-counts. */
  let tick = 0

  /**
   * Asserts the queue on **both** code paths: the direct scan (no sim
   * time) and the per-tick index (a fresh sim time, so the index is
   * rebuilt from the current vehicles).
   *
   * The two paths must always agree — that is what makes the per-tick
   * index a pure optimisation.
   */
  const expectBothPaths = (
    light: TrafficLight,
    net: RoadNetwork,
    expected: number,
    laneScoped = false,
  ): void => {
    const fn = laneScoped ? getQueueLength : getAxisQueueLength
    expect(fn(light, net)).toBe(expected)
    expect(fn(light, net, ++tick)).toBe(expected)
  }

  it('finds the road by topology: the queue is the real queue, not 0', () => {
    const net = buildImportedNetwork()
    const ns = importedNsLight(net)

    // The old lookup found no `r-ns` road in an imported map.
    expect(legacyAxisQueueLength(ns, net)).toBe(0)
    expect(legacyQueueLength(ns, net)).toBe(0)

    // The new lookup finds `w-101` through the intersection.
    expectBothPaths(ns, net, 2)
    expectBothPaths(ns, net, 2, true)
  })

  it('counts the EW axis of an imported map as well', () => {
    const net = buildImportedNetwork()
    const ew = importedEwLight(net)
    expect(legacyAxisQueueLength(ew, net)).toBe(0)
    expectBothPaths(ew, net, 2)
  })

  it('decides the axis by geometry: the NS light ignores the EW roads', () => {
    const net = buildImportedNetwork()
    const ns = importedNsLight(net)

    // The intersection has one NS road and two EW roads; the cars on
    // the EW roads must not be counted for the NS axis.
    expect(net.intersections['i-osm-1']!.connectedRoads).toContain(IMPORTED_EW_ROAD_ID)
    expect(net.intersections['i-osm-1']!.connectedRoads).toContain(IMPORTED_BRANCH_ROAD_ID)

    expectBothPaths(ns, net, 2) // only the 2 cars on w-101
    expect(net.vehicles['v-osm-ew-1']).toBeDefined()
    expect(net.vehicles['v-osm-branch-1']).toBeDefined()

    // ... while the EW light sees both EW roads.
    expectBothPaths(importedEwLight(net), net, 2)
  })

  it('controlledLane narrows getQueueLength but not getAxisQueueLength', () => {
    const net = buildImportedNetwork()
    const ns = importedNsLight(net)
    ns.controlledLane = 0 // the two NS cars sit on lane 0 and lane 1

    expectBothPaths(ns, net, 1, true)
    expectBothPaths(ns, net, 2)
  })

  it('a light that belongs to no intersection falls back to the whole network', () => {
    // The Simulation Lab synthesises an axis-only light (see
    // SimulationLabView.vue) — it is in no intersection at all.
    const net = buildImportedNetwork()
    const stub = makeTestLight({ id: '__queue_ns', axis: 'ns' })
    expect(net.intersections['i-osm-1']!.trafficLights.some((l) => l.id === stub.id)).toBe(false)
    expectBothPaths(stub, net, 2)
  })

  it('still excludes crashed cars, cars in the box and cars past the stop line', () => {
    const net = buildImportedNetwork()
    const ns = importedNsLight(net)
    expectBothPaths(ns, net, 2)

    net.vehicles['v-osm-ns-1']!.status = 'crashed'
    expectBothPaths(ns, net, 1)

    net.vehicles['v-osm-ns-1']!.status = 'driving'
    net.vehicles['v-osm-ns-1']!.enteredIntersectionAt = 3
    expectBothPaths(ns, net, 1)

    net.vehicles['v-osm-ns-1']!.enteredIntersectionAt = null
    net.vehicles['v-osm-ns-1']!.s = 100 // past the stop line (60 - 5)
    expectBothPaths(ns, net, 1)
  })

  it('the per-tick index and the direct scan give the same numbers', () => {
    const net = buildImportedNetwork()
    const ns = importedNsLight(net)
    // With a sim time the queue is counted once for the whole tick;
    // without one the vehicles are scanned directly. Both must agree.
    expect(getAxisQueueLength(ns, net, 42)).toBe(2)
    expect(getAxisQueueLength(ns, net)).toBe(2)
    expect(getQueueLength(ns, net, 42)).toBe(2)
    expect(getQueueLength(ns, net)).toBe(2)
  })

  it('a new sim time re-counts the vehicles', () => {
    const net = buildImportedNetwork()
    const ns = importedNsLight(net)
    expect(getAxisQueueLength(ns, net, 1)).toBe(2)

    // Within one tick the signals are all decided before any vehicle
    // moves, so the count of that tick is fixed (this is what makes the
    // per-tick index safe).
    delete net.vehicles['v-osm-ns-1']
    expect(getAxisQueueLength(ns, net, 1)).toBe(2)

    // The next tick counts again.
    expect(getAxisQueueLength(ns, net, 2)).toBe(1)
  })
})
