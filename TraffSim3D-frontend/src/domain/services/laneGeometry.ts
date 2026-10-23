/**
 * Lane geometry helpers.
 *
 * Polyline-aware. `Road` may have `waypoints?: Position[]`
 * (length ≥ 2); lane geometry is derived from the polyline.
 * For 2-point roads (`waypoints` absent or length 2) the math
 * collapses to a straight segment and is mathematically equivalent
 * to the older straight-line formulas.
 *
 * Convention (right-hand traffic, like CN / US):
 *  - lane indices are 0..N-1
 *  - lane 0 is the *rightmost* lane going start→end (forward)
 *  - lane N/2-1 is the *leftmost* forward lane
 *  - lane N/2 is the *leftmost* backward lane (drives end→start)
 *  - lane N-1 is the *rightmost* backward lane
 *  - the yellow centerline is between lane N/2-1 and lane N/2
 */
import type { Intersection } from '@domain/entities/Intersection'
import type { Road } from '@domain/entities/Road'
import type { Position } from '@domain/value-objects/Position'
import { ROAD_LANE_WIDTH, STOP_LINE_DISTANCE } from '@shared/constants/simulation'

export interface UnitVec2 {
  ux: number
  uz: number
}

/** Return the polyline waypoints of `road`. If the road has no
 *  `waypoints` field, or only two points, return `[startNode, endNode]`.
 *  All downstream geometry helpers route through this so 2-point
 *  backward-compat is automatic. */
export const roadWaypoints = (road: Road): readonly Position[] => {
  if (road.waypoints && road.waypoints.length >= 2) return road.waypoints
  return [road.startNode, road.endNode]
}

/** Per-segment cumulative arc length `[segLen1, segLen1+segLen2, ...]`.
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
    // 3D segment length (Y matters for ramps; flat roads have Y = 0).
    const dy = (b.y ?? 0) - (a.y ?? 0)
    acc += Math.sqrt(dx * dx + dy * dy + dz * dz)
    cum.push(acc)
  }
  CUM_LENGTHS_CACHE.set(road, cum)
  return cum
}

/** Find the polyline segment that contains arc-length `s`, plus
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
  // Linear search through cum array (N segments, small). At the current scale
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

/** `radius` defaults to STOP_LINE_DISTANCE * 2 = 10 m for back-compat
 *  with the older callers (tick.ts used a hard-coded formula).
 *  When a per-intersection radius is known, callers should pass it explicitly.
 *
 *  When `intersection` is given, the box is centred on the **projected**
 *  position of that intersection on the road (see
 *  `projectIntersectionOnRoad`) instead of the road midpoint. Without it
 *  the historical midpoint assumption is used. */
export const intersectionSRange = (
  road: Road,
  radius: number = STOP_LINE_DISTANCE * 2,
  intersection?: Intersection | null,
): readonly [number, number] => {
  const len = roadLength(road)
  const centerS = intersection ? intersectionCenterS(road, intersection) : len / 2
  return [Math.max(0, centerS - radius), Math.min(len, centerS + radius)] as const
}

/** True if a vehicle at distance `s` along this road is inside the intersection box. */
export const inIntersectionBox = (
  road: Road,
  s: number,
  radius: number = STOP_LINE_DISTANCE * 2,
  intersection?: Intersection | null,
): boolean => {
  const [lo, hi] = intersectionSRange(road, radius, intersection)
  return s >= lo && s <= hi
}

// ---------------------------------------------------------------------------
// Intersection geometry
// ---------------------------------------------------------------------------

/**
 * How far (m) an intersection position may sit from a connected road's
 * centreline and still be trusted as "this intersection is on that road".
 *
 * A road that really carries the intersection touches it, so the
 * perpendicular distance is ~0. A distance beyond this threshold means
 * the intersection belongs to some other road (or the projection failed),
 * and the caller falls back to the road midpoint instead of inventing a
 * stop line in the wrong place.
 */
export const MAX_INTERSECTION_OFFSET_M = 30

export interface IntersectionProjection {
  /** Arc length of the intersection centre along the road polyline (from the start node). */
  s: number
  /** Perpendicular distance (m) from the intersection position to the road centreline. */
  distance: number
  /**
   * `true` when `s` comes from the projection, `false` when the
   * projection was rejected and the road midpoint was used instead.
   */
  projected: boolean
}

/**
 * Project a world position onto the road **centreline**.
 *
 * `worldToLaneS` projects onto a *lane* — the lane's own line, offset from
 * the centreline by `laneOffset(laneIndex)`. That is not the centreline:
 * for a 6-lane road the outer lanes sit 8.75 m off the centre. This
 * function therefore projects onto the polyline itself and returns both
 * the arc length `s` (in the same space as `roadLength` / `lanePoint`) and
 * the perpendicular distance, which the caller needs to decide whether
 * the projection is trustworthy at all.
 *
 * The perpendicular distance is measured in XZ; the arc length is the 3D
 * polyline length (so it matches `roadLength` / `lanePoint` on ramps).
 */
