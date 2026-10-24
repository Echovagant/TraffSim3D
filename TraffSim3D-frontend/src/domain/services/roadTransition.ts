// src/domain/services/roadTransition.ts
//
// Which road does a vehicle take when it runs past the end of its lane?
//
// The travel end of a lane is one of the two ends of its road: a forward
// lane (laneIndex < laneCount / 2) runs start → end and ends at
// `s = roadLength`, a backward lane runs end → start and ends at `s = 0`.
//
// What used to happen there is a **wrap**: the vehicle re-entered the
// same lane from the other end of the same road. But the road network IS
// a graph — `Intersection.connectedRoads` says which roads meet where —
// and the wrap threw that graph away.
//
// Measured on the real imported OSM city (391 roads / 450 junctions,
// 8 cars, 90 s): 43 200 vehicle-frames produced **0 road changes**. Every
// car looped on its own way while the city around it was fully drawn.
//
// This module is the pure geometry/topology of the turn: given the
// network, the road, the lane and the vehicle's heading, it returns the
// continuation `{ roadId, laneIndex, s, heading }` — or `null` when no
// turn is possible, which is the caller's signal to fall back to the
// historical wrap.
//
// The turn is a **pivot in place**: the exit point of the current road
// and the entry point of the candidate road are the same junction, so
// the vehicle moves ~0 m and changes heading. The model has no arc
// concept, and a teleport with a heading change is the model's own idiom
// (the travel-end wrap already teleports).
//
// Pure by rule: no Three.js, no DOM, no Rapier — this is the `domain/`
// layer.

import type { Road } from '@domain/entities/Road'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import { laneForwardSign, lanePoint, projectIntersectionOnRoad, roadLength } from './laneGeometry'
import { junctionIndex } from './roadJunctionIndex'

/**
 * How far (m) a junction's projected centre may sit from a road's travel
 * end and still count as "at that end".
 *
 * The projection is the same one the whole traffic logic uses
 * (`projectIntersectionOnRoad`): the junction's world position projected
 * onto the road's polyline. A junction that sits in the MIDDLE of the
 * road — the cross scene's junction, for instance — is nowhere near
 * either travel end, so no turn happens there and the road keeps its
 * historical wrap. One metre is the tolerance: it is far below the
 * length of a lane and far above the rounding of a projection.
 */
export const JUNCTION_END_TOLERANCE_M = 1.0

/** The continuation of a lane that has run past its travel end. */
export interface RoadContinuation {
  /** The road the vehicle continues onto. */
  roadId: string
  /**
   * The lane of that road it continues on — the **keep-right** lane of
   * the travel direction: lane 0 when it continues forward (s grows from
   * 0), lane `laneCount - 1` when it continues backward (s shrinks from
   * the road's length).
   */
  laneIndex: number
  /** The entry arc length on the new road: 0 or the road's length. */
  s: number
  /** The new lane's travel heading at the entry point (radians). */
  heading: number
}

/**
 * The angle between two directions, wrapped to [0, π].
 *
 * A direction and its opposite are π apart, so this metric cannot tell
 * "straight ahead" from "backwards" — that is deliberate: the caller
 * picks the candidate that best continues the vehicle's heading, and a
 * u-turn is never a better continuation than going straight.
 */
const headingDelta = (a: number, b: number): number => {
  let d = Math.abs(a - b) % (2 * Math.PI)
  if (d > Math.PI) d = 2 * Math.PI - d
  return d
}

/** Two headings are "the same" for the tie-break below. */
const SAME_HEADING_EPS = 1e-9

/**
 * The continuation of `road` / `laneIndex` for a vehicle that has run
 * past the end of its lane, or `null` when it cannot turn.
 *
 * `null` means "keep the historical wrap": either there is no junction
 * at the travel end at all, or the junction has no other road to
 * continue onto.
 *
 * The choice between several candidate roads is deterministic: the one
 * whose travel direction at the entry point best continues `heading`
 * wins, and a tie is broken by the road id (lexicographically) so the
 * simulation is reproducible.
 */
