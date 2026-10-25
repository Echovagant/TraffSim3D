// src/infrastructure/rendering/RoadMarkingsMesh.spec.ts
//
// Markings are painted decals derived from the road polyline. What gets
// painted (and how much of it) is a function of laneCount + arc length,
// so assert the painted geometry layer by layer.
//
// The whole network's paint lives in ONE line mesh now, with the colour
// of each segment carried as a vertex colour — so the assertions read
// the segments back out of that one mesh, grouped by colour.

import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createRoadMarkings } from './RoadMarkingsMesh'
import { makeTestRoad, makePolylineRoad } from '@__fixtures__/testNetwork'
import { ROAD_LANE_WIDTH } from '@shared/constants/simulation'
import type { Intersection } from '@domain/entities/Intersection'

/** r-ns: (0,0,-30) -> (0,0,30), length 60, tangent (0,1). */
const ns2 = makeTestRoad('r-ns', 'ns', 2)

/**
 * A junction on `roadId` at the given world position.
 *
 * The stop lines are painted where the junction projects onto the road
 * (see `roadStopLines`), so the position decides where they land: a
 * junction at the road midpoint paints them at `mid ± radius`.
 */
const junctionAt = (roadId: string, x: number, z: number, radius = 8): Intersection => ({
  id: 'i-1',
  position: { x, y: 0, z },
  trafficLights: [],
  connectedRoads: [roadId],
  intersectionRadius: radius,
})

interface PaintedSegment {
  color: THREE.Color
  a: [number, number, number]
  b: [number, number, number]
}

/** Every painted segment of the group, in the order it was emitted. */
const painted = (g: THREE.Group): PaintedSegment[] => {
  const out: PaintedSegment[] = []
  for (const child of g.children) {
    if (!(child instanceof THREE.LineSegments)) continue
    const pos = child.geometry.attributes.position!.array as Float32Array
    const col = child.geometry.attributes.color!.array as Float32Array
    for (let i = 0; i < pos.length; i += 6) {
      out.push({
        color: new THREE.Color(col[i]!, col[i + 1]!, col[i + 2]!),
        a: [pos[i]!, pos[i + 1]!, pos[i + 2]!],
        b: [pos[i + 3]!, pos[i + 4]!, pos[i + 5]!],
      })
    }
  }
  return out
}

/** The segments painted in one colour (the colours are the layer tags). */
const segmentsWithColor = (g: THREE.Group, hex: number): PaintedSegment[] => {
  const wanted = new THREE.Color(hex)
  return painted(g).filter(
    (s) =>
      Math.abs(s.color.r - wanted.r) < 1e-6 &&
      Math.abs(s.color.g - wanted.g) < 1e-6 &&
      Math.abs(s.color.b - wanted.b) < 1e-6,
  )
}

const CENTERLINE = 0xfacc15
const DIVIDER = 0xe2e8f0
const WHITE = 0xffffff

