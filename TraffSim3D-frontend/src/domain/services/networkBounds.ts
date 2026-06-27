// src/domain/services/networkBounds.ts
//
// Plan 053: compute the XZ bounding box of a RoadNetwork.
//
// Used by the camera fit logic to position the camera so the entire
// network is visible after OSM import. Pure domain (no Three.js) so
// the same bbox can be reused for analytics / minimap rendering.
//
// XZ-plane only (Y is irrelevant for top-down / orbit camera fit);
// the renderer can add its own vertical padding.

import type { RoadNetwork } from '@domain/entities/RoadNetwork';

export interface NetworkBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  centerX: number;
  centerZ: number;
  /** Diagonal length in XZ meters — the "size" of the network. */
  diagonal: number;
  /** Number of roads + intersections visited (sanity check). */
  roadCount: number;
  intersectionCount: number;
}

const EMPTY_BOUNDS: NetworkBounds = {
  minX: 0, maxX: 0, minZ: 0, maxZ: 0,
  centerX: 0, centerZ: 0, diagonal: 0,
  roadCount: 0, intersectionCount: 0,
};

export const computeNetworkBounds = (network: RoadNetwork): NetworkBounds => {
  const roads = Object.values(network.roads);
  const intersections = Object.values(network.intersections);

  if (roads.length === 0 && intersections.length === 0) {
    return EMPTY_BOUNDS;
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  const consider = (x: number, z: number): void => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };

  // Roads contribute their polyline vertices (startNode, endNode, plus
  // any intermediate waypoints). Missing waypoints fall back to
  // [startNode, endNode] — handled by the `??` fallback below.
  for (const r of roads) {
    consider(r.startNode.x, r.startNode.z);
    consider(r.endNode.x, r.endNode.z);
    if (r.waypoints && r.waypoints.length > 0) {
      for (const wp of r.waypoints) {
        consider(wp.x, wp.z);
      }
    }
  }

  // Intersections contribute their center position (roads only
  // touch them, so the center is already covered — but a T-junction
  // can have a center slightly off the road midpoints).
  for (const i of intersections) {
    consider(i.position.x, i.position.z);
  }

  // Degenerate case: all points coincide. Guard against NaN diagonal.
  if (!Number.isFinite(minX) || minX === maxX) {
    minX = -1; maxX = 1;
  }
  if (!Number.isFinite(minZ) || minZ === maxZ) {
    minZ = -1; maxZ = 1;
  }

  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const diagonal = Math.hypot(maxX - minX, maxZ - minZ);

  return {
    minX, maxX, minZ, maxZ,
    centerX, centerZ, diagonal,
    roadCount: roads.length,
    intersectionCount: intersections.length,
  };
};