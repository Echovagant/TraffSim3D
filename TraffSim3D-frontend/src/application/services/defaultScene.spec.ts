// Plan 035: defaultScene factory tests.
//
// Verifies the three demo scenes produce the expected topology:
//   - cross: 2 roads + 1 (4-way) intersection + 6 vehicles
//   - t:     3 roads + 1 (3-way) intersection + 4 vehicles
//   - loop:  4 roads + 4 corner intersections + 8 vehicles

import { describe, it, expect } from 'vitest'
import {
  buildCrossIntersectionNetwork,
  buildTJunctionNetwork,
  buildRectangularLoopNetwork,
  buildElevatedScene,
  buildCorridorScene,
} from './defaultScene'

describe('buildCrossIntersectionNetwork', () => {
  it('produces 2 roads, 1 (4-way) intersection, 6 vehicles', () => {
    const net = buildCrossIntersectionNetwork()
    expect(Object.keys(net.roads).length).toBe(2)
    expect(Object.keys(net.intersections).length).toBe(1)
    expect(Object.keys(net.vehicles).length).toBe(6)
    const inter = Object.values(net.intersections)[0]!
    expect(inter.connectedRoads.length).toBe(2)
    expect(inter.intersectionRadius).toBe(8)
  })
})

describe('buildTJunctionNetwork', () => {
  it('produces 3 roads, 1 (3-way) intersection, 4 vehicles', () => {
    const net = buildTJunctionNetwork()
    expect(Object.keys(net.roads).length).toBe(3)
    expect(Object.keys(net.intersections).length).toBe(1)
    expect(Object.keys(net.vehicles).length).toBe(4)
    const inter = Object.values(net.intersections)[0]!
    expect(inter.connectedRoads.length).toBe(3)
    expect(inter.intersectionRadius).toBe(6)
  })
})

describe('buildRectangularLoopNetwork', () => {
  it('produces 4 roads, 4 corner intersections (no lights), 8 vehicles', () => {
    const net = buildRectangularLoopNetwork()
    expect(Object.keys(net.roads).length).toBe(4)
    expect(Object.keys(net.intersections).length).toBe(4)
    expect(Object.keys(net.vehicles).length).toBe(8)
    for (const inter of Object.values(net.intersections)) {
      expect(inter.trafficLights.length).toBe(0)
      expect(inter.connectedRoads.length).toBe(2)
      expect(inter.intersectionRadius).toBe(4)
    }
  })
})

// Plan 039: elevated roads (Y-axis ramps + level tagging).
describe('buildElevatedScene', () => {
  it('produces 4 roads, 2 intersections (1 signal + 1 ramp-end), 4 vehicles', () => {
    const net = buildElevatedScene()
    expect(Object.keys(net.roads).length).toBe(4)
    expect(Object.keys(net.intersections).length).toBe(2)
    expect(Object.keys(net.vehicles).length).toBe(4)
  })

  it('ramp road has level=1 and waypoints Y climbing 0 -> 4', () => {
    const net = buildElevatedScene()
    const ramp = net.roads['r-ramp']!
    expect(ramp.level).toBe(1)
    expect(ramp.waypoints).toBeDefined()
    expect(ramp.waypoints!.length).toBeGreaterThanOrEqual(3)
    const yFirst = ramp.waypoints![0]!.y
    const yLast = ramp.waypoints![ramp.waypoints!.length - 1]!.y
    expect(yFirst).toBeCloseTo(0, 6)
    expect(yLast).toBeCloseTo(4, 6)
    // Monotonically increasing Y
    let prevY = -Infinity
    for (const wp of ramp.waypoints!) {
      expect(wp.y).toBeGreaterThanOrEqual(prevY)
      prevY = wp.y
    }
  })

  it('r-ew-high is level=1 (elevated straight), r-ns and r-ew-low are level=0', () => {
    const net = buildElevatedScene()
    expect(net.roads['r-ew-high']!.level).toBe(1)
    expect(net.roads['r-ns']!.level).toBe(0)
    expect(net.roads['r-ew-low']!.level).toBe(0)
  })
})

// Plan 040: multi-intersection corridor.
describe('buildCorridorScene', () => {
  it('produces 3 roads, 2 intersections, 6 vehicles', () => {
    const net = buildCorridorScene()
    expect(Object.keys(net.roads).length).toBe(3)
    expect(Object.keys(net.intersections).length).toBe(2)
    expect(Object.keys(net.vehicles).length).toBe(6)
  })

  it('NS corridor road connects to both intersections (line graph)', () => {
    const net = buildCorridorScene()
    const iNorth = net.intersections['i-north']!
    const iSouth = net.intersections['i-south']!
    expect(iNorth.connectedRoads).toContain('r-ns-corridor')
    expect(iSouth.connectedRoads).toContain('r-ns-corridor')
  })

  it('each intersection has 2 traffic lights (NS + EW axes)', () => {
    const net = buildCorridorScene()
    for (const inter of Object.values(net.intersections)) {
      expect(inter.trafficLights.length).toBe(2)
    }
  })
})
