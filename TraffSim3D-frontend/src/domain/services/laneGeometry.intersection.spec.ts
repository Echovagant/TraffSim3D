// src/domain/services/laneGeometry.intersection.spec.ts
//
// The "stop line at the real intersection" change: the intersection's
// world position is projected onto the road polyline, and that single
// projection feeds the traffic logic (tick.ts) and the painted stop
// lines (RoadMarkingsMesh.ts).
//
// This spec locks:
//   - that the projection is a **centreline** projection (and that
//     `worldToLaneS` is NOT one — it projects onto a lane),
//   - the forward / backward mirroring of the stop line,
//   - the degradation path (a projection that does not fit the road
//     falls back to the road midpoint).

import { describe, it, expect } from 'vitest'
import {
  MAX_INTERSECTION_OFFSET_M,
  intersectionCenterS,
  intersectionSRange,
  inIntersectionBox,
  laneOffset,
  projectIntersectionOnRoad,
  roadLength,
  roadStopLines,
  stopLineSOnRoad,
  worldToCenterlineS,
  worldToLaneS,
} from './laneGeometry'
import type { Intersection } from '@domain/entities/Intersection'
import type { Road } from '@domain/entities/Road'

/** A straight NS road (0,0,0) → (0,0,100). */
const makeStraightRoad = (id = 'r-1', laneCount = 4): Road => ({
  id,
  startNode: { x: 0, y: 0, z: 0 },
  endNode: { x: 0, y: 0, z: 100 },
  laneCount,
  speedLimit: 16.67,
  level: 0,
})

/** An L-shaped road: north 40 m, then east 40 m. */
const makeLRoad = (id = 'r-L', laneCount = 2): Road => ({
  id,
  startNode: { x: 0, y: 0, z: 0 },
  endNode: { x: 40, y: 0, z: 40 },
  waypoints: [
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 40 },
    { x: 40, y: 0, z: 40 },
  ],
  laneCount,
  speedLimit: 16.67,
  level: 0,
})

const makeIntersection = (
  id: string,
  x: number,
  z: number,
  radius = 8,
  connectedRoads: string[] = [],
): Intersection => ({
  id,
  position: { x, y: 0, z },
  trafficLights: [],
  connectedRoads,
  intersectionRadius: radius,
})

describe('worldToCenterlineS — the centreline projection', () => {
  it('projects a point on the centreline onto its arc length', () => {
    const road = makeStraightRoad()
    expect(worldToCenterlineS(road, 0, 0).s).toBeCloseTo(0, 9)
    expect(worldToCenterlineS(road, 0, 30).s).toBeCloseTo(30, 9)
    expect(worldToCenterlineS(road, 0, 100).s).toBeCloseTo(100, 9)
  })

  it('reports the perpendicular distance to the centreline', () => {
    const road = makeStraightRoad()
    expect(worldToCenterlineS(road, 0, 0).distance).toBeCloseTo(0, 9)
    expect(worldToCenterlineS(road, 12, 50).distance).toBeCloseTo(12, 9)
    // The s of an off-centre point is the foot of the perpendicular.
    expect(worldToCenterlineS(road, 12, 50).s).toBeCloseTo(50, 9)
  })

  it('is the offset-0 case of the lane projection (3-lane road, middle lane)', () => {
    // laneOffset(1, 3) === 0 → the middle lane IS the centreline.
    const road = makeStraightRoad('r-3', 3)
    expect(laneOffset(1, 3)).toBe(0)
    for (const z of [0, 17, 63, 100]) {
      expect(worldToLaneS(road, 1, 0, z)).toBeCloseTo(worldToCenterlineS(road, 0, z).s, 9)
    }
  })

  it('is NOT what worldToLaneS computes — that one projects onto a LANE', () => {
    const road = makeLRoad()
    // The outer lane of a 2-lane road sits 1.75 m off the centreline.
    expect(laneOffset(0, 2)).toBeCloseTo(1.75, 9)
    // Near the corner the two projections land on different segments:
    // the centreline foot is at s = 38, the lane foot at s = 40.
    const centre = worldToCenterlineS(road, -5, 38)
    const lane = worldToLaneS(road, 0, -5, 38)
    expect(centre.s).toBeCloseTo(38, 9)
    expect(lane).toBeCloseTo(40, 9)
    expect(Math.abs(lane - centre.s)).toBeGreaterThan(1)
  })
})