describe('createRoadMarkings — 2-lane road (length 60)', () => {
  const g = createRoadMarkings([ns2], { intersections: [junctionAt('r-ns', 0, 0)] })

  it('paints one line mesh for the whole network', () => {
    expect(g.children).toHaveLength(1)
    expect(g.children[0]).toBeInstanceOf(THREE.LineSegments)
  })

  it('paints a yellow centerline from the first to the last waypoint', () => {
    const centerline = segmentsWithColor(g, CENTERLINE)
    expect(centerline).toHaveLength(1)
    const p = centerline[0]!
    expect(p.a[0]).toBeCloseTo(0, 6)
    expect(p.a[1]).toBeCloseTo(0.02, 6) // lifted off the road surface
    expect(p.a[2]).toBeCloseTo(-30, 6)
    expect(p.b[2]).toBeCloseTo(30, 6)
    // An odd lane count has no centre divider — the road is single-sided.
    const odd = createRoadMarkings([makeTestRoad('r-ns3', 'ns', 3)], {
      intersections: [junctionAt('r-ns3', 0, 0)],
    })
    expect(segmentsWithColor(odd, CENTERLINE)).toHaveLength(0)
  })

  it('divides the 2 lanes with one dashed line at offset +3.5 (= laneWidth)', () => {
    const dividers = segmentsWithColor(g, DIVIDER)
    // floor((60 + 0.6) / 1.2) = 50 dashes, 2 endpoints each
    expect(dividers).toHaveLength(50)
    expect(dividers[0]!.a[0]).toBeCloseTo(3.5, 5)
    expect(dividers[0]!.a[1]).toBeCloseTo(0.02, 6)
    expect(dividers[0]!.a[2]).toBeCloseTo(-30, 5)
    expect(dividers[0]!.b[2]).toBeCloseTo(-29.4, 5) // first dash is DASH = 0.6 long
  })

  it('draws one white stop line per approach, at the junction edges', () => {
    const stops = segmentsWithColor(g, WHITE)
    // 2 stop lines — the 2-lane road paints no arrows.
    expect(stops).toHaveLength(2)
    const halfWidth = (ROAD_LANE_WIDTH * ns2.laneCount) / 2
    // The junction sits at the road midpoint (s = 30) with radius 8, so
    // the lines land at s = 22 (z = -8) and s = 38 (z = +8) — the edges
    // of the junction box, not at the road ends.
    expect(stops[0]!.a[0]).toBeCloseTo(-halfWidth, 5)
    expect(stops[0]!.a[2]).toBeCloseTo(-8, 5)
    expect(stops[0]!.a[1]).toBeCloseTo(0.03, 6)
    expect(stops[0]!.b[0]).toBeCloseTo(halfWidth, 5)
    expect(stops[1]!.a[2]).toBeCloseTo(8, 5)
    expect(stops[1]!.b[2]).toBeCloseTo(8, 5)
  })

  it('paints no stop line at all on a road without a junction', () => {
    const bare = createRoadMarkings([ns2])
    expect(segmentsWithColor(bare, WHITE)).toHaveLength(0)
  })

  it('paints no lane arrows for a 2-lane road', () => {
    // Arrows are the only other white paint; the divider batch has 50 dashes.
    expect(segmentsWithColor(g, DIVIDER)).toHaveLength(50)
    expect(segmentsWithColor(g, CENTERLINE)).toHaveLength(1)
  })
})

describe('createRoadMarkings — 3-lane road', () => {
  const road = makePolylineRoad(
    'r-3',
    [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 60 },
    ],
    3,
  )
  // The junction sits at the road midpoint (s = 30 of 60).
  const g = createRoadMarkings([road], { intersections: [junctionAt('r-3', 0, 30)] })

  it('has 2 divider offsets (5.25 and 1.75) but no centerline', () => {
    const dividers = segmentsWithColor(g, DIVIDER)
    expect(dividers).toHaveLength(2 * 50) // 2 offsets x 50 dashes
    expect(segmentsWithColor(g, CENTERLINE)).toHaveLength(0)
  })

  it('emits 2 arrows per lane (s = 0.2L and 0.8L), each an 8-point "up" arrow', () => {
    const white = segmentsWithColor(g, WHITE)
    // 2 stop lines + 6 arrows x 4 segments
    expect(white).toHaveLength(2 + 3 * 2 * 4)
    // Every arrow segment lies flat on the road, 0.025u above the markings layer.
    const arrows = white.slice(2)
    for (const a of arrows) {
      expect(a.a[1]).toBeCloseTo(0.025, 6)
      expect(a.b[1]).toBeCloseTo(0.025, 6)
    }
  })

  it("places the first lane's arrows on its centreline offset (3.5) and rotates them to the tangent", () => {
    const white = segmentsWithColor(g, WHITE)
    const arrows = white.slice(2)
    // laneOffset(0, 3) = (1.5 - 0 - 0.5) * 3.5 = 3.5 (right of forward +Z).
    // The arrow is painted in the lane, turned to the tangent (here +Z), so
    // its 0.55u shape spans x = 3.5 ± 0.55 and z = 12 ± 0.385.
    const xs = arrows.slice(0, 4).flatMap((a) => [a.a[0]!, a.b[0]!])
    const zs = arrows.slice(0, 4).flatMap((a) => [a.a[2]!, a.b[2]!])
    expect(Math.min(...xs)).toBeCloseTo(3.5 - 0.55, 5)
    expect(Math.max(...xs)).toBeCloseTo(3.5 + 0.55, 5)
    expect(Math.min(...zs)).toBeCloseTo(12 - 0.385, 5)
    expect(Math.max(...zs)).toBeCloseTo(12 + 0.385, 5)
  })

  it('reverses the backward lanes by an extra PI', () => {
    const white = segmentsWithColor(g, WHITE)
    const arrows = white.slice(2)
    // 2 arrows per lane = 8 segments per lane, so lane 2 (the backward
    // one, sign -1) starts at segment 16: laneOffset(2, 3) = -3.5, and
    // the shape is turned the other way.
    const backward = arrows.slice(2 * 8, 2 * 8 + 4)
    const xs = backward.flatMap((a) => [a.a[0]!, a.b[0]!])
    expect(Math.min(...xs)).toBeCloseTo(-3.5 - 0.55, 5)
    expect(Math.max(...xs)).toBeCloseTo(-3.5 + 0.55, 5)
  })
})

