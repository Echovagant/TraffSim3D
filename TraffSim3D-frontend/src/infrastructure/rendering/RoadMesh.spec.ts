// src/infrastructure/rendering/RoadMesh.spec.ts
//
// createRoadMesh extrudes a triangle strip along the road polyline. The
// vertex buffer IS the contract, so assert exact coordinates — the
// perpendicular is (uz, -ux) and halfWidth = laneCount * 3.5 / 2.

import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createRoadMesh } from './RoadMesh'
import { makeTestRoad, makePolylineRoad } from '@__fixtures__/testNetwork'
import { ROAD_LANE_WIDTH } from '@shared/constants/simulation'

const positionsOf = (road: Parameters<typeof createRoadMesh>[0]): Float32Array =>
  createRoadMesh(road).geometry.attributes.position!.array as Float32Array

describe('createRoadMesh — 2-point road', () => {
  // r-ns runs (0,0,-30) -> (0,0,30), laneCount 2 => halfWidth 3.5.
  const road = makeTestRoad('r-ns', 'ns', 2)

  it('collapses to 4 vertices / 6 indices (a single quad) for a 2-point road', () => {
    const geom = createRoadMesh(road).geometry
    expect(geom.attributes.position!.count).toBe(4)
    expect(geom.index!.count).toBe(6)
    expect(geom.attributes.position!.itemSize).toBe(3)
  })

  it('widens the strip to laneCount * ROAD_LANE_WIDTH / 2 on each side', () => {
    const p = positionsOf(road)
    const halfWidth = (ROAD_LANE_WIDTH * road.laneCount) / 2
    expect(halfWidth).toBe(3.5)
    // vertex 0 = right edge (+perp), vertex 1 = left edge (-perp)
    expect(p[0]).toBeCloseTo(halfWidth, 6) //  x = +3.5
    expect(p[2]).toBeCloseTo(-30, 6) //        z = start
    expect(p[3]).toBeCloseTo(-halfWidth, 6) // x = -3.5
    expect(p[5]).toBeCloseTo(-30, 6)
    // vertex 2 = right edge at the far end
    expect(p[6]).toBeCloseTo(halfWidth, 6)
    expect(p[8]).toBeCloseTo(30, 6)
    expect(p[9]).toBeCloseTo(-halfWidth, 6)
    expect(p[11]).toBeCloseTo(30, 6)
  })

  it('lifts the strip 0.01u off y = 0 so it does not z-fight the ground', () => {
    const p = positionsOf(road)
    for (let i = 1; i < p.length; i += 3) expect(p[i]).toBeCloseTo(0.01, 6)
  })

  it('emits CCW winding for each segment: (a, b, c)(b, d, c)', () => {
    const idx = createRoadMesh(road).geometry.index!.array as ArrayLike<number>
    expect(Array.from(idx)).toEqual([0, 1, 2, 1, 3, 2])
  })

  it('computes vertex normals (needed for the lit road material)', () => {
    const geom = createRoadMesh(road).geometry
    expect(geom.attributes.normal).toBeDefined()
    expect(geom.attributes.normal!.count).toBe(4)
    // Flat strip -> every normal points straight up (+Y).
    for (let i = 1; i < 4; i++) expect(geom.attributes.normal!.getY(i)).toBeCloseTo(1, 5)
  })

  it('uses the asphalt material (0x374151, roughness 0.95)', () => {
    const mat = createRoadMesh(road).material as THREE.MeshStandardMaterial
    expect(mat.color.getHex()).toBe(0x374151)
    expect(mat.roughness).toBe(0.95)
  })

  it('scales with laneCount: a 4-lane road is twice as wide', () => {
    const wide = positionsOf(makeTestRoad('r-ew', 'ew', 4))
    const narrow = positionsOf(makeTestRoad('r-ew', 'ew', 2))
    // r-ew runs along +X, so the perpendicular offsets land on Z.
    expect(Math.abs(wide[2] - narrow[2])).toBeCloseTo(3.5, 6)
    expect(Math.abs(wide[2])).toBeCloseTo((ROAD_LANE_WIDTH * 4) / 2, 6)
  })
})

describe('createRoadMesh — polyline road', () => {
  // Right-angle L: (0,0,0) -> (10,0,0) -> (10,0,10), laneCount 2.
  const road = makePolylineRoad(
    'r-l',
    [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 0, z: 10 },
    ],
    2,
  )

  it('emits 2 vertices per waypoint and 2 triangles per segment', () => {
    const geom = createRoadMesh(road).geometry
    expect(geom.attributes.position!.count).toBe(6)
    expect(geom.index!.count).toBe(12)
    expect(Array.from(geom.index!.array as ArrayLike<number>)).toEqual([
      0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4,
    ])
  })

  it('averages the incoming and outgoing tangents at the interior corner', () => {
    const p = positionsOf(road)
    const halfWidth = 3.5
    const k = Math.SQRT1_2 // corner tangent is (1,1)/sqrt(2)
    // vertex 2 = right edge of the corner waypoint (10,0,0)
    // perp = (uz, -ux) = (k, -k)
    expect(p[6]).toBeCloseTo(10 + k * halfWidth, 5)
    expect(p[8]).toBeCloseTo(0 - k * halfWidth, 5)
    // vertex 3 = left edge of the same waypoint
    expect(p[9]).toBeCloseTo(10 - k * halfWidth, 5)
    expect(p[11]).toBeCloseTo(0 + k * halfWidth, 5)
  })

  it('uses the single available tangent at each boundary vertex', () => {
    const p = positionsOf(road)
    // First waypoint tangent is (+1, 0) -> perp (0, -1) -> offsets land on Z.
    expect(p[0]).toBeCloseTo(0, 6)
    expect(p[2]).toBeCloseTo(-3.5, 6)
    expect(p[3]).toBeCloseTo(0, 6)
    expect(p[5]).toBeCloseTo(3.5, 6)
    // Last waypoint tangent is (+0, +1) -> perp (+1, 0) -> offsets land on X.
    expect(p[12]).toBeCloseTo(13.5, 6)
    expect(p[14]).toBeCloseTo(10, 6)
    expect(p[15]).toBeCloseTo(6.5, 6)
    expect(p[17]).toBeCloseTo(10, 6)
  })

  it('honours waypoint Y so ramps (Plan 036) tilt without extra code', () => {
    const ramp = makePolylineRoad(
      'r-ramp',
      [
        { x: 0, y: 0, z: 0 },
        { x: 20, y: 4, z: 0 },
      ],
      2,
    )
    const p = positionsOf(ramp)
    // first pair at y = 0 + 0.01
    expect(p[1]).toBeCloseTo(0.01, 6)
    // second pair at y = 4 + 0.01
    expect(p[7]).toBeCloseTo(4.01, 6)
  })
})

describe('createRoadMesh — degenerate road', () => {
  it('falls back to a +X tangent when both waypoints coincide (no NaN in the buffer)', () => {
    const road = makePolylineRoad(
      'r-degenerate',
      [
        { x: 5, y: 0, z: -2 },
        { x: 5, y: 0, z: -2 },
      ],
      2,
    )
    const p = positionsOf(road)
    expect(Array.from(p).every((n) => Number.isFinite(n))).toBe(true)
    // fallback tangent (1,0) -> perp (0,-1) -> the strip spans Z around (5,-2)
    expect(p[0]).toBeCloseTo(5, 6)
    expect(p[2]).toBeCloseTo(-5.5, 6)
    expect(p[3]).toBeCloseTo(5, 6)
    expect(p[5]).toBeCloseTo(1.5, 6)
  })
})
