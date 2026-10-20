/**
 * Lane geometry helpers.
 *
 * Plan 035: polyline-aware. `Road` may have `waypoints?: Position[]`
 * (length ≥ 2); lane geometry is derived from the polyline.
 * For 2-point roads (`waypoints` absent or length 2) the math
 * collapses to a straight segment and is mathematically equivalent
 * to the pre-035 straight-line formulas.
 *
 * Convention (right-hand traffic, like CN / US):
 *  - lane indices are 0..N-1
 *  - lane 0 is the *rightmost* lane going start→end (forward)
 *  - lane N/2-1 is the *leftmost* forward lane
 *  - lane N/2 is the *leftmost* backward lane (drives end→start)
 *  - lane N-1 is the *rightmost* backward lane
 *  - the yellow centerline is between lane N/2-1 and lane N/2
 */
import type { Road } from '@domain/entities/Road'
import type { Position } from '@domain/value-objects/Position'
import { ROAD_LANE_WIDTH, STOP_LINE_DISTANCE } from '@shared/constants/simulation'

export interface UnitVec2 {
  ux: number
  uz: number
}

/** Plan 035: Return the polyline waypoints of `road`. If the road has no
 *  `waypoints` field, or only two points, return `[startNode, endNode]`.
 *  All downstream geometry helpers route through this so 2-point
 *  backward-compat is automatic. */
export const roadWaypoints = (road: Road): readonly Position[] => {
  if (road.waypoints && road.waypoints.length >= 2) return road.waypoints
  return [road.startNode, road.endNode]
}

/** Plan 035: per-segment cumulative arc length `[segLen1, segLen1+segLen2, ...]`.
 *  The last element is the total polyline length. Cached in a WeakMap
 *  since `Road` instances are readonly — first call computes, all later
 *  calls are O(1). */
const CUM_LENGTHS_CACHE = new WeakMap<Road, ReadonlyArray<number>>()
export const roadPolylineLengths = (road: Road): ReadonlyArray<number> => {
  const cached = CUM_LENGTHS_CACHE.get(road)
  if (cached) return cached
  const wps = roadWaypoints(road)
  const cum: number[] = []
  let acc = 0
  for (let i = 0; i < wps.length - 1; i++) {
    const a = wps[i]!
    const b = wps[i + 1]!
    const dx = b.x - a.x
    const dz = b.z - a.z
    // 3D segment length (Y matters for 036 ramps, even though 035 roads are flat).
    const dy = (b.y ?? 0) - (a.y ?? 0)
    acc += Math.sqrt(dx * dx + dy * dy + dz * dz)
    cum.push(acc)
  }
  CUM_LENGTHS_CACHE.set(road, cum)
  return cum
}

/** Plan 035: find the polyline segment that contains arc-length `s`, plus
 *  the local normalized parameter `t` within that segment (0..1). */
export interface PolylineSegment {
  segIdx: number
  segStartS: number
  segEndS: number
  segLen: number
}

export const segmentAt = (road: Road, s: number): PolylineSegment => {
  const wps = roadWaypoints(road)
  const cum = roadPolylineLengths(road)
  // Degenerate single point road (N=1 — not expected from data invariant,
  // but guarded anyway).
  if (cum.length === 0) {
    return { segIdx: 0, segStartS: 0, segEndS: 0, segLen: 0 }
  }
  // Clamp s into the polyline range — OOB callers should already have
  // wrapped the value, but defensive clamp here keeps geometry finite.
  const total = cum[cum.length - 1]!
  const sClamped = Math.max(0, Math.min(total, s))
  // Linear search through cum array (N segments, small). For M2 scale
  // (≤ 8 segments per road) this beats a binary search on overhead.
  for (let i = 0; i < cum.length; i++) {
    if (sClamped <= cum[i]!) {
      const segStart = i === 0 ? 0 : cum[i - 1]!
      const segLen = cum[i]! - segStart
      const segEnd = cum[i]!
      return { segIdx: i, segStartS: segStart, segEndS: segEnd, segLen }
    }
  }
  // Should not reach here since we clamped to total; return last segment.
  const lastIdx = cum.length - 1
  const segStart = lastIdx === 0 ? 0 : cum[lastIdx - 1]!
  return {
    segIdx: lastIdx,
    segStartS: segStart,
    segEndS: cum[lastIdx]!,
    segLen: cum[lastIdx]! - segStart,
  }
}

