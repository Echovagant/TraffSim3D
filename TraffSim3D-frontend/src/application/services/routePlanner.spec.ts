// The route planner's pure logic: turning a backend plan into the road
// list, the polyline and the progress a car follows.
//
// The backend owns the search (the directed graph over the network's
// waypoints); everything here is about making its answer drivable and
// drawable on this side.

import { describe, it, expect } from 'vitest'
import {
  nextRouteRoad,
  plannedRouteFrom,
  routeNetworkPayload,
  routeProgress,
  routeStartFor,
} from './routePlanner'
import type { RoutePlanResponse } from '@infrastructure/api/routeClient'
import { createRoadNetwork } from '@domain/entities/RoadNetwork'
import type { Road } from '@domain/entities/Road'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import { LaneId } from '@domain/value-objects/LaneId'
import type { Vehicle } from '@domain/entities/Vehicle'

const vehicle = (overrides: Partial<Vehicle> = {}): Vehicle => ({
  id: 'v-1',
  type: 'car',
  position: { x: 10, y: 0, z: 0 },
  heading: 0,
  speed: 8,
  targetSpeed: 16.67,
  roadId: 'r-a',
  laneIndex: 0,
  s: 10,
  lane: LaneId.make('r-a', 0),
  color: '#fff',
  status: 'driving',
  desiredStatus: 'driving',
  enteredIntersectionAt: null,
  desiredLaneIndex: null,
  laneChangeStartedAt: null,
  spawnedAt: 0,
  ...overrides,
})

const plan = (overrides: Partial<RoutePlanResponse> = {}): RoutePlanResponse => ({
  found: true,
  roads: ['r-b', 'r-c'],
  legs: [
    {
      road_id: 'r-b',
      from: { x: 100, y: 0, z: 0 },
      to: { x: 100, y: 0, z: 100 },
      cost_m: 100,
    },
    {
      road_id: 'r-c',
      from: { x: 100, y: 0, z: 100 },
      to: { x: 200, y: 0, z: 100 },
      cost_m: 100,
    },
  ],
  cost_m: 200,
  start_node: 'n-1',
  end_node: 'n-4',
  ...overrides,
})

describe('plannedRouteFrom', () => {
  /** A network with the three roads the plan traverses. */
  const network = (): RoadNetwork => {
    const net = createRoadNetwork()
    const road = (id: string, x: number, z: number): Road => ({
      id,
      startNode: { x, y: 0, z },
      endNode: { x: x + 100, y: 0, z },
      laneCount: 4,
      speedLimit: 16.67,
      level: 0,
    })
    net.roads['r-a'] = road('r-a', 0, 0)
    net.roads['r-b'] = road('r-b', 100, 0)
    net.roads['r-c'] = road('r-c', 200, 0)
    return net
  }

  it('starts the road list with the road the follower is on', () => {
    const route = plannedRouteFrom(network(), plan(), vehicle(), 'i-2')
    expect(route).not.toBeNull()
    // The backend's legs begin at the node the car reaches NEXT, so the
    // car's own road is the route's first entry.
    expect(route?.roads).toEqual(['r-a', 'r-b', 'r-c'])
  })

  it('draws the polyline on the lane the car drives, not on the centre line', () => {
    const route = plannedRouteFrom(network(), plan(), vehicle(), 'i-2')
    // The car is on lane 0 of a 4-lane road: 5.25 m to the right of the
    // road's forward direction. The polyline's nodes are on the same
    // side, so the ribbon sits under the car and not in the oncoming
    // lanes.
    const first = route!.points[1]!
    // The leg's from-node is (100, 0, 0); the road runs along +X, so
    // "right" is -Z.
    expect(first.z).toBeCloseTo(-5.25, 5)
    expect(first.x).toBeCloseTo(100, 5)
  })

  it('keeps the polyline on the car’s own lane at the start', () => {
    const route = plannedRouteFrom(network(), plan(), vehicle(), 'i-2')
    // The car is at (10, 0, 0) on lane 0 — but lane 0 is to the RIGHT of
    // the road's forward direction, so the car itself is at z = -5.25.
    const car = vehicle({ position: { x: 10, y: 0, z: -5.25 } })
    const withCar = plannedRouteFrom(network(), plan(), car, 'i-2')!
    expect(withCar.points[0]).toEqual({ x: 10, y: 0, z: -5.25 })
    expect(withCar.points[1]!.z).toBeCloseTo(-5.25, 5)
  })

  it('returns null when the backend found no path', () => {
    expect(
      plannedRouteFrom(network(), plan({ found: false, roads: [], legs: [] }), vehicle(), 'i'),
    ).toBeNull()
  })
})