describe('createRoadMarkings — 4-lane road', () => {
  it('skips the offset-0 divider (that is the centerline) and keeps 2 divider lines', () => {
    const g = createRoadMarkings([makeTestRoad('r-4', 'ew', 4)])
    const dividers = segmentsWithColor(g, DIVIDER)
    // offsets 7.0 and 3.5; the third candidate lands on 0 and is filtered out
    expect(dividers).toHaveLength(2 * 50)
    // r-ew runs along +X, so the dash advances along X while the
    // perpendicular offset (perp = (0, -1)) stays constant on Z.
    expect(dividers[0]!.a[2]).toBeCloseTo(-7.0, 5)
    expect(dividers[0]!.b[2]).toBeCloseTo(-7.0, 5)
    expect(dividers[0]!.a[0]).toBeCloseTo(-30, 5)
    expect(dividers[0]!.b[0]).toBeCloseTo(-29.4, 5) // DASH = 0.6u along the road
    // second divider batch starts at offset 3.5
    expect(dividers[50]!.a[2]).toBeCloseTo(-3.5, 5)
    // No dash is ever painted on the centerline.
    for (const d of dividers) expect(Math.abs(d.a[2]!)).toBeGreaterThan(1e-3)
  })
})

describe('createRoadMarkings — degenerate / short roads', () => {
  it('a zero-length road produces an empty group', () => {
    const g = createRoadMarkings([
      makePolylineRoad(
        'r-zero',
        [
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 0, z: 0 },
        ],
        2,
      ),
    ])
    expect(g.children).toHaveLength(0)
  })

  it('a 1-lane road produces an empty group (no centerline, no dividers)', () => {
    const g = createRoadMarkings([makeTestRoad('r-1', 'ns', 1)])
    expect(g.children).toHaveLength(0)
  })

  it('drops the stop lines when the junction box does not fit the road', () => {
    const g = createRoadMarkings(
      [
        makePolylineRoad(
          'r-short',
          [
            { x: 0, y: 0, z: 0 },
            { x: 0, y: 0, z: 2 },
          ],
          2,
        ),
      ],
      // The junction is at the middle of a 2 m road: both stop lines
      // (mid ± 8) fall outside the road, so neither is painted.
      { intersections: [junctionAt('r-short', 0, 1)] },
    )
    // centerline + 2 dashes survive; neither stop line fits the road.
    expect(segmentsWithColor(g, CENTERLINE)).toHaveLength(1)
    expect(segmentsWithColor(g, DIVIDER)).toHaveLength(2)
    expect(segmentsWithColor(g, WHITE)).toHaveLength(0)
  })
})
