/**
 * Lane geometry helpers.
 *
 * The `Road` entity only stores `startNode`, `endNode`, and `laneCount`.
 * Everything else (which lane goes which direction, where a lane center
 * sits in world space, the road's length) is derived. Keeping the
 * derivation here means `tick`, the renderer, the spawner, and the
 * default scene all agree on the layout without each reinventing it.
 *
 * Convention (right-hand traffic, like CN / US):
 *  - lane indices are 0..N-1
 *  - lane 0 is the *rightmost* lane going start→end (forward)
 *  - lane N/2-1 is the *leftmost* forward lane
 *  - lane N/2 is the *leftmost* backward lane (drives end→start)
 *  - lane N-1 is the *rightmost* backward lane
 *  - the yellow centerline is between lane N/2-1 and lane N/2
 */
import type { Road } from '@domain/entities/Road';
import type { Position } from '@domain/value-objects/Position';
import { ROAD_LANE_WIDTH, STOP_LINE_DISTANCE } from '@shared/constants/simulation';

export const roadLength = (road: Road): number => {
  const dx = road.endNode.x - road.startNode.x;
  const dz = road.endNode.z - road.startNode.z;
  return Math.sqrt(dx * dx + dz * dz);
};

export interface UnitVec2 { ux: number; uz: number }

/** Unit vector from startNode to endNode. Returns zero vec for degenerate roads. */
export const roadForward = (road: Road): UnitVec2 => {
  const len = roadLength(road);
  if (len < 1e-6) return { ux: 0, uz: 0 };
  return { ux: (road.endNode.x - road.startNode.x) / len, uz: (road.endNode.z - road.startNode.z) / len };
};

/** Perpendicular unit vector, "right" of forward direction. (ux, uz) rotated -90°. */
export const roadRight = (road: Road): UnitVec2 => {
  const f = roadForward(road);
  return { ux: f.uz, uz: -f.ux };
};

/** Perpendicular distance from road centerline to the center of `laneIndex` (positive = right of forward). */
export const laneOffset = (laneIndex: number, laneCount: number): number => {
  // Lane 0  → +(laneCount/2 - 0.5) * laneWidth  (rightmost forward)
  // Lane N-1 → -(laneCount/2 - 0.5) * laneWidth (rightmost backward)
  return (laneCount / 2 - laneIndex - 0.5) * ROAD_LANE_WIDTH;
};

/** +1 for forward lanes (start→end), -1 for backward lanes (end→start). */
export const laneForwardSign = (laneIndex: number, laneCount: number): 1 | -1 => {
  return laneIndex < laneCount / 2 ? 1 : -1;
};

export interface LanePoint {
  position: Position;
  /** Heading in radians, aligned with the lane's forward direction. */
  heading: number;
}

/** The `s`-range of the intersection box on `road` — the segment of
 * the road between the two stop lines (one `STOP_LINE_DISTANCE` on
 * either side of the midpoint). A vehicle inside this range is
 * *in the intersection*. Mirrors the formula in tick.ts. */
export const intersectionSRange = (road: Road): readonly [number, number] => {
  const len = roadLength(road);
  return [len / 2 - STOP_LINE_DISTANCE, len / 2 + STOP_LINE_DISTANCE] as const;
};

/** True if a vehicle at distance `s` along this road is inside the intersection box. */
export const inIntersectionBox = (road: Road, s: number): boolean => {
  const [lo, hi] = intersectionSRange(road);
  return s >= lo && s <= hi;
};

/**
 * World position + heading for a vehicle in `laneIndex` at distance
 * `s` from the lane's start (which is `startNode` for forward lanes
 * and `endNode` for backward lanes).
 */
export const lanePoint = (road: Road, laneIndex: number, s: number): LanePoint => {
  const len = roadLength(road);
  const fwd = roadForward(road);
  const rgt = roadRight(road);
  const off = laneOffset(laneIndex, road.laneCount);
  const sign = laneForwardSign(laneIndex, road.laneCount);
  // s is clamped so a vehicle never goes past the intersection
  // center (that's the boundary between two adjacent intersections);
  // the simulation wraps the value separately.
  const sClamped = Math.max(0, Math.min(len, s));
  // For backward lanes, laneStart = endNode, and "lane forward" runs
  // end→start, i.e. in the −fwd direction. So a positive `s` along
  // the lane corresponds to a *negative* displacement along the
  // road's forward axis — multiply by `sign` to get it right for
  // both directions in one expression.
  const laneStartX = sign === 1 ? road.startNode.x : road.endNode.x;
  const laneStartZ = sign === 1 ? road.startNode.z : road.endNode.z;
  const heading = Math.atan2(fwd.uz * sign, fwd.ux * sign);
  return {
    position: {
      x: laneStartX + fwd.ux * sClamped * sign + rgt.ux * off,
      y: 0,
      z: laneStartZ + fwd.uz * sClamped * sign + rgt.uz * off,
    },
    heading,
  };
};

/**
 * Project a world position onto the (road, laneIndex) parameter `s`.
 * Used when migrating an old-style position into the new lane model,
 * and as a sanity check by the spawner.
 */
export const worldToLaneS = (
  road: Road,
  laneIndex: number,
  worldX: number,
  worldZ: number,
): number => {
  const len = roadLength(road);
  const fwd = roadForward(road);
  const rgt = roadRight(road);
  const off = laneOffset(laneIndex, road.laneCount);
  const sign = laneForwardSign(laneIndex, road.laneCount);
  const laneStartX = sign === 1 ? road.startNode.x : road.endNode.x;
  const laneStartZ = sign === 1 ? road.startNode.z : road.endNode.z;
  // Decompose world pos into lane-frame: take the forward-component,
  // weighted by `sign` so backward lanes correctly invert the sign.
  const deltaX = worldX - laneStartX - rgt.ux * off;
  const deltaZ = worldZ - laneStartZ - rgt.uz * off;
  const along = deltaX * fwd.ux * sign + deltaZ * fwd.uz * sign;
  return Math.max(0, Math.min(len, along));
};