describe('nextRouteRoad', () => {
  const route = plannedRouteFrom(
    (() => {
      const net = createRoadNetwork()
      const road = (id: string): Road => ({
        id,
        startNode: { x: 0, y: 0, z: 0 },
        endNode: { x: 100, y: 0, z: 0 },
        laneCount: 4,
        speedLimit: 16.67,
        level: 0,
      })
      net.roads['r-a'] = road('r-a')
      net.roads['r-b'] = road('r-b')
      net.roads['r-c'] = road('r-c')
      return net
    })(),
    plan(),
    vehicle(),
    'i-2',
  )!

  it('names the road after the one the vehicle is on', () => {
    expect(nextRouteRoad(route, 'r-a', 0).roadId).toBe('r-b')
    expect(nextRouteRoad(route, 'r-b', 1).roadId).toBe('r-c')
  })

  it('has no next road at the end of the route', () => {
    expect(nextRouteRoad(route, 'r-c', 2).roadId).toBeNull()
  })

  it('returns null when the vehicle is not on the route at all', () => {
    expect(nextRouteRoad(route, 'r-unknown', 0).roadId).toBeNull()
  })

  it('finds the road again when the hint went stale', () => {
    // The hint points past the vehicle's road; the search falls back to
    // scanning the whole list.
    expect(nextRouteRoad(route, 'r-a', 2).roadId).toBe('r-b')
  })
})

describe('routeProgress', () => {
  const route = plannedRouteFrom(
    (() => {
      const net = createRoadNetwork()
      const road = (id: string): Road => ({
        id,
        startNode: { x: 0, y: 0, z: 0 },
        endNode: { x: 100, y: 0, z: 0 },
        laneCount: 4,
        speedLimit: 16.67,
        level: 0,
      })
      net.roads['r-a'] = road('r-a')
      net.roads['r-b'] = road('r-b')
      net.roads['r-c'] = road('r-c')
      return net
    })(),
    plan(),
    vehicle(),
    'i-2',
  )!

  it('counts the roads already taken', () => {
    expect(routeProgress(route, 'r-a', 0)).toBe(0)
    expect(routeProgress(route, 'r-b', 0)).toBeCloseTo(0.5)
    expect(routeProgress(route, 'r-c', 0)).toBe(1)
  })
})

describe('routeStartFor', () => {
  const network = createRoadNetwork()
  network.roads['r-a'] = {
    id: 'r-a',
    startNode: { x: 0, y: 0, z: 0 },
    endNode: { x: 100, y: 0, z: 0 },
    laneCount: 4,
    speedLimit: 16.67,
    level: 0,
  }

  it('a car on a forward lane is heading for the road’s last waypoint', () => {
    expect(routeStartFor(network, vehicle({ laneIndex: 0 })).direction).toBe('forward')
  })

  it('a car on a backward lane is heading for the road’s first waypoint', () => {
    expect(routeStartFor(network, vehicle({ laneIndex: 3 })).direction).toBe('backward')
  })

  it('names the road the car is on', () => {
    expect(routeStartFor(network, vehicle()).roadId).toBe('r-a')
  })
})

describe('routeNetworkPayload', () => {
  it('sends the scene in the shape the backend reads', () => {
    const network = createRoadNetwork()
    const payload = routeNetworkPayload(network)
    expect(Array.isArray(payload.roads)).toBe(true)
    expect(Array.isArray(payload.intersections)).toBe(true)
    expect(Array.isArray(payload.vehicles)).toBe(true)
  })
})
