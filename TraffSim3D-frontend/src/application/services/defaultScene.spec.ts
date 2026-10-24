// defaultScene factory tests.
//
// Verifies the three demo scenes produce the expected topology:
//   - cross: 2 roads + 1 (4-way) intersection + 6 vehicles
//   - t:     3 roads + 1 (3-way) intersection + 4 vehicles
//   - loop:  4 roads + 4 corner intersections + 8 vehicles
//
// The junction-box radius is checked against **the one rule**
// (`@domain/services/junctionRadius`): the crossing carriageway plus the
// nose-overhang clearance — for every junction, lit or not. A corner
// adds the turning envelope on top of it.

import { describe, it, expect } from 'vitest'
import {
  buildCrossIntersectionNetwork,
  buildTJunctionNetwork,
  buildRectangularLoopNetwork,
  buildElevatedScene,
  buildCorridorScene,
  buildGridNetwork,
  gridJunctionId,
  GRID_SIZE,
} from './defaultScene'
import { CORNER_TURN_ENVELOPE_M } from '@domain/services/junctionRadius'
import { approachAxisGroups } from '@domain/services/approachAxis'
import { INTERSECTION_CLEARANCE_M, ROAD_LANE_WIDTH } from '@shared/constants/simulation'
import { LightPhase } from '@domain/value-objects/Phase'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Intersection } from '@domain/entities/Intersection'

describe('buildCrossIntersectionNetwork', () => {
  it('produces 2 roads, 1 (4-way) intersection, 6 vehicles', () => {
    const net = buildCrossIntersectionNetwork()
    expect(Object.keys(net.roads).length).toBe(2)
    expect(Object.keys(net.intersections).length).toBe(1)
    expect(Object.keys(net.vehicles).length).toBe(6)
    const inter = Object.values(net.intersections)[0]!
    expect(inter.connectedRoads.length).toBe(2)
    // 6 lanes x 3.5 m = 21 m wide -> half-width 10.5 m, plus the 4.5 m
    // clearance: 15 m. The box has to hold the crossing carriageway, and
    // its edge (the stop line) has to keep a queued vehicle's nose out of
    // it. See `INTERSECTION_CLEARANCE_M`.
    expect(inter.intersectionRadius).toBe(15)
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
    // 4 lanes x 3.5 m = 14 m wide -> half-width 7 m, plus the 4.5 m
    // clearance: 11.5 m.
    expect(inter.intersectionRadius).toBe(11.5)
  })
})

describe('buildRectangularLoopNetwork', () => {
  it('produces 4 roads, 4 corner intersections (2 lights each), 8 vehicles', () => {
    const net = buildRectangularLoopNetwork()
    expect(Object.keys(net.roads).length).toBe(4)
    expect(Object.keys(net.intersections).length).toBe(4)
    expect(Object.keys(net.vehicles).length).toBe(8)
    for (const inter of Object.values(net.intersections)) {
      // A corner is a crossing of an east–west and a north–south leg, so
      // it carries **one light per axis group**. The corners used to be
      // unlit, which left the circulating traffic with nothing to
      // arbitrate a conflict with the perpendicular leg.
      expect(inter.trafficLights.length).toBe(2)
      expect(inter.trafficLights.map((l) => l.axis).sort()).toEqual(['ew', 'ns'])
      expect(inter.connectedRoads.length).toBe(2)
      // 2 lanes x 3.5 m = 7 m wide -> half-width 3.5 m, plus the 4.5 m
      // clearance, plus the 0.5 m turning envelope: 8.5 m. The clearance
      // applies here too — an unlit corner can still hold a queue (the
      // front-end paints a stop line on every junction's box edge, and
      // the cross-road yield rule can stop a vehicle in front of any of
      // them).
      expect(inter.intersectionRadius).toBe(
        (2 * ROAD_LANE_WIDTH) / 2 + INTERSECTION_CLEARANCE_M + CORNER_TURN_ENVELOPE_M,
      )
    }
  })
})

// Elevated roads (Y-axis ramps + level tagging).
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

// Multi-intersection corridor.
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

// ---------------------------------------------------------------------------
// one light per axis group
// ---------------------------------------------------------------------------