describe('projectIntersectionOnRoad', () => {
  it('projects an intersection that sits at the road midpoint onto len/2', () => {
    const road = makeStraightRoad()
    const inter = makeIntersection('i-1', 0, 50)
    const projection = projectIntersectionOnRoad(road, inter)
    expect(projection.projected).toBe(true)
    expect(projection.s).toBeCloseTo(50, 9)
    expect(projection.distance).toBeCloseTo(0, 9)
  })

  it('projects an intersection that sits at a way endpoint onto s = 0 / len', () => {
    const road = makeStraightRoad()
    expect(projectIntersectionOnRoad(road, makeIntersection('i-a', 0, 0)).s).toBeCloseTo(0, 9)
    expect(projectIntersectionOnRoad(road, makeIntersection('i-b', 0, 100)).s).toBeCloseTo(100, 9)
  })

  it('falls back to the road midpoint when the intersection is too far away', () => {
    const road = makeStraightRoad()
    const len = roadLength(road)
    // 40 m off the road — beyond MAX_INTERSECTION_OFFSET_M.
    const inter = makeIntersection('i-far', 0, 20)
    const projection = projectIntersectionOnRoad(road, {
      ...inter,
      position: { x: 40, y: 0, z: 20 },
    })
    expect(projection.projected).toBe(false)
    expect(projection.s).toBeCloseTo(len / 2, 9)
    expect(projection.distance).toBeCloseTo(40, 9)
  })

  it('keeps a projection that is just inside the threshold', () => {
    const road = makeStraightRoad()
    const offset = MAX_INTERSECTION_OFFSET_M - 0.5
    const projection = projectIntersectionOnRoad(road, {
      ...makeIntersection('i-edge', 0, 50),
      position: { x: offset, y: 0, z: 50 },
    })
    expect(projection.projected).toBe(true)
    expect(projection.s).toBeCloseTo(50, 9)
  })

  it('intersectionCenterS is the projection (midpoint fallback included)', () => {
    const road = makeStraightRoad()
    expect(intersectionCenterS(road, makeIntersection('i-1', 0, 20))).toBeCloseTo(20, 9)
    expect(
      intersectionCenterS(road, {
        ...makeIntersection('i-far', 0, 20),
        position: { x: 500, y: 0, z: 20 },
      }),
    ).toBeCloseTo(50, 9)
  })
})