/** Total arc length of the polyline (sum of segment lengths). */
export const roadLength = (road: Road): number => {
  const cum = roadPolylineLengths(road)
  return cum.length === 0 ? 0 : cum[cum.length - 1]!
}

/** Unit tangent at arc-length `s` (defaults to s=0 → first segment).
 *  Returns zero vec for degenerate (zero-length segment) cases. */
export const roadForward = (road: Road, s: number = 0): UnitVec2 => {
  const wps = roadWaypoints(road)
  const seg = segmentAt(road, s)
  if (seg.segLen < 1e-6 || wps.length < 2) return { ux: 0, uz: 0 }
  const a = wps[seg.segIdx]!
  const b = wps[seg.segIdx + 1]!
  return { ux: (b.x - a.x) / seg.segLen, uz: (b.z - a.z) / seg.segLen }
}

/** Perpendicular unit vector at arc-length `s`, "right" of forward direction.
 *  (ux, uz) rotated -90°: perpendicular = (uz, -ux). */
export const roadRight = (road: Road, s: number = 0): UnitVec2 => {
  const f = roadForward(road, s)
  return { ux: f.uz, uz: -f.ux }
}

/** Perpendicular distance from road centerline to the center of `laneIndex` (positive = right of forward). */
export const laneOffset = (laneIndex: number, laneCount: number): number => {
  // Lane 0  → +(laneCount/2 - 0.5) * laneWidth  (rightmost forward)
  // Lane N-1 → -(laneCount/2 - 0.5) * laneWidth (rightmost backward)
  return (laneCount / 2 - laneIndex - 0.5) * ROAD_LANE_WIDTH
}

/** +1 for forward lanes (start→end), -1 for backward lanes (end→start). */
export const laneForwardSign = (laneIndex: number, laneCount: number): 1 | -1 => {
  return laneIndex < laneCount / 2 ? 1 : -1
}

export interface LanePoint {
  position: Position
  /** Heading in radians, aligned with the lane's forward direction. */
  heading: number
}

/** Plan 035: `radius` defaults to STOP_LINE_DISTANCE * 2 = 10 m for back-compat
 *  with the pre-035 callers (tick.ts used a hard-coded formula).
 *  When a per-intersection radius is known, callers should pass it explicitly. */
export const intersectionSRange = (
  road: Road,
  radius: number = STOP_LINE_DISTANCE * 2,
): readonly [number, number] => {
  const len = roadLength(road)
  return [Math.max(0, len / 2 - radius), Math.min(len, len / 2 + radius)] as const
}

/** True if a vehicle at distance `s` along this road is inside the intersection box. */
export const inIntersectionBox = (
  road: Road,
  s: number,
  radius: number = STOP_LINE_DISTANCE * 2,
): boolean => {
  const [lo, hi] = intersectionSRange(road, radius)
  return s >= lo && s <= hi
}

/**
 * World position + heading for a vehicle in `laneIndex` at distance
 * `s` along the polyline. For 2-point roads the result matches the
 * pre-035 straight-line formula exactly (regression-safe).
 */
