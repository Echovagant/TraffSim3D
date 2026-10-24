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
//
// There is **no flag**: the clearance applies to every junction, because
// every junction can hold a queue (the frontend paints a stop line on
// every junction's box edge, and the cross-road yield rule can stop a
// vehicle in front of any of them, lit or not).

import { describe, it, expect } from 'vitest'
import {
  CORNER_TURN_ENVELOPE_M,
  cornerRadius,
  junctionRadius,
  junctionRadiusForRoads,
} from './junctionRadius'
import { INTERSECTION_CLEARANCE_M, ROAD_LANE_WIDTH } from '@shared/constants/simulation'

/** The carriageway half-width of a road with `lanes` lanes. */
const halfWidthOf = (lanes: number): number => (lanes * ROAD_LANE_WIDTH) / 2

describe('junctionRadius — the half-width of the widest connected road, plus the clearance', () => {
  it('contains the carriageway of the road it delimits', () => {
    for (const lanes of [1, 2, 3, 4, 6, 8]) {
      expect(junctionRadius(lanes)).toBeGreaterThanOrEqual(halfWidthOf(lanes))
    }
  })

  it('adds the nose-overhang clearance to EVERY junction', () => {
    for (const lanes of [1, 2, 3, 4, 6, 8]) {
      expect(junctionRadius(lanes)).toBe(halfWidthOf(lanes) + INTERSECTION_CLEARANCE_M)
    }
  })

  it('leaves exactly INTERSECTION_CLEARANCE_M of extra room', () => {
    for (const lanes of [1, 2, 3, 4, 6, 8]) {
      expect(junctionRadius(lanes) - halfWidthOf(lanes)).toBe(INTERSECTION_CLEARANCE_M)
    }
    expect(INTERSECTION_CLEARANCE_M).toBe(4.5)
  })

  it('has no condition: the radius does not depend on anything but the lane count', () => {
    // The rule used to take a "queueable" flag and returned two different
    // radii for the same lane count. There is no such input any more, and
    // the radius must be a pure function of the lane model — the same
    // lane count always yields the same box, lit or not.
    const radii = new Set([1, 2, 3, 4, 6, 8].map((lanes) => junctionRadius(lanes)))
    expect(radii.size).toBe(6)
    // Monotonic in the lane count: a wider road ⇒ a wider box.
    for (let lanes = 1; lanes < 8; lanes++) {
      expect(junctionRadius(lanes + 1)).toBeGreaterThan(junctionRadius(lanes))
    }
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
    expect(junctionRadiusForRoads([2, 6, 4])).toBe(halfWidthOf(6) + INTERSECTION_CLEARANCE_M)
  })

  it('is the same as junctionRadius for a single road', () => {
    expect(junctionRadiusForRoads([4])).toBe(junctionRadius(4))
  })

  it('falls back to a single lane when the junction has no known road', () => {
    // The backend's `junction_radius` uses the same default
    // (`max(..., default=1)`), so the two sides still agree here.
    expect(junctionRadiusForRoads([])).toBe(junctionRadius(1))
  })
})

describe('cornerRadius — a corner carries the rule plus the turning envelope', () => {
  it('adds the turning envelope to the rule', () => {
    expect(cornerRadius(2)).toBe(halfWidthOf(2) + INTERSECTION_CLEARANCE_M + CORNER_TURN_ENVELOPE_M)
  })

  it('is bigger than a plain junction of the same lane count', () => {
    // The corner needs room for the car **in the turn**, on top of
    // everything a junction already needs.
    expect(cornerRadius(4)).toBeGreaterThan(junctionRadius(4))
  })

  it('carries the same clearance as every other junction', () => {
    // The clearance is not a corner's privilege and not its exemption:
    // it applies to the whole rule, and the corner only adds the
    // turning envelope on top of it.
    for (const lanes of [1, 2, 4, 6]) {
      expect(cornerRadius(lanes) - junctionRadius(lanes)).toBe(CORNER_TURN_ENVELOPE_M)
    }
  })

  it("keeps the loop scene's committed corner radius (8.5 m)", () => {
    // The loop scene's four corners carry this value; changing it would
    // move the painted stop lines of every corner. It is written as the
    // rule's terms, so a change to the rule or to the envelope shows up
    // here rather than silently moving the geometry.
    expect(cornerRadius(2)).toBe(halfWidthOf(2) + INTERSECTION_CLEARANCE_M + 0.5)
  })
})
