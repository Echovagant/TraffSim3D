// findNearestLane on curved polylines.
//
// The heading precheck used to test the vehicle's heading against the
// tangent at the road's MIDPOINT (len/2). A curved OSM way bends more
// than 90° between its middle and its far leg, so a car driving
// perfectly on the far leg had EVERY lane skipped — the fallback froze
// `v.s` at its last value, the lane point stopped moving while the
// body kept driving, and the 5 m lane guard fired ~0.4 s later
// (measured on the Futian network: ~10 guards / 20 s / 90 cars, all at
// 5.0–5.1 m just past the threshold and full speed).
//
// The fix projects FIRST and checks the heading against the tangent AT
// the projection — the same "reject driving against the lane" rule,
// evaluated where the car actually is.

import { describe, it, expect } from 'vitest'
import { findNearestLane } from './laneFrameSync'
import type { Road } from '@domain/entities/Road'
import type { Vehicle } from '@domain/entities/Vehicle'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'

// Three legs: east (100 m) → north (60 m) → west-northwest (~42 m).
// The midpoint (s ≈ 101) sits mid-leg-2 heading north; the car sits on
// leg 3 heading ~west-southwest — a 107° turn between the legs, so the
// midpoint tangent and the car's heading differ by more than 90°.
const makeBentRoad = (): Road => ({
  id: 'r-bent',
  startNode: { x: 0, y: 0, z: 0 },
  endNode: { x: 42, y: 0, z: 42 },
  waypoints: [
    { x: 0, y: 0, z: 0 },
    { x: 100, y: 0, z: 0 },
    { x: 100, y: 0, z: 60 },
    { x: 42, y: 0, z: 42 },
  ],
  laneCount: 1,
  speedLimit: 20,
  level: 0,
})

const makeNetwork = (road: Road): RoadNetwork =>
  ({
    roads: { [road.id]: road },
    intersections: {},
    vehicles: {},
    spawnPoints: {},
    road: (id: string) => (id === road.id ? road : undefined),
    intersection: () => undefined,
    vehicle: () => undefined,
    spawnPoint: () => undefined,
  }) as unknown as RoadNetwork

const makeVehicle = (road: Road, over: Partial<Vehicle>): Vehicle =>
  ({
    id: 'v-1',
    type: 'car',
    roadId: road.id,
    laneIndex: 0,
    s: 30,
    position: { x: 0, y: 0, z: 0 },
    heading: 0,
    speed: 0,
    targetSpeed: 0,
    status: 'driving',
    desiredStatus: 'driving',
    ...over,
  }) as unknown as Vehicle

describe('findNearestLane on a sharply bent polyline', () => {
  it('re-projects a car driving on the far leg even when the midpoint tangent disagrees', () => {
    const road = makeBentRoad()
    const net = makeNetwork(road)
    // The car is on leg 3, ~40 m along it, heading along the leg —
    // but `s` is stale on leg 1 (30). The projection must win: s lands
    // on leg 3 (~142), not the stale 30.
    const v = makeVehicle(road, {
      position: { x: 61.8, y: 0, z: 48.2 },
      heading: Math.PI + 0.3,
      s: 30,
    })
    const nearest = findNearestLane(v, net)
    expect(nearest.laneIndex).toBe(0)
    // leg1 100 + leg2 60 + ~40 along leg 3.
    expect(nearest.s).toBeGreaterThan(140)
  })

  it('still rejects a car driving against the lane direction', () => {
    const road = makeBentRoad()
    const net = makeNetwork(road)
    // Same spot, but heading east-ish — against leg 3's travel
    // direction. The fallback (keep laneIndex/s) is the contract.
    const v = makeVehicle(road, {
      position: { x: 61.8, y: 0, z: 48.2 },
      heading: 0.3,
      s: 30,
    })
    const nearest = findNearestLane(v, net)
    expect(nearest.laneIndex).toBe(0)
    expect(nearest.s).toBe(30)
  })
})
