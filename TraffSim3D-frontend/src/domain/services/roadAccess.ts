// src/domain/services/roadAccess.ts
//
// How wide a road really is, and whether a vehicle fits through it.
//
// The map importer already carries each road's OSM highway class (the
// parser emits `highway` next to the lane count and speed limit it was
// derived from). The class matters because a lane's METRES differ by
// class: a motorway lane is 3.75 m of asphalt, a residential lane is
// about 3.0, and an OSM "unclassified" way is usually a narrow lane —
// 2.2 m of it, less than a car plus its mirrors. The parser cannot know
// this: it derives ONE lane count from the `lanes` tag (defaulting to 2)
// and has no per-class width table, so the width lives here, next to
// the rule that consumes it.
//
// The consumer is both the RENDERER (the road must be drawn as wide as
// it physically is — the whole point of the white-model road ribbons)
// and the SIMULATION (a vehicle that does not fit must never spawn on
// or turn into such a road: it would scrape both curbs forever).
//
// The HEIGHT is the same kind of constraint, one dimension further
// out: a road's `maxheight` (a tunnel's 3.5 m) decides whether a bus
// may be on it at all. It is in this file for the same reason the width
// is: the parser cannot know a vehicle's shape, so the rule that
// consumes the limit lives next to the vehicle table.

import type { Road } from '@domain/entities/Road'
import type { Vehicle } from '@domain/entities/Vehicle'
import { VEHICLE_BODY_SPEC } from '@shared/constants/simulation'

/** Metres of lane width per OSM highway class. */
const LANE_WIDTH_BY_CLASS: Record<string, number> = {
  motorway: 3.75,
  trunk: 3.75,
  primary: 3.5,
  secondary: 3.5,
  tertiary: 3.0,
  residential: 3.0,
  unclassified: 2.2, // the narrow lanes between buildings
  living_street: 2.2,
  service: 1.8,
  road: 3.0,
}

/** Fallback for a road with no class (hand-built scenes). */
const DEFAULT_LANE_WIDTH_M = 3.0

/**
 * The width of ONE lane of `road`, in metres.
 *
 * An OSM way's `lanes` tag is trustworthy for the big classes and noise
 * for the small ones (most unclassified ways carry no tag, so the
 * parser defaults them to 2). The narrow classes are therefore counted
 * as the single lane they physically are.
 */
export const effectiveLaneCount = (road: Road): number => {
  const cls = (road.highway ?? '').toLowerCase()
  if (cls === 'unclassified' || cls === 'living_street' || cls === 'service') return 1
  return Math.max(1, road.laneCount)
}

/** Full carriageway width of `road`, in metres. */
export const roadWidthM = (road: Road): number => {
  const cls = (road.highway ?? '').toLowerCase()
  const laneWidth = LANE_WIDTH_BY_CLASS[cls] ?? DEFAULT_LANE_WIDTH_M
  return effectiveLaneCount(road) * laneWidth
}

/** A vehicle needs this much clearance beyond its own body (mirrors). */
export const ROAD_MIN_CLEARANCE_M = 0.6

/** Vehicle width plus clearance — what a road must offer to admit it. */
export const vehicleRequiredWidthM = (type: Vehicle['type']): number =>
  VEHICLE_BODY_SPEC[type].width + ROAD_MIN_CLEARANCE_M

/**
 * Can `road` physically admit the vehicle type?
 *
 * A car is 1.8 m wide: it fits a 3.0 m residential lane and does NOT
 * fit a 2.2 m unclassified lane (2.4 > 2.2 — the gap between two
 * buildings that only pedestrians fit through). A bus is 2.5 m wide:
 * it needs a full 3.1 m, so single-lane residential streets exclude it
 * too.
 *
 * AND the road must clear the vehicle's HEIGHT. That is the rule the
 * OSM `maxheight` tag feeds: the 春风隧道 tunnel is signed at 3.5 m,
 * which takes a car (1.8 m) and refuses a bus (3.6 m). A road with no
 * limit clears everything.
 */
export const vehicleFitsRoad = (road: Road, type: Vehicle['type']): boolean =>
  roadWidthM(road) >= vehicleRequiredWidthM(type) && vehicleFitsRoadHeight(road, type)

/**
 * The road's height limit in metres, or null when it has none.
 *
 * `undefined` (the built-in scenes) and an explicit `null` both mean
 * "no limit" — which is also what OSM's `maxheight=no` and
 * `maxheight=default` mean, so the parser drops them.
 */
export const roadHeightLimitM = (road: Road): number | null => {
  const limit = road.maxHeightM
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return null
  return limit
}

/** A vehicle needs this much clearance above its body (roof equipment). */
export const ROAD_MIN_HEIGHT_CLEARANCE_M = 0.2

/** Vehicle height plus clearance — what a road must offer overhead. */
export const vehicleRequiredHeightM = (type: Vehicle['type']): number =>
  VEHICLE_BODY_SPEC[type].height + ROAD_MIN_HEIGHT_CLEARANCE_M

/**
 * Can the vehicle pass UNDER the road's height limit?
 *
 * A road with no limit clears every vehicle. A road limited to 3.5 m
 * takes a car (1.6 m + 0.2 m clearance) and refuses a bus (3.4 m +
 * 0.2 m) — which is why the 春风隧道 in the Shenzhen extract is a
 * place where a bus cannot follow the cars.
 */
export const vehicleFitsRoadHeight = (road: Road, type: Vehicle['type']): boolean => {
  const limit = roadHeightLimitM(road)
  if (limit === null) return true
  return vehicleRequiredHeightM(type) <= limit + 1e-9
}
