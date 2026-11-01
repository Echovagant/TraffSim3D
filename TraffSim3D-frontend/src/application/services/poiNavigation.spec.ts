// src/application/services/poiNavigation.spec.ts
//
// Addressing a POI for the route planner.
//
// What is pinned here:
//   1. **The road** — the one whose line passes closest to the POI;
//   2. **The direction** — the one whose END is closer, because that
//      end is where the route finishes (the wrong end would leave the
//      car a whole block away);
//   3. **The arrival** — a distance, not a waypoint: the driver passes
//      the POI while driving the last road.

import { describe, it, expect } from 'vitest'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Vehicle } from '@domain/entities/Vehicle'
import {
  distanceToPoi,
  hasArrivedAtPoi,
  nearestRoadToPoi,
  POI_ARRIVAL_RADIUS_M,
} from './poiNavigation'

const road = (id: string, waypoints: { x: number; y: number; z: number }[]) =>
  ({
    id,
    waypoints,
    laneCount: 2,
    speedLimit: 16.67,
    level: 0,
  }) as unknown as RoadNetwork['roads'][string]

const network = (): RoadNetwork =>
  ({
    roads: {
      // Runs west→east along z = 0.
      r1: road('r1', [
        { x: -50, y: 0, z: 0 },
        { x: 50, y: 0, z: 0 },
      ]),
      // Runs north→south along x = 100.
      r2: road('r2', [
        { x: 100, y: 0, z: -50 },
        { x: 100, y: 0, z: 50 },
      ]),
    },
    intersections: {},
    vehicles: {},
    spawnPoints: {},
  }) as unknown as RoadNetwork

describe('nearestRoadToPoi', () => {
  it('picks the road whose line passes closest', () => {
    const end = nearestRoadToPoi(network(), { x: 10, z: 4 })
    expect(end?.roadId).toBe('r1')
  })

  it('picks the other road when the POI is nearer to it', () => {
    const end = nearestRoadToPoi(network(), { x: 96, z: 10 })
    expect(end?.roadId).toBe('r2')
  })

  it('ends the route at the end nearest the POI', () => {
    // Near r1's EAST end (x = 50) → 'forward' (the road's last
    // waypoint). Near its WEST end (x = −50) → 'backward'.
    expect(nearestRoadToPoi(network(), { x: 48, z: 2 })?.direction).toBe('forward')
    expect(nearestRoadToPoi(network(), { x: -48, z: 2 })?.direction).toBe('backward')
  })

  it('returns null when the scene has no roads', () => {
    const empty = { roads: {} } as unknown as RoadNetwork
    expect(nearestRoadToPoi(empty, { x: 0, z: 0 })).toBeNull()
  })
})

describe('the arrival at a POI', () => {
  const vehicle = (x: number, z: number): Vehicle =>
    ({
      id: 'v-1',
      roadId: 'r1',
      laneIndex: 0,
      heading: 0,
      speed: 5,
      position: { x, y: 0, z },
    }) as unknown as Vehicle

  it('measures the distance in the XZ plane', () => {
    expect(distanceToPoi(vehicle(0, 0), { x: 3, z: 4 })).toBeCloseTo(5)
  })

  it('counts as arrived within the radius', () => {
    expect(hasArrivedAtPoi(vehicle(0, 0), { x: POI_ARRIVAL_RADIUS_M - 1, z: 0 })).toBe(true)
    expect(hasArrivedAtPoi(vehicle(0, 0), { x: POI_ARRIVAL_RADIUS_M + 1, z: 0 })).toBe(false)
  })

  it('has a radius that covers the kerb gap', () => {
    // The POI stands at the kerb, ~5 m from the lane the car drives in.
    expect(POI_ARRIVAL_RADIUS_M).toBeGreaterThan(5)
  })
})