export const lanePoint = (road: Road, laneIndex: number, s: number): LanePoint => {
  const wps = roadWaypoints(road)
  const len = roadLength(road)
  if (len < 1e-6 || wps.length < 2) {
    return { position: { x: wps[0]?.x ?? 0, y: 0, z: wps[0]?.z ?? 0 }, heading: 0 }
  }
  const sClamped = Math.max(0, Math.min(len, s))
  const seg = segmentAt(road, sClamped)
  const a = wps[seg.segIdx]!
  const b = wps[seg.segIdx + 1]!
  const localT = seg.segLen < 1e-6 ? 0 : (sClamped - seg.segStartS) / seg.segLen
  const baseX = a.x + (b.x - a.x) * localT
  const baseZ = a.z + (b.z - a.z) * localT
  const baseY = (a.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * localT
  // Segment tangent → local forward.
  const tanX = (b.x - a.x) / seg.segLen
  const tanZ = (b.z - a.z) / seg.segLen
  // Perpendicular in XZ (rotate tangent -90° = "right" of forward): (uz, -ux).
  // Matches `roadRight()` convention exactly so lane 0 of a forward road
  // sits on the +laneOffset side (right of motion), preserving pre-035 layout.
  const perpX = tanZ
  const perpZ = -tanX
  const off = laneOffset(laneIndex, road.laneCount)
  const sign = laneForwardSign(laneIndex, road.laneCount)
  // Lane offset is in WORLD space, not motion-relative. Lane 0 sits at
  // +off perpendicular to the centerline (geometric "right" of forward);
  // lane N-1 sits at -off. This matches the pre-035 formula and is what
  // the renderer expects when painting lane markings.
  const heading = Math.atan2(tanZ * sign, tanX * sign)
  return {
    position: {
      x: baseX + perpX * off,
      y: baseY,
      z: baseZ + perpZ * off,
    },
    heading,
  }
}

/**
 * Project a world position onto the (road, laneIndex) parameter `s`.
 * Polyline-aware: scans each segment, projects onto that segment's
 * tangent, and returns the s with the smallest perpendicular distance.
 *
 * Used when migrating an old-style position into the new lane model
 * and as a sanity check by the spawner.
 */
export const worldToLaneS = (
  road: Road,
  laneIndex: number,
  worldX: number,
  worldZ: number,
): number => {
  const wps = roadWaypoints(road)
  const len = roadLength(road)
  if (len < 1e-6 || wps.length < 2) return 0
  const off = laneOffset(laneIndex, road.laneCount)
  const sign = laneForwardSign(laneIndex, road.laneCount)
  // For each segment, compute the s along that segment that minimises
  // perpendicular distance to the world point. Pick the segment with the
  // smallest perpendicular distance.
  let bestS = 0
  let bestPerpSq = Number.POSITIVE_INFINITY
  let running = 0
  for (let i = 0; i < wps.length - 1; i++) {
    const a = wps[i]!
    const b = wps[i + 1]!
    const dx = b.x - a.x
    const dz = b.z - a.z
    const segLen = Math.sqrt(dx * dx + dz * dz)
    if (segLen < 1e-6) {
      running += segLen
      continue
    }
    // Lane reference point: forward lanes start at `a`, backward lanes
    // start at `b` (the lane runs end→start). Without this, a backward
    // lane at world position halfway through segment 0 would be projected
    // with the wrong reference, giving a wrong `along`.
    const refX = sign === 1 ? a.x : b.x
    const refZ = sign === 1 ? a.z : b.z
    // Perp = "right" of tangent (rotate -90°): (dz, -dx) / segLen.
    const perpX = dz / segLen
    const perpZ = -dx / segLen
    // Lane center offset is in WORLD space (not motion-relative).
    const laneStartX = refX + perpX * off
    const laneStartZ = refZ + perpZ * off
    // Tangent unit vector along this segment in lane-forward sense.
    const tanX = (dx / segLen) * sign
    const tanZ = (dz / segLen) * sign
    const deltaX = worldX - laneStartX
    const deltaZ = worldZ - laneStartZ
    const along = deltaX * tanX + deltaZ * tanZ
    if (along < 0 || along > segLen) {
      // Off the segment along-axis — count the perpendicular at the
      // closer endpoint so a point past a corner still gets the nearest
      // segment, not just the closest perpendicular.
      const endAlong = along < 0 ? 0 : segLen
      const px = laneStartX + tanX * endAlong
      const pz = laneStartZ + tanZ * endAlong
      const perpx = worldX - px
      const perpz = worldZ - pz
      const perpSq = perpx * perpx + perpz * perpz
      if (perpSq < bestPerpSq) {
        bestPerpSq = perpSq
        bestS = running + endAlong
      }
      running += segLen
      continue
    }
    // Perpendicular distance at the projected along-point.
    const px = laneStartX + tanX * along
    const pz = laneStartZ + tanZ * along
    const perpx = worldX - px
    const perpz = worldZ - pz
    const perpSq = perpx * perpx + perpz * perpz
    if (perpSq < bestPerpSq) {
      bestPerpSq = perpSq
      // `running` is the geometric (a→b) cumulative length of segments so far.
      // For forward lanes, the lane-forward sense matches geometric order, so
      // bestS = running + along. For backward lanes (sign=-1), the lane runs
      // b→a, so the lane-forward position within the segment is (segLen - along).
      const sInSegment = sign === 1 ? along : segLen - along
      bestS = running + sInSegment
    }
    running += segLen
  }
  return Math.max(0, Math.min(len, bestS))
}
