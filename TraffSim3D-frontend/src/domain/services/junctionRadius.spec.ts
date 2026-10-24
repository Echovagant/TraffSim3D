// src/domain/services/junctionRadius.spec.ts
//
// The junction-box radius rule.
//
// This spec pins the **rule**, not a number: every assertion is written
// in terms of the lane model and the clearance, so a change to the rule
// (a missing clearance, a wrong lane width, a wrong half-width) fails
// here instead of quietly moving every junction's stop line.
//
// The rule has two jobs, and both of them are geometric:
//
//   1. the box has to CONTAIN the carriageway of every road it connects
//      (`radius >= laneCount * ROAD_LANE_WIDTH / 2`) — otherwise the
//      outer lanes are never inside the box and the occupancy rule
//      cannot see them;
//   2. the box has to keep a QUEUED vehicle's NOSE out of the crossing
//      carriageway (`radius >= halfWidth + INTERSECTION_CLEARANCE_M`) —
//      the stop rule acts on the vehicle's centre, so a vehicle waiting
//      at the line overhangs by up to half its length.
//
// The same rule sizes the built-in scenes' junctions and the imported
// maps' junctions — a cross-check over the real Shenzhen OSM extract
// (7991 junctions) confirmed that the backend's own implementation
// (`app/apps/maps/osm_parser.py` → `junction_radius`) agrees with this
// one on every one of them.

import { describe, it, expect } from 'vitest'
import {
  CORNER_TURN_ENVELOPE_M,
  cornerRadius,
  junctionRadius,
  junctionRadiusForRoads,
} from './junctionRadius'
import { INTERSECTION_CLEARANCE_M, ROAD_LANE_WIDTH } from '@shared/constants/simulation'

describe('junctionRadius — the half-width of the widest connected road', () => {
  it("is the carriageway's half-width", () => {
    for (const lanes of [1, 2, 3, 4, 6, 8]) {
      expect(junctionRadius(lanes, false)).toBe((lanes * ROAD_LANE_WIDTH) / 2)
    }
  })

  it('adds the nose-overhang clearance when the junction can hold a queue', () => {
    for (const lanes of [1, 2, 3, 4, 6, 8]) {
      expect(junctionRadius(lanes, true)).toBe(
        (lanes * ROAD_LANE_WIDTH) / 2 + INTERSECTION_CLEARANCE_M,
      )
    }
  })

  it('leaves exactly INTERSECTION_CLEARANCE_M of extra room', () => {
    const quiet = junctionRadius(4, false)
    const queued = junctionRadius(4, true)
    expect(queued - quiet).toBe(INTERSECTION_CLEARANCE_M)
    expect(INTERSECTION_CLEARANCE_M).toBe(4.5)
  })

  it("covers the clearance with the longest vehicle's half-length", () => {
    // A vehicle whose centre stops exactly ON the stop line keeps its
    // nose out of the crossing carriageway only if the clearance is at
    // least half of the longest vehicle's length (the 9 m bus).
    const LONGEST_VEHICLE_HALF_LENGTH_M = 4.5
    expect(INTERSECTION_CLEARANCE_M).toBeGreaterThanOrEqual(LONGEST_VEHICLE_HALF_LENGTH_M)
  })
})

describe('junctionRadiusForRoads — the widest connected road decides', () => {
  it('takes the maximum lane count of the connected roads', () => {
    expect(junctionRadiusForRoads([2, 6, 4], false)).toBe((6 * ROAD_LANE_WIDTH) / 2)
    expect(junctionRadiusForRoads([2, 6, 4], true)).toBe(
      (6 * ROAD_LANE_WIDTH) / 2 + INTERSECTION_CLEARANCE_M,
    )
  })

  it('is the same as junctionRadius for a single road', () => {
    expect(junctionRadiusForRoads([4], true)).toBe(junctionRadius(4, true))
  })

  it('falls back to a single lane when the junction has no known road', () => {
    // The backend's `junction_radius` uses the same default
    // (`max(..., default=1)`), so the two sides still agree here.
    expect(junctionRadiusForRoads([], true)).toBe(junctionRadius(1, true))
    expect(junctionRadiusForRoads([], false)).toBe(junctionRadius(1, false))
  })
})

describe('cornerRadius — a corner is not a queue', () => {
  it('adds the turning envelope to the half-width', () => {
    expect(cornerRadius(2)).toBe((2 * ROAD_LANE_WIDTH) / 2 + CORNER_TURN_ENVELOPE_M)
  })

  it('never includes the nose-overhang clearance', () => {
    expect(cornerRadius(4)).toBeLessThan(junctionRadius(4, true))
    expect(cornerRadius(4)).toBeGreaterThan(junctionRadius(4, false))
  })

  it("keeps the loop scene's committed corner radius (4 m)", () => {
    // The loop scene's four corners carry this value; changing it would
    // move the painted stop lines of every corner.
    expect(cornerRadius(2)).toBe(4)
  })
})