export const worldToCenterlineS = (
  road: Road,
  worldX: number,
  worldZ: number,
): { s: number; distance: number } => {
  const wps = roadWaypoints(road)
  const cum = roadPolylineLengths(road)
  if (cum.length === 0 || wps.length < 2) {
    return { s: 0, distance: Number.POSITIVE_INFINITY }
  }
  let bestS = 0
  let bestPerpSq = Number.POSITIVE_INFINITY
  for (let i = 0; i < wps.length - 1; i++) {
    const a = wps[i]!
    const b = wps[i + 1]!
    const dx = b.x - a.x
    const dz = b.z - a.z
    const segLen3d = cum[i]! - (i === 0 ? 0 : cum[i - 1]!)
    const flatLen = Math.sqrt(dx * dx + dz * dz)
    if (flatLen < 1e-6) continue
    // Parameter of the closest point on the segment, clamped to [0, 1].
    const t = Math.max(
      0,
      Math.min(1, ((worldX - a.x) * dx + (worldZ - a.z) * dz) / (flatLen * flatLen)),
    )
    const px = a.x + dx * t
    const pz = a.z + dz * t
    const perpX = worldX - px
    const perpZ = worldZ - pz
    const perpSq = perpX * perpX + perpZ * perpZ
    if (perpSq < bestPerpSq) {
      bestPerpSq = perpSq
      const segStart = i === 0 ? 0 : cum[i - 1]!
      bestS = segStart + t * segLen3d
    }
  }
  const len = roadLength(road)
  return { s: Math.max(0, Math.min(len, bestS)), distance: Math.sqrt(bestPerpSq) }
}

/**
 * Where an intersection sits on a road.
 *
 * The intersection's world position is projected onto the road's
 * centreline; the resulting arc length `s` is the single source of truth
 * for where the stop line and the intersection box are on that road.
 *
 * When the intersection is further than `MAX_INTERSECTION_OFFSET_M` from
 * the road, the projection is rejected and the **road midpoint** is used
 * instead (`projected: false`) — the historical assumption, kept as the
 * degradation path so a bad projection can never move a stop line to a
 * nonsense place.
 */
export const projectIntersectionOnRoad = (
  road: Road,
  intersection: Intersection,
): IntersectionProjection => {
  const len = roadLength(road)
  if (len < 1e-6) {
    return { s: 0, distance: Number.POSITIVE_INFINITY, projected: false }
  }
  const { s, distance } = worldToCenterlineS(road, intersection.position.x, intersection.position.z)
  if (!Number.isFinite(distance) || distance > MAX_INTERSECTION_OFFSET_M) {
    return { s: len / 2, distance, projected: false }
  }
  return { s, distance, projected: true }
}

/**
 * The arc length of an intersection's centre on `road`
 * (road midpoint when the projection is rejected).
 */
export const intersectionCenterS = (road: Road, intersection: Intersection): number =>
  projectIntersectionOnRoad(road, intersection).s

/**
 * The stop line of `intersection` on `road`, for the travel direction of
 * `laneIndex`.
 *
 * The stop line sits on the edge of the intersection box, **on the side
 * the vehicle comes from**:
 *
 * - a forward lane (`laneIndex < laneCount / 2`) travels towards a
 *   *larger* `s`, so it stops at `centerS - radius`;
 * - a backward lane travels towards a *smaller* `s`, so it stops at
 *   `centerS + radius`.
 *
 * Returns `null` when that stop line would fall outside the road — the
 * intersection is not on this approach (e.g. it sits at the road's start
 * node, so the forward lanes drive away from it and never stop there).
 */
export const stopLineSOnRoad = (
  road: Road,
  intersection: Intersection,
  laneIndex: number,
): number | null => {
  const len = roadLength(road)
  if (len < 1e-6) return null
  const radius = Math.max(0, intersection.intersectionRadius)
  const centerS = intersectionCenterS(road, intersection)
  const sign = laneForwardSign(laneIndex, road.laneCount)
  const stopS = sign === 1 ? centerS - radius : centerS + radius
  if (stopS < 0 || stopS > len) return null
  return stopS
}

/**
 * Every stop line on `road`, in arc length, derived from the same
 * projection the traffic logic uses.
 *
 * One line per approach of every connected intersection: the forward
 * approach (`laneIndex 0`) and the backward approach (the last lane).
 * Duplicates are removed — a road whose intersection sits at the road's
 * midpoint yields one line per direction, not two.
 */
export const roadStopLines = (
  road: Road,
  intersections: readonly Intersection[],
): readonly number[] => {
  const lines = new Set<number>()
  for (const intersection of intersections) {
    if (!intersection.connectedRoads.includes(road.id)) continue
    const forward = stopLineSOnRoad(road, intersection, 0)
    if (forward !== null) lines.add(forward)
    const backward = stopLineSOnRoad(road, intersection, road.laneCount - 1)
    if (backward !== null) lines.add(backward)
  }
  return [...lines].sort((a, b) => a - b)
}

/**
 * World position + heading for a vehicle in `laneIndex` at distance
 * `s` along the polyline. For 2-point roads the result matches the
 * the older straight-line formula exactly (regression-safe).
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
  // sits on the +laneOffset side (right of motion), preserving the older layout.
  const perpX = tanZ
  const perpZ = -tanX
  const off = laneOffset(laneIndex, road.laneCount)
  const sign = laneForwardSign(laneIndex, road.laneCount)
  // Lane offset is in WORLD space, not motion-relative. Lane 0 sits at
  // +off perpendicular to the centerline (geometric "right" of forward);
  // lane N-1 sits at -off. This matches the older formula and is what
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