export const roadContinuation = (
  network: RoadNetwork,
  road: Road,
  laneIndex: number,
  heading: number,
): RoadContinuation | null => {
  const len = roadLength(road)
  if (len < 1e-6) return null

  // Which end of the road does this lane run into?
  const sign = laneForwardSign(laneIndex, road.laneCount)
  const endS = sign === 1 ? len : 0

  const junctions = junctionIndex(network)

  // 1. The junction AT that end. A junction in the middle of the road is
  //    not at the travel end, so no turn happens there.
  let junction = null
  for (const inter of junctions.on(road.id)) {
    const projection = projectIntersectionOnRoad(road, inter)
    // A rejected projection means "we do not know where this junction
    // sits on this road" — the fallback value is the road's midpoint,
    // which says nothing about the travel end.
    if (!projection.projected) continue
    if (Math.abs(projection.s - endS) > JUNCTION_END_TOLERANCE_M) continue
    junction = inter
    break
  }
  if (!junction) return null

  // 2. The candidate roads: the junction's other roads. The road the
  //    vehicle came from is never a candidate.
  const candidates: RoadContinuation[] = []
  for (const otherId of junction.connectedRoads) {
    if (otherId === road.id) continue
    const other = network.roads[otherId]
    if (!other) continue
    const otherLen = roadLength(other)
    if (otherLen < 1e-6) continue

    // The vehicle enters the candidate at the end of it that is nearest
    // the junction. A junction in the MIDDLE of the candidate is not an
    // entry end — the vehicle has no way onto that road from here, so
    // the candidate is dropped.
    const projection = projectIntersectionOnRoad(other, junction)
    if (!projection.projected) continue
    let entryS: number
    let newLane: number
    if (projection.s <= JUNCTION_END_TOLERANCE_M) {
      // The junction is at the candidate's start → the vehicle drives on
      // forward, from s = 0 upwards.
      entryS = 0
      newLane = 0
    } else if (projection.s >= otherLen - JUNCTION_END_TOLERANCE_M) {
      // The junction is at the candidate's end → the vehicle drives on
      // backward, from s = otherLen downwards.
      //
      // **Unless the candidate is one-way.** A one-way road carries its
      // traffic in the FORWARD direction only, so a vehicle entering it
      // at its far end would be driving against the flow — on the
      // oncoming lane. The backend already flips a one-way way so that
      // "forward" means the direction the traffic runs, and it halves
      // the lane count of a one-way road (so its backward lanes are the
      // phantom half of a two-way road).
      //
      // Measured on the real Shenzhen extract: without this filter, 23 of
      // the 544 turnable road ends (4.2 %) would have put a vehicle on
      // the wrong side of a one-way street. A one-way road whose junction
      // is at its far end is simply **not** a continuation — the traffic
      // on it runs away from the junction.
      if (other.oneway === true) continue
      entryS = otherLen
      newLane = other.laneCount - 1
    } else {
      continue
    }

    candidates.push({
      roadId: other.id,
      laneIndex: newLane,
      s: entryS,
      heading: lanePoint(other, newLane, entryS).heading,
    })
  }
  if (candidates.length === 0) return null

  // 3. The candidate that best continues the vehicle's heading. Ties go
  //    to the lexicographically smaller road id, so the result does not
  //    depend on the order the junction lists its roads in.
  let best = candidates[0]!
  let bestDelta = headingDelta(heading, best.heading)
  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i]!
    const delta = headingDelta(heading, candidate.heading)
    const better =
      delta < bestDelta - SAME_HEADING_EPS ||
      (Math.abs(delta - bestDelta) <= SAME_HEADING_EPS && candidate.roadId < best.roadId)
    if (!better) continue
    best = candidate
    bestDelta = delta
  }
  return best
}
