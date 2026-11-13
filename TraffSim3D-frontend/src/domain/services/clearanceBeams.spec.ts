// src/domain/services/clearanceBeams.spec.ts
//
// The physical twin of the height rule.
//
// The rule (`roadAccess.ts`) says a 3.5 m tunnel does not take a bus.
// These beams are what makes that true in the physics world, so the
// numbers here matter to the millimetre: the beam's underside is the
// limit MINUS the roof-equipment clearance, because the rule compares
// `height + clearance` against the limit.

import { describe, it, expect } from 'vitest'
import { clearanceBeamsFor, vehicleClearsBeam, CLEARANCE_BEAM_THICKNESS_M } from './clearanceBeams'
import { ROAD_MIN_HEIGHT_CLEARANCE_M } from './roadAccess'
import type { Road } from '@domain/entities/Road'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'

const road = (over: Partial<Road> = {}): Road => ({
  id: 'r-1',
  startNode: { x: 0, y: 0, z: 0 },
  endNode: { x: 100, y: 0, z: 0 },
  laneCount: 2,
  speedLimit: 14,
  level: 0,
  highway: 'residential',
  ...over,
})

const networkOf = (roads: Road[]): RoadNetwork =>
  ({
    roads: Object.fromEntries(roads.map((r) => [r.id, r])),
    intersections: {},
    vehicles: {},
    spawnPoints: {},
  }) as unknown as RoadNetwork

describe('clearanceBeamsFor — the portals over height-limited roads', () => {
  it('gives a limited road a portal at each end', () => {
    const beams = clearanceBeamsFor(networkOf([road({ maxHeightM: 3.5 })]))
    expect(beams).toHaveLength(2)
    expect(beams.map((b) => b.id)).toEqual(['r-1#start', 'r-1#end'])
    // The start portal stands at the road's start, the end portal at
    // its end.
    expect(beams[0]!.x).toBeCloseTo(0, 6)
    expect(beams[0]!.z).toBeCloseTo(0, 6)
    expect(beams[1]!.x).toBeCloseTo(100, 6)
    expect(beams[1]!.z).toBeCloseTo(0, 6)
  })

  it('puts the underside at the limit MINUS the roof clearance', () => {
    const beams = clearanceBeamsFor(networkOf([road({ maxHeightM: 3.5 })]))
    for (const beam of beams) {
      expect(beam.clearanceM).toBeCloseTo(3.5 - ROAD_MIN_HEIGHT_CLEARANCE_M, 9)
    }
  })

  it('gives no portal to a road without a limit', () => {
    expect(clearanceBeamsFor(networkOf([road()]))).toHaveLength(0)
    // `maxheight=no` and `maxheight=default` are dropped by the
    // parser, but a network built by hand may carry them.
    expect(clearanceBeamsFor(networkOf([road({ maxHeightM: 0 })]))).toHaveLength(0)
  })

  it('spans the carriageway and adds a margin on each side', () => {
    const beams = clearanceBeamsFor(networkOf([road({ maxHeightM: 3.5 })]))
    // A residential road: one lane of 3.0 m per the class table (the
    // lane count is 2, but the class makes it one lane) — the beam
    // must be wider than that, plus the margin.
    expect(beams[0]!.halfWidth).toBeGreaterThan(1.5)
    expect(beams[0]!.halfDepth).toBeCloseTo(CLEARANCE_BEAM_THICKNESS_M / 2, 9)
  })

  it('points the portal along the road it belongs to', () => {
    // An east-west road: the portal's yaw is 0 (its local X runs
    // along the road).
    const beams = clearanceBeamsFor(networkOf([road({ maxHeightM: 3.5 })]))
    expect(beams[0]!.heading).toBeCloseTo(0, 6)
    // A north-south road: yaw = π/2.
    const ns = clearanceBeamsFor(
      networkOf([
        road({ maxHeightM: 3.5, startNode: { x: 0, y: 0, z: 0 }, endNode: { x: 0, y: 0, z: 100 } }),
      ]),
    )
    expect(Math.abs(ns[0]!.heading)).toBeCloseTo(Math.PI / 2, 6)
  })

  it('rides the road surface: the portal sits on the road, not on y = 0', () => {
    const raised = road({
      maxHeightM: 3.5,
      startNode: { x: 0, y: 4, z: 0 },
      endNode: { x: 100, y: 4, z: 0 },
    })
    const beams = clearanceBeamsFor(networkOf([raised]))
    expect(beams[0]!.y).toBeCloseTo(4, 9)
    expect(beams[1]!.y).toBeCloseTo(4, 9)
  })

  it('handles a polyline road: the portals stand on its two ends', () => {
    const poly = road({
      maxHeightM: 3.5,
      endNode: { x: 100, y: 0, z: 60 },
      waypoints: [
        { x: 0, y: 0, z: 0 },
        { x: 40, y: 0, z: 20 },
        { x: 100, y: 0, z: 60 },
      ],
    })
    const beams = clearanceBeamsFor(networkOf([poly]))
    expect(beams).toHaveLength(2)
    expect(beams[0]!.x).toBeCloseTo(0, 6)
    expect(beams[1]!.x).toBeCloseTo(100, 6)
    expect(beams[1]!.z).toBeCloseTo(60, 6)
  })
})

describe('vehicleClearsBeam — the beam agrees with the rule', () => {
  const beam = clearanceBeamsFor(networkOf([road({ maxHeightM: 3.5 })]))[0]!

  it('lets a car (1.6 m) through', () => {
    expect(vehicleClearsBeam(beam, 1.6)).toBe(true)
  })

  it('stops a bus (3.4 m) — 0.1 m too tall for a 3.5 m portal', () => {
    expect(vehicleClearsBeam(beam, 3.4)).toBe(false)
  })

  it('stops a truck (3.6 m)', () => {
    expect(vehicleClearsBeam(beam, 3.6)).toBe(false)
  })

  it('agrees with the domain rule for every vehicle type', () => {
    // The rule compares `height + clearance` against the limit; the
    // beam compares `height` against `limit - clearance`. Same
    // verdict, every time.
    const limit = 3.5
    for (const height of [1.6, 3.3, 3.4, 3.6, 4.0]) {
      const byRule = height + ROAD_MIN_HEIGHT_CLEARANCE_M <= limit + 1e-9
      expect(vehicleClearsBeam(beam, height)).toBe(byRule)
    }
  })
})
