// src/domain/services/junctionRadius.ts
//
// The junction-box radius rule — the ONE place that decides how big a
// junction's box is.
//
// ## Why the box has a size at all
//
// The box is not a decoration. Two rules work on the same interval
// (`laneGeometry.ts` → `intersectionSRange`):
//
//   - the **stop line** sits on the box's edge (`stopLineSOnRoad` =
//     `centreS ± intersectionRadius`), so the edge is where traffic is
//     held;
//   - the **occupancy rule** ("is this vehicle in the intersection?")
//     tests the same interval, so the box decides what the junction
//     *sees*.
//
// A box narrower than the road it delimits leaves the outer lanes
// outside it — the occupancy rule then never sees them, and a queued
// vehicle's nose hangs into the crossing carriageway. That is why the
// radius cannot be a fixed number: it is a property of the **lane
// model**.
//
// ## The rule
//
//     radius = half-width of the widest connected road
//              + the nose-overhang clearance
//
// The half-width is `laneCount * ROAD_LANE_WIDTH / 2`. The widest
// connected road decides, because the box is shared by every approach.
//
// The clearance (`INTERSECTION_CLEARANCE_M` = 4.5 m = the longest
// vehicle's half-length) covers the second job: the stop rule acts on
// the vehicle's **CENTRE** (`tick.ts` → `distToStopLine`), so a vehicle
// waiting at the line may legitimately overhang by up to half its
// length. Without the clearance, the overhang reaches into the
// crossing carriageway and the crossing traffic drives into it.
//
// ## Why there is no "queueable" flag
//
// The clearance used to be conditional — it was applied only to a
// junction that could hold a queue, i.e. one with a traffic light.
// That condition was wrong, and it was wrong in the same way twice:
//
//   - the front-end paints a stop line on **every** junction's box edge
//     (`roadStopLines` does not look at the traffic lights), and the
//     cross-road yield rule (`tick.ts` → `applyCrossRoadYield`) can stop
//     a vehicle in front of **any** junction, lit or not. Every junction
//     can therefore hold a queue ⇒ the clearance always applies;
//   - a traffic light is not a proxy for "can a queue form here"
//     anyway: the parser only attaches one to the OSM nodes tagged
//     `highway=traffic_signals` (51 of the 7991 junctions in the
//     Shenzhen extract), and the imported maps already applied the
//     clearance to **all** of them.
//
// So the flag was a second rule that could drift away from the first —
// and it did: the built-in scenes' unlit junctions were sized by the
// half-width alone while every imported junction was sized by the
// half-width **plus** the clearance. One rule, no flag.
//
// ## Who owns the number
//
// The frontend owns it — for **every** map, built-in or imported. The
// imported maps used to trust the backend's payload instead, which
// meant two independent answers to the same question; the backend
// derives the same number from the same lane model
// (`app/apps/maps/osm_parser.py` → `junction_radius`), and a
// cross-check over the real Shenzhen OSM extract (7991 junctions)
// proved the two agree on every one of them.

import { INTERSECTION_CLEARANCE_M, ROAD_LANE_WIDTH } from '@shared/constants/simulation'

/**
 * The radius of a junction box: the carriageway of a road with
 * `laneCount` lanes, **plus** the clearance that keeps a queued
 * vehicle's nose out of it (see `INTERSECTION_CLEARANCE_M`).
 *
 * There is no condition on this: every junction box gets the clearance,
 * because every junction can hold a queue (see the module header).
 *
 * @param laneCount  the lane count of the widest road the junction connects
 */
export const junctionRadius = (laneCount: number): number => {
  const halfWidth = (laneCount * ROAD_LANE_WIDTH) / 2
  return halfWidth + INTERSECTION_CLEARANCE_M
}

/**
 * The radius a junction needs, from the lane counts of the roads it
 * connects. The **widest** connected road decides the half-width — the box
 * is shared by every approach, so it has to hold the widest carriageway.
 *
 * An empty list (a junction whose roads the caller does not have) falls
 * back to a single lane, the narrowest carriageway there is. The backend's
 * `junction_radius` uses the same default (`max(..., default=1)`), so the
 * two sides still agree in that degenerate case.
 */
export const junctionRadiusForRoads = (laneCounts: readonly number[]): number => {
  const widest = laneCounts.length > 0 ? Math.max(...laneCounts) : 1
  return junctionRadius(widest)
}

/**
 * The extra room a **corner** — two roads meeting at an angle — needs on
 * top of the box the rule already gives it.
 *
 * A corner is not a queue, but a vehicle **in the turn** is inside the
 * junction while it turns, and it sweeps outside the two carriageways'
 * half-widths. The loop scene's four corners carry this margin on top of
 * the rule's half-width and clearance (2 lanes → 3.5 + 4.5 + 0.5 = 8.5 m).
 */
export const CORNER_TURN_ENVELOPE_M = 0.5

/**
 * The radius of a **corner** junction: the rule's radius plus the
 * turning envelope (see `CORNER_TURN_ENVELOPE_M`).
 */
export const cornerRadius = (laneCount: number): number =>
  junctionRadius(laneCount) + CORNER_TURN_ENVELOPE_M
