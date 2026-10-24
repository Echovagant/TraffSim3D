// src/domain/services/approachAxis.spec.ts
//
// The axis of an approach — the ONE place the frontend decides which axis
// a road approaches a junction on.
//
// The tests are written against two sources:
//
// 1. **Synthetic geometry**, for the rules themselves (a straight road, a
//    road that turns, a junction that is too far off the road).
// 2. **A real backend payload** — the parser's own output for two
//    junctions of the Shenzhen extract, with the lights the backend
//    attached. The frontend has to reach the same axis for the same
//    geometry: the backend decides which light exists, the frontend picks
//    the light that holds a vehicle.
//
// The payload was produced by
// `app/apps/maps/osm_parser.py` -> `parse_osm_xml` on the real extract
// (the same waypoints, rounded to 4 decimals).

import { describe, it, expect } from 'vitest'
import { approachAxis, approachAxisGroups, roadPolylineAxis } from './approachAxis'
import { normalizeOsmPayload } from '@infrastructure/api/osmNetworkAdapter'
import type { Intersection } from '@domain/entities/Intersection'
import type { Road } from '@domain/entities/Road'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const junction = (x: number, z: number, connectedRoads: string[] = []): Intersection => ({
  id: 'i-1',
  position: { x, y: 0, z },
  trafficLights: [],
  connectedRoads,
  intersectionRadius: 8,
})

/** A straight 2-point road. */
const straight = (id: string, a: [number, number], b: [number, number]): Road => ({
  id,
  startNode: { x: a[0], y: 0, z: a[1] },
  endNode: { x: b[0], y: 0, z: b[1] },
  laneCount: 2,
  speedLimit: 13.89,
  level: 0,
})

/** A polyline road. */
const polyline = (id: string, points: Array<[number, number]>): Road => ({
  id,
  startNode: { x: points[0]![0], y: 0, z: points[0]![1] },
  endNode: { x: points[points.length - 1]![0], y: 0, z: points[points.length - 1]![1] },
  waypoints: points.map(([x, z]) => ({ x, y: 0, z })),
  laneCount: 2,
  speedLimit: 13.89,
  level: 0,
})

// ---------------------------------------------------------------------------
// the rule
// ---------------------------------------------------------------------------

describe('approachAxis — the axis of a road at the junction', () => {
  it('a straight north–south road approaches on the ns axis', () => {
    const road = straight('r-ns', [0, -50], [0, 50])
    expect(approachAxis(road, junction(0, 0))).toBe('ns')
  })

  it('a straight east–west road approaches on the ew axis', () => {
    const road = straight('r-ew', [-50, 0], [50, 0])
    expect(approachAxis(road, junction(0, 0))).toBe('ew')
  })

  it('reads the LOCAL tangent, not the road’s whole extent', () => {
    // The road runs 100 m east and then 10 m north. Its extent is
    // east–west (`ew`), but the junction sits on the last 10 m, where the
    // road runs north–south — so **that** junction's approach is `ns`.
    const road = polyline('r-turn', [
      [0, 0],
      [100, 0],
      [100, 10],
    ])
    expect(roadPolylineAxis(road)).toBe('ew')
    expect(approachAxis(road, junction(100, 5))).toBe('ns')
    // ... while on the long east–west leg it is an `ew` approach.
    expect(approachAxis(road, junction(50, 0))).toBe('ew')
  })

  it('a road that turns the other way reads the other axis', () => {
    // The mirror image: 100 m north and then 10 m east.
    const road = polyline('r-turn-2', [
      [0, 0],
      [0, 100],
      [10, 100],
    ])
    expect(roadPolylineAxis(road)).toBe('ns')
    expect(approachAxis(road, junction(5, 100))).toBe('ew')
    expect(approachAxis(road, junction(0, 50))).toBe('ns')
  })

  it('falls back to the road’s extent when the junction is too far off the road', () => {
    // 40 m off the centreline — beyond MAX_INTERSECTION_OFFSET_M (30 m),
    // so the projection is rejected and the road is not really on this
    // junction.
    const road = straight('r-ew', [-50, 0], [50, 0])
    const far = junction(0, 40)
    expect(approachAxis(road, far)).toBe('ew')
    const farNs = straight('r-ns', [0, -50], [0, 50])
    expect(approachAxis(farNs, far)).toBe('ns')
  })

  it('a junction right on the road is trusted', () => {
    const road = straight('r-ew', [-50, 0], [50, 0])
    expect(approachAxis(road, junction(0, 29))).toBe('ew')
  })
})

describe('approachAxisGroups — the axis groups of a junction', () => {
  it('groups the north and south arms of a crossroads together', () => {
    const roads: Record<string, Road> = {
      'r-n': straight('r-n', [0, 0], [0, -50]),
      'r-s': straight('r-s', [0, 0], [0, 50]),
      'r-e': straight('r-e', [0, 0], [50, 0]),
      'r-w': straight('r-w', [0, 0], [-50, 0]),
    }
    const inter = junction(0, 0, ['r-n', 'r-s', 'r-e', 'r-w'])
    expect(approachAxisGroups(inter, roads).sort()).toEqual(['ew', 'ns'])
  })

  it('a junction whose roads are all on one axis has one group', () => {
    const roads: Record<string, Road> = {
      'r-e': straight('r-e', [0, 0], [50, 0]),
      'r-w': straight('r-w', [0, 0], [-50, 0]),
    }
    const inter = junction(0, 0, ['r-e', 'r-w'])
    expect(approachAxisGroups(inter, roads)).toEqual(['ew'])
  })

  it('a junction without roads has no group', () => {
    expect(approachAxisGroups(junction(0, 0, []), {})).toEqual([])
  })

  it('skips roads the network does not have', () => {
    const roads: Record<string, Road> = { 'r-n': straight('r-n', [0, 0], [0, -50]) }
    const inter = junction(0, 0, ['r-n', 'r-missing'])
    expect(approachAxisGroups(inter, roads)).toEqual(['ns'])
  })
})

