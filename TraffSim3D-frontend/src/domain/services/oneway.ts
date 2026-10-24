// src/domain/services/oneway.ts
//
// Which lanes may a vehicle drive on?
//
// A road carries an optional `oneway` flag. `true` means the traffic on
// it runs in ONE direction only — the road's own forward direction
// (start → end). The OSM parser emits the flag for every road it
// parses, and it flips a `oneway=-1` way so that "forward" always
// means the direction the traffic actually runs.
//
// The lane model splits a road's lanes into two halves (see
// `laneForwardSign` in `laneGeometry.ts`): lanes `[0, n/2)` travel
// start → end, lanes `[n/2, n)` travel end → start. On a TWO-WAY road
// both halves are legal. On a ONE-WAY road the backward half is the
// phantom half of a two-way road — there is no oncoming carriageway
// there, so a vehicle that ends up on it drives against the flow.
//
// This module is the **single home** of that rule. Every place that can
// put a vehicle somewhere — the junction turn, the lane change, the
// spawn — asks it here instead of re-deriving "is this lane legal" from
// the `oneway` flag on its own.
//
// Pure by rule: no Three.js, no DOM, no Rapier — this is the `domain/`
// layer.

import type { Road } from '@domain/entities/Road'
import { laneForwardSign } from './laneGeometry'

/**
 * The direction of travel on a road, relative to the road's own
 * geometry: `+1` is start → end (the road's forward direction), `-1`
 * is end → start.
 */
export type TravelSign = 1 | -1

/**
 * May traffic travel on `road` in the direction `sign`?
 *
 * A one-way road carries its traffic in the forward direction only, so
 * the backward direction is refused. A two-way road allows both, and so
 * does a road that does not state the flag — every road of the built-in
 * scenes and every scene saved before the field existed reads as
 * two-way, so the default behaviour is unchanged.
 */
export const allowsTravelSign = (road: Road, sign: TravelSign): boolean =>
  road.oneway !== true || sign === 1

/**
 * Is `laneIndex` a lane a vehicle may drive on?
 *
 * The lane's own travel direction decides: on a one-way road only the
 * forward lanes carry traffic, the backward ones are the phantom half
 * of a two-way road.
 */
export const isDrivableLane = (road: Road, laneIndex: number): boolean =>
  allowsTravelSign(road, laneForwardSign(laneIndex, road.laneCount))
