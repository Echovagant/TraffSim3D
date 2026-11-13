// src/domain/services/clearanceBeams.ts
//
// The physical twin of the height rule.
//
// The domain already knows that a 3.5 m tunnel does not take a bus:
// `roadAccess.ts` → `vehicleFitsRoadHeight` compares the vehicle's
// height (plus a roof-equipment clearance) against the road's OSM
// `maxheight`. That rule decides where a vehicle may be SPAWNED and
// which way it may TURN.
//
// But a rule that only guards the spawn is not the same as a rule the
// vehicle feels. A bus that is already on the road — because the map
// changed under it, because it was placed by hand, because the rule
// arrived with a later import — would drive straight under the tunnel
// roof, because the physics world has no vertical geometry at all:
// the vehicle's box is 3.4 m tall and there is nothing above it to
// hit.
//
// This module derives the missing geometry: a **clearance beam** over
// every height-limited road — the portal the vehicle must fit through.
// The physics layer gives it a fixed body; a vehicle taller than the
// clearance hits it and stops, exactly as a real bus hits a tunnel
// portal.
//
// ## The clearance height is NOT the sign's number
//
// The sign says 3.5 m; the rule demands `height + 0.2 ≤ 3.5`; the
// beam therefore sits at **3.3 m** above the road. A 3.4 m bus is
// 0.1 m too tall for the rule and 0.1 m too tall for the beam — the
// two agree to the centimetre, and a car (1.6 m) passes both.
//
// ## Where the beam goes
//
// At the road's two ends — the portals. The tunnel is entered from
// one end or the other, and a beam across the road at each end stops
// the vehicle BEFORE it is under the roof. Putting the beam over the
// whole road instead would trap a bus that is already inside it, and
// trapping a vehicle in the middle of a tunnel is worse than letting
// it through.

import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import { roadForward, roadLength, roadWaypoints } from './laneGeometry'
import { ROAD_MIN_HEIGHT_CLEARANCE_M, roadHeightLimitM, roadWidthM } from './roadAccess'

/**
 * A portal over a height-limited road.
 *
 * The geometry is a box: `halfDepth` along the road, `halfWidth`
 * across it, and its **underside** at `clearanceM` above the road
 * surface. The road's own height is the surface (`y`), so the beam
 * rides with the road (a ramp keeps its portal on the ramp).
 */
export interface ClearanceBeam {
  /** Stable id — the road id plus which end. */
  id: string
  /** The underside of the beam, in metres above the road surface. */
  clearanceM: number
  /** The beam's centre, on the road surface. */
  x: number
  y: number
  z: number
  /** The beam's yaw, in radians — the road's direction at that end. */
  heading: number
  /** Half-extent ACROSS the road (m). */
  halfWidth: number
  /** Half-extent ALONG the road (m) — the portal's thickness. */
  halfDepth: number
}

/** How thick a portal is (m) — enough that a fast vehicle cannot
 *  tunnel through it in one step (a bus at 15 m/s moves 0.25 m per
 *  1/60 s step). */
export const CLEARANCE_BEAM_THICKNESS_M = 0.3

/** The beam reaches a little past the carriageway on each side, so a
 *  vehicle hugging the kerb still meets it. */
const BEAM_SIDE_MARGIN_M = 0.5

/**
 * The clearance beams of a network — one pair for every road that
 * carries a height limit.
 *
 * A road without a limit produces no beam: `maxheight=no` and
 * `maxheight=default` both mean "nothing overhead" (the parser drops
 * them), and the built-in scenes have no limit at all.
 */
export const clearanceBeamsFor = (network: RoadNetwork): ClearanceBeam[] => {
  const beams: ClearanceBeam[] = []
  for (const road of Object.values(network.roads)) {
    const limit = roadHeightLimitM(road)
    if (limit === null) continue
    const clearance = limit - ROAD_MIN_HEIGHT_CLEARANCE_M
    // A limit below the clearance would put the portal under the
    // road — nothing sensible to build. (No real road is like this;
    // a 0.1 m limit would be a data error.)
    if (clearance <= 0) continue
    const halfWidth = roadWidthM(road) / 2 + BEAM_SIDE_MARGIN_M
    const len = roadLength(road)
    const waypoints = roadWaypoints(road)
    const last = waypoints[waypoints.length - 1]
    if (!last) continue

    // The start portal: the tangent at s = 0.
    const startTangent = roadForward(road, 0)
    const start = waypoints[0]!
    beams.push({
      id: `${road.id}#start`,
      clearanceM: clearance,
      x: start.x,
      y: start.y ?? 0,
      z: start.z,
      heading: Math.atan2(startTangent.uz, startTangent.ux),
      halfWidth,
      halfDepth: CLEARANCE_BEAM_THICKNESS_M / 2,
    })

    // The end portal: the tangent at the end of the road. A road that
    // is its own reverse (a loop) gets the same portal twice under
    // two ids — harmless, and the geometry is the same point.
    const endTangent = roadForward(road, len)
    beams.push({
      id: `${road.id}#end`,
      clearanceM: clearance,
      x: last.x,
      y: last.y ?? 0,
      z: last.z,
      heading: Math.atan2(endTangent.uz, endTangent.ux),
      halfWidth,
      halfDepth: CLEARANCE_BEAM_THICKNESS_M / 2,
    })
  }
  return beams
}

/**
 * Does a vehicle of `heightM` clear a beam?
 *
 * The same comparison the rule makes, phrased against the beam's
 * underside: a vehicle passes iff its own height (the box's height,
 * which sits ON the road) fits under the portal.
 */
export const vehicleClearsBeam = (beam: ClearanceBeam, heightM: number): boolean =>
  heightM <= beam.clearanceM + 1e-9
