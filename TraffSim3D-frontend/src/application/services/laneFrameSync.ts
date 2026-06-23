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

/** Heading in radians, aligned with the lane forward direction. */
const laneForwardHeading = (
  road: import('@domain/entities/Road').Road,
  laneIndex: number,
): number => {
  const fwd = roadForward(road);
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
  const fwd = roadForward(road);
  const rgt = roadRight(road);
  const off = laneOffset(laneIndex, road.laneCount);
  const sign = laneForwardSign(laneIndex, road.laneCount);
  // Use any reference point on the lane — the lane start (s=0).
  const startX = (sign === 1 ? road.startNode.x : road.endNode.x) + rgt.ux * off;
  const startZ = (sign === 1 ? road.startNode.z : road.endNode.z) + rgt.uz * off;
  const dx = x - startX;
  const dz = z - startZ;
  return dx * fwd.ux * sign + dz * fwd.uz * sign;
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
    const lh = laneForwardHeading(road, laneIndex);
    if (Math.abs(normalizeAngle(v.heading - lh)) > Math.PI / 2) continue;

    // 2. 沿车道 forward 投影 position → s.
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