// ---------------------------------------------------------------------------
// the real backend payload
// ---------------------------------------------------------------------------

/**
 * The parser's own output for two junctions of the Shenzhen extract
 * (`geojson/福田中心(深圳).osm`), as the HTTP endpoint would answer it.
 *
 * - `i-osm-7395` is a **two-light** junction: the backend found two axis
 *   groups among its approaches and lit both.
 * - `i-osm-15` is the case the old rule got wrong: the road
 *   `w-1085245509` runs mostly east–west (its extent is `ew`), but where
 *   it meets the junction it travels **north** — so its approach is `ns`.
 */
const PAYLOAD = {
  roads: [
    {
      id: 'w-1050765294',
      startNode: { x: -9610.114, y: 0, z: 2345.9984 },
      endNode: { x: -10121.826, y: 0, z: 2661.3605 },
      waypoints: [
        { x: -9610.114, y: 0, z: 2345.9984 },
        { x: -9839.838, y: 0, z: 2490.6536 },
        { x: -9856.9381, y: 0, z: 2500.9433 },
        { x: -9895.6389, y: 0, z: 2523.221 },
        { x: -9930.3313, y: 0, z: 2544.5108 },
        { x: -10030.8201, y: 0, z: 2611.4436 },
        { x: -10121.826, y: 0, z: 2661.3605 },
      ],
      laneCount: 1,
      speedLimit: 13.89,
      level: 0,
    },
    {
      id: 'w-1447075661',
      startNode: { x: -9898.3659, y: 0, z: 2518.448 },
      endNode: { x: -9767.2342, y: 0, z: 2739.3935 },
      waypoints: [
        { x: -9898.3659, y: 0, z: 2518.448 },
        { x: -9895.6389, y: 0, z: 2523.221 },
        { x: -9881.2043, y: 0, z: 2548.0406 },
        { x: -9846.3992, y: 0, z: 2606.4821 },
        { x: -9767.2342, y: 0, z: 2739.3935 },
      ],
      laneCount: 2,
      speedLimit: 13.89,
      level: 0,
    },
    {
      id: 'w-1085245509',
      startNode: { x: -7851.2615, y: 0, z: -318.6787 },
      endNode: { x: -7822.9663, y: 0, z: -296.7673 },
      waypoints: [
        { x: -7851.2615, y: 0, z: -318.6787 },
        { x: -7845.1924, y: 0, z: -308.9218 },
        { x: -7836.5603, y: 0, z: -302.3284 },
        { x: -7822.9663, y: 0, z: -296.7673 },
      ],
      laneCount: 1,
      speedLimit: 13.89,
      level: 0,
    },
  ],
  intersections: [
    {
      id: 'i-osm-7395',
      position: { x: -9895.6389, y: 0, z: 2523.221 },
      connectedRoads: ['w-1050765294', 'w-1447075661'],
      trafficLights: [
        {
          id: 'tl-7396-ew',
          position: { x: -9898.6389, y: 0, z: 2523.221 },
          phase: 'red',
          phaseRemaining: 30,
          cycleSeconds: 63,
          axis: 'ew',
        },
        {
          id: 'tl-7396-ns',
          position: { x: -9895.6389, y: 0, z: 2520.221 },
          phase: 'green',
          phaseRemaining: 30,
          cycleSeconds: 63,
          axis: 'ns',
        },
      ],
      intersectionRadius: 6.25,
    },
    {
      id: 'i-osm-15',
      position: { x: -7851.2615, y: 0, z: -318.6787 },
      connectedRoads: ['w-1085245509'],
      trafficLights: [],
      intersectionRadius: 6.25,
    },
  ],
  vehicles: [],
  spawnPoints: [],
}

describe('the frontend agrees with the backend about the axis', () => {
  const imported = normalizeOsmPayload(PAYLOAD)
  const net = imported.network

  it('imports the backend payload with both lights of the two-light junction', () => {
    const inter = net.intersections['i-osm-7395']!
    expect(inter.trafficLights.map((l) => l.axis).sort()).toEqual(['ew', 'ns'])
    expect(imported.stats.lights).toBe(2)
  })

  it('classifies the approaches exactly the way the backend did', () => {
    const inter = net.intersections['i-osm-7395']!
    // The backend's own axes, read off the lights it attached.
    const backendAxes = inter.trafficLights.map((l) => l.axis).sort()
    // The frontend's own computation, from the same geometry.
    const frontendAxes = approachAxisGroups(inter, net.roads).sort()
    expect(frontendAxes).toEqual(backendAxes)
  })

  it('every approach of the junction falls on an axis the backend lit', () => {
    const inter = net.intersections['i-osm-7395']!
    const lit = new Set(inter.trafficLights.map((l) => l.axis))
    for (const roadId of inter.connectedRoads) {
      const axis = approachAxis(net.roads[roadId]!, inter)
      expect(lit.has(axis), `${roadId} approaches on ${axis}`).toBe(true)
    }
  })

  it('reads the approach, not the extent, where the two disagree', () => {
    // The backend's geometry: the road's extent is `ew`, but at the
    // junction it travels north — so its approach is `ns`. The old rule
    // (the road's extent) would have called this an east–west approach.
    const inter = net.intersections['i-osm-15']!
    const road = net.roads['w-1085245509']!
    expect(roadPolylineAxis(road)).toBe('ew')
    expect(approachAxis(road, inter)).toBe('ns')
  })
})
