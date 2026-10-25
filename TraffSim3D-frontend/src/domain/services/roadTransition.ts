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
import { isDrivableLane } from './oneway'
import { junctionIndex } from './roadJunctionIndex'
import { RIGHT_TURN_SHARE, TURN_PROBABILITY } from '@shared/constants/simulation'

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

/** Two headings are "the same" for the tie-break below. */
const SAME_HEADING_EPS = 1e-9

/**
 * The movement a candidate represents, relative to the vehicle's incoming
 * heading.
 *
 * `right` and `left` are decided by the **sign** of the signed turn angle:
 * the model's headings run from +X (east) towards +Z (north), so a
 * vehicle heading north (pi/2) that ends up heading east (0) has turned
 * by -pi/2 — which, in right-hand traffic, is a **right** turn.
 */
type Movement = 'straight' | 'right' | 'left' | 'uturn'

/** Up to this angle the movement is "straight on" (45 degrees). */
const STRAIGHT_LIMIT_RAD = Math.PI / 4
/** Beyond this angle the movement is a u-turn (135 degrees). */
const U_TURN_LIMIT_RAD = (3 * Math.PI) / 4

/**
 * The signed turn angle from one heading to another, in (-pi, pi].
 *
 * A positive angle is a **left** turn and a negative one a **right**
 * turn — see `Movement`.
 */
const signedTurnAngle = (from: number, to: number): number => {
  let d = (to - from) % (2 * Math.PI)
  if (d > Math.PI) d -= 2 * Math.PI
  if (d < -Math.PI) d += 2 * Math.PI
  return d
}

/** The movement a signed turn angle represents. */
const movementOf = (delta: number): Movement => {
  const magnitude = Math.abs(delta)
  if (magnitude > U_TURN_LIMIT_RAD) return 'uturn'
  if (magnitude <= STRAIGHT_LIMIT_RAD) return 'straight'
  return delta < 0 ? 'right' : 'left'
}

/**
 * A hash of a key into [0, 1) — FNV-1a, 32 bit.
 *
 * Integer arithmetic only, so the same key gives the same number on
 * every platform and in every engine. That is what makes the turn
 * decision **reproducible**: the simulation has no random source, and a
 * run can be replayed exactly.
 */
const hash01 = (key: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  // murmur3's finalizer. The FNV multiply mixes the low bits well but
  // leaves the high ones poorly mixed — and the value is taken from the
  // high end, so without this the shares came out skewed (measured: a
  // right-turn share of 0.49 where 0.60 was asked for).
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h ^= h >>> 16
  // The `^` operator yields a **signed** 32-bit integer, so the value has
  // to be brought back to unsigned here — otherwise the fraction below
  // is negative for half the keys and the shares come out skewed.
  h = h >>> 0
  return h / 0x100000000
}

/** A candidate road, with the movement it represents. */
interface Candidate extends RoadContinuation {
  /** The signed turn angle from the vehicle's heading. */
  delta: number
  /** The movement this candidate represents. */
  movement: Movement
}

/**
 * The continuation of `road` / `laneIndex` for a vehicle that has run
 * past the end of its lane, or `null` when it cannot turn.
 *
 * `null` means "keep the historical wrap": either there is no junction
 * at the travel end at all, or the junction has no other road to
 * continue onto.
 *
 * The choice between several candidate roads is **deterministic**: the
 * movement is decided first (see below) and the road that best carries
 * that movement wins, with ties broken by the road id (lexicographically)
 * so the result does not depend on the order the junction lists its
 * roads in.
 *
 * **Which movement the vehicle makes** is the interesting part. The rule
 * used to be "take the road that best continues the heading", which is
 * the same as saying that a vehicle never turns where it could go
 * straight — measured on the 5 x 5 grid, all 29 ninety-degree turns
 * landed at the edge of the map and none at an interior junction, so
 * the city had no crossroads behaviour at all.
 *
 * Now a vehicle **turns** with the probability `TURN_PROBABILITY` (a
 * quarter of the movements in a real street network), and a right turn
 * is the likelier of the two (`RIGHT_TURN_SHARE`); otherwise it goes
 * straight on. The decision is a **hash** of the vehicle, the junction
 * and the road it came from — no random source, so a run replays
 * exactly. A junction with no straight continuation (a corner, a
 * T-junction) forces a turn, and a u-turn is only ever taken when
 * nothing else is on offer.
 *
 * `turnSeed` is the vehicle's identity: with it the movement is the
 * probabilistic one above; without it the choice falls back to "straight
 * on when that is possible", which is the rule the topology tests use.
 *
 * **The pivot's sideways jump — a known limitation.** The junction sits
 * on the roads' centre lines, while the lane the vehicle lands in sits
 * `laneOffset(lane)` to the side of it, so the pivot moves the body
 * sideways by up to that offset. The landing point itself is already
 * snapped to the lane: measured on the real Shenzhen import (391 roads,
 * 8 cars, 90 s) the car ends up **0.00 m** off the centre of the lane
 * it turns into, every turn, and its lateral offset stays 0.00 m for
 * the rest of the run — no lane guard fires.
 *
 * What remains is the size of the jump itself: 0.74 m on average,
 * 1.76 m at p95 and 1.78 m at worst on the import, and 10.21 m on a
 * hand-built right-angle corner between a 6-lane and a 4-lane road.
 * Removing it would need a real arc between the two lanes, which this
 * model has no concept of; the cheap alternative (landing on the
 * junction instead of the lane centre) would leave the car a whole lane
 * width off its own lane — 5.25 m on that corner — so the landing point
 * stays snapped to the lane.
 */