describe('stopLineSOnRoad — the direction-aware stop line', () => {
  const road = makeStraightRoad('r-1', 4)
  // The intersection sits 20 m along the road, NOT at the midpoint.
  const inter = makeIntersection('i-1', 0, 20, 8, ['r-1'])

  it('puts the forward stop line before the intersection centre', () => {
    // lane 0 / 1 are the forward lanes (laneCount 4 → forward = 0, 1).
    expect(stopLineSOnRoad(road, inter, 0)).toBeCloseTo(12, 9)
    expect(stopLineSOnRoad(road, inter, 1)).toBeCloseTo(12, 9)
  })

  it('mirrors the stop line for the backward lanes', () => {
    // lane 2 / 3 are the backward lanes: they travel towards a SMALLER s,
    // so their stop line is on the far side of the intersection centre.
    expect(stopLineSOnRoad(road, inter, 2)).toBeCloseTo(28, 9)
    expect(stopLineSOnRoad(road, inter, 3)).toBeCloseTo(28, 9)
  })

  it('keeps the built-in midpoint case numerically identical to the old formula', () => {
    const mid = makeIntersection('i-mid', 0, 50, 8, ['r-1'])
    // The old formula was `len / 2 - radius` for every lane.
    expect(stopLineSOnRoad(road, mid, 0)).toBeCloseTo(50 - 8, 9)
    // The backward line is the mirror of it around the centre.
    expect(stopLineSOnRoad(road, mid, 3)).toBeCloseTo(50 + 8, 9)
  })

  it('returns null when the stop line would fall outside the road', () => {
    // The intersection sits at the road start: the forward lanes drive
    // AWAY from it, so there is no forward stop line.
    const atStart = makeIntersection('i-start', 0, 0, 8, ['r-1'])
    expect(stopLineSOnRoad(road, atStart, 0)).toBeNull()
    expect(stopLineSOnRoad(road, atStart, 3)).toBeCloseTo(8, 9)
    // …and symmetrically at the road end.
    const atEnd = makeIntersection('i-end', 0, 100, 8, ['r-1'])
    expect(stopLineSOnRoad(road, atEnd, 3)).toBeNull()
    expect(stopLineSOnRoad(road, atEnd, 0)).toBeCloseTo(92, 9)
  })

  it('falls back to the midpoint when the projection is rejected', () => {
    const far = {
      ...makeIntersection('i-far', 0, 20, 8, ['r-1']),
      position: { x: 300, y: 0, z: 20 },
    }
    expect(stopLineSOnRoad(road, far, 0)).toBeCloseTo(42, 9) // len/2 - radius
    expect(stopLineSOnRoad(road, far, 3)).toBeCloseTo(58, 9) // len/2 + radius
  })
})

describe('intersectionSRange / inIntersectionBox', () => {
  const road = makeStraightRoad('r-1', 4)
  const inter = makeIntersection('i-1', 0, 20, 8, ['r-1'])

  it('centres the box on the projected intersection', () => {
    expect(intersectionSRange(road, 8, inter)).toEqual([12, 28])
  })

  it('keeps the midpoint assumption when no intersection is given', () => {
    expect(intersectionSRange(road, 8)).toEqual([42, 58])
  })

  it('agrees with the stop line on the box edges', () => {
    const [lo, hi] = intersectionSRange(road, 8, inter)
    expect(lo).toBeCloseTo(stopLineSOnRoad(road, inter, 0) as number, 9)
    expect(hi).toBeCloseTo(stopLineSOnRoad(road, inter, 3) as number, 9)
    expect(inIntersectionBox(road, 12, 8, inter)).toBe(true)
    expect(inIntersectionBox(road, 28, 8, inter)).toBe(true)
    expect(inIntersectionBox(road, 11.9, 8, inter)).toBe(false)
    expect(inIntersectionBox(road, 28.1, 8, inter)).toBe(false)
  })
})

describe('roadStopLines', () => {
  const road = makeStraightRoad('r-1', 4)

  it('returns one line per approach of a connected intersection', () => {
    const inter = makeIntersection('i-1', 0, 50, 8, ['r-1'])
    expect(roadStopLines(road, [inter])).toEqual([42, 58])
  })

  it('ignores intersections that are not connected to the road', () => {
    const other = makeIntersection('i-other', 0, 50, 8, ['r-other'])
    expect(roadStopLines(road, [other])).toEqual([])
  })

  it('returns nothing for a road without an intersection', () => {
    expect(roadStopLines(road, [])).toEqual([])
  })

  it('merges the approaches of two intersections on the same road', () => {
    const north = makeIntersection('i-n', 0, 0, 8, ['r-1'])
    const south = makeIntersection('i-s', 0, 100, 8, ['r-1'])
    // north: no forward line (it sits at the road start), backward at 8.
    // south: forward at 92, no backward line (it sits at the road end).
    expect(roadStopLines(road, [north, south])).toEqual([8, 92])
  })
})
