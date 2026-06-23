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
      // Project (position.x, position.z) onto (road, laneIndex) forward
      // axis → s. This is the lane's `projectOntoLane` formula exposed
      // locally so we don't re-export the file-private helper.
      const fwd = roadForward(road);
      const rgt = roadRight(road);
      const off = laneOffset(laneIndex, road.laneCount);
      const sign = laneForwardSign(laneIndex, road.laneCount);
      const laneStartX = (sign === 1 ? road.startNode.x : road.endNode.x) + rgt.ux * off;
      const laneStartZ = (sign === 1 ? road.startNode.z : road.endNode.z) + rgt.uz * off;
      const dx = position.x - laneStartX;
      const dz = position.z - laneStartZ;
      const s = dx * fwd.ux * sign + dz * fwd.uz * sign;
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
