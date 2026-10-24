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
//              + the nose-overhang clearance, when a queue can form
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
// ## Who owns the number
//
// The frontend owns it — for **every** map, built-in or imported. The
// imported maps used to trust the backend's payload instead, which
// meant two independent answers to the same question; the backend
// derives the same number from the same lane model
// (`app/apps/maps/osm_parser.py` → `junction_radius`), and a
// cross-check over the real Shenzhen OSM extract (7991 junctions)
// proved the two agree on every one of them.
//
// The `queueable` flag is the one input that differs between the two
// kinds of map, and it is a statement about **where traffic can be
// stopped**, not about the geometry:
//
//   - a built-in junction with a traffic light can hold a queue at its
//     stop line → the clearance applies;
//   - a built-in junction without one (the loop scene's corners, the
//     elevated scene's ramp end) cannot → the half-width alone;
//   - **every** imported junction can: the frontend paints a stop line
//     on every junction's box edge and the cross-road yield rule
//     (`tick.ts` → `applyCrossRoadYield`) can stop a vehicle in front
//     of any of them, lit or not. The parser's own traffic lights are
//     no proxy for that — it only attaches one to the OSM nodes tagged
//     `highway=traffic_signals` (51 of the 7991 junctions in the
//     Shenzhen extract).

import { INTERSECTION_CLEARANCE_M, ROAD_LANE_WIDTH } from '@shared/constants/simulation'

/**
 * The radius of a junction box that has to hold the carriageway of a road
 * with `laneCount` lanes — plus the clearance that keeps a queued vehicle's
 * nose out of it (see `INTERSECTION_CLEARANCE_M`).
 *
 * @param laneCount  the lane count of the widest road the junction connects
 * @param queueable  true when a vehicle can be **stopped in front of** this
 *   junction (so a queue — and therefore a nose overhang — can form there)
 */
export const junctionRadius = (laneCount: number, queueable: boolean): number => {
  const halfWidth = (laneCount * ROAD_LANE_WIDTH) / 2
  return queueable ? halfWidth + INTERSECTION_CLEARANCE_M : halfWidth
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
export const junctionRadiusForRoads = (
  laneCounts: readonly number[],
  queueable: boolean,
): number => {
  const widest = laneCounts.length > 0 ? Math.max(...laneCounts) : 1
  return junctionRadius(widest, queueable)
}

/**
 * The extra room a **corner** — two roads meeting at an angle, with no
 * traffic light — needs on top of the carriageway it has to hold.
 *
 * A corner is not a queue, but a vehicle **in the turn** is inside the
 * junction while it turns, and it sweeps outside the two carriageways'
 * half-widths. The loop scene's four corners carry this margin on top of
 * the rule's half-width (2 lanes → 3.5 m + 0.5 m = 4 m).
 */
export const CORNER_TURN_ENVELOPE_M = 0.5

/**
 * The radius of a **corner** junction: the rule's half-width plus the
 * turning envelope (see `CORNER_TURN_ENVELOPE_M`).
 *
 * A corner never holds a queue — it has no traffic light — so the
 * nose-overhang clearance does not apply to it.
 */
export const cornerRadius = (laneCount: number): number =>
  junctionRadius(laneCount, false) + CORNER_TURN_ENVELOPE_M