export const roadContinuation = (
  network: RoadNetwork,
  road: Road,
  laneIndex: number,
  heading: number,
  turnSeed?: string,
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
  const candidates: Candidate[] = []
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
      //
      // Forward IS the direction the traffic of a one-way road runs
      // (the OSM parser flips a `oneway=-1` way so that "forward" means
      // the travel direction), so entering at the near end is legal on
      // every road. The lane check is what keeps a one-way road's
      // phantom backward half out of the picture — the rule lives in
      // `oneway.ts`, the single home of the one-way rule.
      newLane = 0
      if (!isDrivableLane(other, newLane)) continue
      entryS = 0
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
      //
      // The vehicle needs a BACKWARD lane to drive on: the keep-right
      // lane of that direction is `laneCount - 1`, and it only exists
      // when the road has at least two lanes. A one-lane road has no
      // backward lane at all, so it cannot be entered from its far end
      // either — the vehicle would be put on a FORWARD lane at the far
      // end of the road and drive straight off it.
      const backLane = other.laneCount - 1
      if (backLane < other.laneCount / 2) continue
      if (!isDrivableLane(other, backLane)) continue
      entryS = otherLen
      newLane = backLane
    } else {
      continue
    }

    const candidateHeading = lanePoint(other, newLane, entryS).heading
    const delta = signedTurnAngle(heading, candidateHeading)
    candidates.push({
      roadId: other.id,
      laneIndex: newLane,
      s: entryS,
      heading: candidateHeading,
      delta,
      movement: movementOf(delta),
    })
  }
  if (candidates.length === 0) return null

  // 3. The movement the vehicle makes.
  //
  //    The candidates are grouped by the movement they represent, and a
  //    hash of (vehicle, junction, road) decides which movement it
  //    takes. A junction with no straight continuation — a corner, a
  //    T-junction — has no choice to make, so it forces a turn.
  const straights = candidates.filter((c) => c.movement === 'straight')
  const rights = candidates.filter((c) => c.movement === 'right')
  const lefts = candidates.filter((c) => c.movement === 'left')
  const uturns = candidates.filter((c) => c.movement === 'uturn')

  let pool: Candidate[]
  if (turnSeed === undefined) {
    // No vehicle identity: the historical rule — straight on when that
    // is possible, and the best of the rest otherwise.
    pool = straights.length > 0 ? straights : [...rights, ...lefts, ...uturns]
  } else {
    const key = `${turnSeed}|${junction.id}|${road.id}`
    const wantsTurn = hash01(`${key}|turn`) < TURN_PROBABILITY
    const preferRight = hash01(`${key}|side`) < RIGHT_TURN_SHARE
    if (wantsTurn || straights.length === 0) {
      const preferred = preferRight ? rights : lefts
      const other = preferRight ? lefts : rights
      pool =
        preferred.length > 0
          ? preferred
          : other.length > 0
            ? other
            : [...straights, ...uturns]
    } else {
      pool = straights
    }
  }
  if (pool.length === 0) return null

  // 4. The candidate that best carries that movement. Ties go to the
  //    lexicographically smaller road id, so the result does not depend
  //    on the order the junction lists its roads in.
  let best = pool[0]!
  let bestDelta = Math.abs(best.delta)
  for (let i = 1; i < pool.length; i++) {
    const candidate = pool[i]!
    const delta = Math.abs(candidate.delta)
    const better =
      delta < bestDelta - SAME_HEADING_EPS ||
      (Math.abs(delta - bestDelta) <= SAME_HEADING_EPS && candidate.roadId < best.roadId)
    if (!better) continue
    best = candidate
    bestDelta = delta
  }
  return best
}