describe('every built-in scene gives a junction one light per axis group', () => {
  it('the lights of a junction are exactly its axis groups', () => {
    for (const { name, build } of SCENES) {
      const net = build()
      for (const inter of Object.values(net.intersections)) {
        // The geometry decides the axis groups — the north and south arms
        // of a crossroads are one group, the east and west arms the other.
        const axes = approachAxisGroups(inter, net.roads)
        const lightAxes = inter.trafficLights.map((light) => light.axis).sort()
        expect(lightAxes, `${name}/${inter.id}`).toEqual([...axes].sort())
      }
    }
  })

  it('the two axis groups of a junction are driven in opposition', () => {
    // A junction with both axes carries one green and one red light: the
    // perpendicular approaches never show green at the same time.
    for (const { name, build } of SCENES) {
      const net = build()
      for (const inter of Object.values(net.intersections)) {
        if (inter.trafficLights.length < 2) continue
        const phases = inter.trafficLights.map((light) => light.phase).sort()
        expect(phases, `${name}/${inter.id}`).toEqual([LightPhase.Green, LightPhase.Red].sort())
      }
    }
  })
})

// ---------------------------------------------------------------------------
// the one rule
// ---------------------------------------------------------------------------

/** The box the rule gives a junction with `laneCount` lanes. */
const ruleRadius = (laneCount: number, corner = false): number =>
  (laneCount * ROAD_LANE_WIDTH) / 2 +
  INTERSECTION_CLEARANCE_M +
  (corner ? CORNER_TURN_ENVELOPE_M : 0)

/** The half-width of the widest road a junction connects. */
const widestHalfWidth = (net: RoadNetwork, inter: Intersection): number =>
  Math.max(
    ...inter.connectedRoads.map((id) => {
      const road = net.roads[id]
      if (!road) return 0
      return (road.laneCount * ROAD_LANE_WIDTH) / 2
    }),
  )

const SCENES: Array<{ name: string; build: () => RoadNetwork }> = [
  { name: 'cross', build: buildCrossIntersectionNetwork },
  { name: 't', build: buildTJunctionNetwork },
  { name: 'loop', build: buildRectangularLoopNetwork },
  { name: 'elevated', build: buildElevatedScene },
  { name: 'corridor', build: buildCorridorScene },
  { name: 'grid', build: buildGridNetwork },
]

describe('every built-in scene follows the one junction-box rule', () => {
  it('every junction box holds the crossing carriageway PLUS the clearance', () => {
    for (const { name, build } of SCENES) {
      const net = build()
      for (const inter of Object.values(net.intersections)) {
        const half = widestHalfWidth(net, inter)
        expect(
          inter.intersectionRadius,
          `${name}/${inter.id}: the box must hold the carriageway (${half} m) plus the clearance`,
        ).toBeGreaterThanOrEqual(half + INTERSECTION_CLEARANCE_M)
      }
    }
  })

  it('no junction box is the bare half-width any more', () => {
    // The regression this file exists for: a junction that only carries
    // the carriageway's half-width has no room for a queued vehicle's
    // nose, so the crossing traffic drives into it.
    for (const { name, build } of SCENES) {
      const net = build()
      for (const inter of Object.values(net.intersections)) {
        expect(inter.intersectionRadius, `${name}/${inter.id}`).not.toBe(
          widestHalfWidth(net, inter),
        )
      }
    }
  })

  it("each scene's junction radii are exactly the rule's numbers", () => {
    // Written as the rule's terms, not as bare literals, so a change to
    // the rule shows up here — and so the table cannot drift away from
    // the geometry it describes.
    const expected: Record<string, Record<string, number>> = {
      cross: { 'i-center': ruleRadius(6) },
      t: { 'i-t': ruleRadius(4) },
      loop: {
        'i-corner-0': ruleRadius(2, true),
        'i-corner-1': ruleRadius(2, true),
        'i-corner-2': ruleRadius(2, true),
        'i-corner-3': ruleRadius(2, true),
      },
      elevated: { 'i-low': ruleRadius(4), 'i-high-start': ruleRadius(4) },
      corridor: { 'i-north': ruleRadius(4), 'i-south': ruleRadius(4) },
      // The grid's 25 junctions are all 4-lane crossroads (the corner
      // ones have two arms, not three, but the box is still sized by the
      // carriageway they share).
      grid: Object.fromEntries(
        Array.from({ length: GRID_SIZE }, (_, i) =>
          Array.from({ length: GRID_SIZE }, (_, j) => [gridJunctionId(i, j), ruleRadius(4)]),
        ).flat(),
      ),
    }
    for (const { name, build } of SCENES) {
      const net = build()
      const want = expected[name]!
      expect(Object.keys(net.intersections).sort()).toEqual(Object.keys(want).sort())
      for (const [id, radius] of Object.entries(want)) {
        expect(net.intersections[id]!.intersectionRadius, `${name}/${id}`).toBe(radius)
      }
    }
  })
})
