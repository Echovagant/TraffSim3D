// src/application/services/laneFrameSync.ts
//
// World → lane-frame re-derivation. Inverse of lanePoint() —
// takes a Vehicle's current world position (set by Rapier) and
// finds the nearest (laneIndex, s) on the vehicle's road.
//
// See ADR-003 for the algorithm
// and edge cases. Naming: `findNearestLane` (006 §6 explicitly
// forbids the old name `worldToLaneS` to avoid colliding with
// the existing helper in domain/services/laneGeometry.ts).

import type { Vehicle } from '@domain/entities/Vehicle';
import type { RoadNetwork } from '@domain/entities/RoadNetwork';
import {
  laneOffset,
  lanePoint,
  laneForwardSign,
  roadForward,
  roadLength,
  roadRight,
  worldToLaneS,
} from '@domain/services/laneGeometry';

export interface NearestLane {
  laneIndex: number;
  s: number;
}

/** Perpendicular distance from `road` at `s` in `laneIndex` to
 *  world point (x, z), squared. */
const perpendicularDistSq = (
  road: import('@domain/entities/Road').Road,
  laneIndex: number,
  s: number,
  x: number,
  z: number,
): number => {
  const lp = lanePoint(road, laneIndex, s);
  const dx = x - lp.position.x;
  const dz = z - lp.position.z;
  return dx * dx + dz * dz;
};

/** Heading in radians, aligned with the lane forward direction at `s`. */
const laneForwardHeading = (
  road: import('@domain/entities/Road').Road,
  laneIndex: number,
  s: number,
): number => {
  const fwd = roadForward(road, s);
  const sign = laneForwardSign(laneIndex, road.laneCount);
  return Math.atan2(fwd.uz * sign, fwd.ux * sign);
};

const normalizeAngle = (a: number): number => {
  // Normalize to [-π, π].
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r < -Math.PI) r += 2 * Math.PI;
  return r;
};

const projectOntoLane = (
  road: import('@domain/entities/Road').Road,
  laneIndex: number,
  x: number,
  z: number,
): number => {
  // Plan 035: delegate to the polyline-aware `worldToLaneS` from
  // laneGeometry. This picks the segment closest to (x, z) and
  // projects onto that segment's tangent, returning the arc-length s.
  return worldToLaneS(road, laneIndex, x, z);
};

const PERPENDICULAR_LIMIT_SQ = 5.0 * 5.0;  // metres

/** Find the (laneIndex, s) on `v.roadId` nearest to `v.position`.
 *  Falls back to (v.laneIndex, v.s) if no lane is reachable. */
export const findNearestLane = (v: Vehicle, network: RoadNetwork): NearestLane => {
  const road = network.roads[v.roadId];
  if (!road) return { laneIndex: v.laneIndex, s: v.s };
  const len = roadLength(road);

  let bestLane = -1;
  let bestS = v.s;
  let bestDistSq = Number.POSITIVE_INFINITY;

  for (let laneIndex = 0; laneIndex < road.laneCount; laneIndex++) {
    // 1. heading 偏差预检: 反向 (|Δheading| > π/2) 跳过.
    //    Polyline-aware: use current s (when we know it) so the heading
    //    check uses the LOCAL tangent. For the first lane we don't know
    //    s yet, so we use the midpoint; once we find a candidate we
    //    refine.
    const initialLH = laneForwardHeading(road, laneIndex, len / 2);
    if (Math.abs(normalizeAngle(v.heading - initialLH)) > Math.PI / 2) continue;

    // 2. 沿车道 forward 投影 position → s. (polyline-aware via worldToLaneS)
    const s = projectOntoLane(road, laneIndex, v.position.x, v.position.z);
    if (s < 0 || s > len) continue;  // off-road

    // 3. 垂直距离 (perpendicular).
    const perpDistSq = perpendicularDistSq(road, laneIndex, s, v.position.x, v.position.z);
    if (perpDistSq > PERPENDICULAR_LIMIT_SQ) continue;  // 太远 — 飞出路了

    // 4. tiebreak: 最小 dist.
    if (perpDistSq < bestDistSq) {
      bestDistSq = perpDistSq;
      bestLane = laneIndex;
      bestS = Math.max(0, Math.min(len, s));
    }
  }

  if (bestLane === -1) return { laneIndex: v.laneIndex, s: v.s };  // fallback
  return { laneIndex: bestLane, s: bestS };
};

export interface NearestLaneOnNetwork {
  roadId: string;
  laneIndex: number;
  s: number;
}

/**
 * Find the (roadId, laneIndex, s) across the **entire** network nearest
 * to a world-space `position`. Used by the editor's drag-to-move
 * (`worldStore.moveVehicleTo`) to re-snap a dropped vehicle to the
 * closest lane, even if the user dropped it on a *different* road
 * than the vehicle was originally on.
 *
 * Scans every lane of every road. Returns `null` only if the network
 * is empty (no roads) — in practice the default scene has roads so
 * this is rare. Each candidate (road, laneIndex) is scored by
 * perpendicular distance squared, with a `PERPENDICULAR_LIMIT_SQ`
 * cap (5 m) to keep "out of scene" drops from snapping to a
 * far-away road.
 */
export const findNearestLaneOnNetwork = (
  network: RoadNetwork,
  position: { x: number; y: number; z: number },
): NearestLaneOnNetwork | null => {
  let bestRoadId: string | null = null;
  let bestLane = -1;
  let bestS = 0;
  let bestDistSq = Number.POSITIVE_INFINITY;

  for (const road of Object.values(network.roads)) {
    const len = roadLength(road);
    for (let laneIndex = 0; laneIndex < road.laneCount; laneIndex++) {
      // Plan 035: polyline-aware via worldToLaneS. Picks the segment
      // closest to (position.x, position.z) and projects onto that
      // segment's tangent.
      const s = worldToLaneS(road, laneIndex, position.x, position.z);
      if (s < 0 || s > len) continue;  // off-road
      // Perpendicular distance squared.
      const lp = lanePoint(road, laneIndex, s);
      const pdx = position.x - lp.position.x;
      const pdz = position.z - lp.position.z;
      const perpDistSq = pdx * pdx + pdz * pdz;
      if (perpDistSq > PERPENDICULAR_LIMIT_SQ) continue;
      if (perpDistSq < bestDistSq) {
        bestDistSq = perpDistSq;
        bestRoadId = road.id;
        bestLane = laneIndex;
        bestS = Math.max(0, Math.min(len, s));
      }
    }
  }

  if (bestRoadId === null || bestLane === -1) return null;
  return { roadId: bestRoadId, laneIndex: bestLane, s: bestS };
};
