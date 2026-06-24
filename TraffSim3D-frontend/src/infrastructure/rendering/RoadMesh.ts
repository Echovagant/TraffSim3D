import * as THREE from 'three';
import type { Road } from '@domain/entities/Road';
import { ROAD_LANE_WIDTH } from '@shared/constants/simulation';
import { roadWaypoints } from '@domain/services/laneGeometry';

/**
 * Plan 035: build a road as a triangle strip extruded along the polyline
 * waypoints. For 2-point roads the math collapses to a single quad
 * (4 vertices, 6 indices), matching the pre-035 PlaneGeometry shape.
 *
 * Y component of waypoints is honoured so 036 ramps work without
 * further changes; for 035 roads y=0 throughout.
 */
export const createRoadMesh = (road: Road): THREE.Mesh => {
  const waypoints = roadWaypoints(road);
  const halfWidth = (ROAD_LANE_WIDTH * road.laneCount) / 2;
  const yOffset = 0.01;

  // Per-vertex local perpendicular. Interior vertices average the
  // incoming and outgoing segment tangent so the strip stays
  // continuous at corners; boundary vertices use the single
  // available tangent.
  const tangentsX: number[] = [];
  const tangentsZ: number[] = [];
  for (let i = 0; i < waypoints.length; i++) {
    let tx = 0;
    let tz = 0;
    if (i > 0) {
      const a = waypoints[i - 1]!;
      const b = waypoints[i]!;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 1e-6) { tx += dx / len; tz += dz / len; }
    }
    if (i < waypoints.length - 1) {
      const a = waypoints[i]!;
      const b = waypoints[i + 1]!;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 1e-6) { tx += dx / len; tz += dz / len; }
    }
    const tlen = Math.sqrt(tx * tx + tz * tz);
    if (tlen > 1e-6) {
      tangentsX.push(tx / tlen);
      tangentsZ.push(tz / tlen);
    } else {
      tangentsX.push(1);
      tangentsZ.push(0);
    }
  }

  // Build 2*N vertices: per waypoint, a +perp (right) and -perp (left).
  // Perpendicular = right of forward = (uz, -ux).
  const positions = new Float32Array(waypoints.length * 2 * 3);
  let cursor = 0;
  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i]!;
    const tx = tangentsX[i]!;
    const tz = tangentsZ[i]!;
    const rx = tz;
    const rz = -tx;
    // Right edge (+perp).
    positions[cursor++] = wp.x + rx * halfWidth;
    positions[cursor++] = (wp.y ?? 0) + yOffset;
    positions[cursor++] = wp.z + rz * halfWidth;
    // Left edge (-perp).
    positions[cursor++] = wp.x - rx * halfWidth;
    positions[cursor++] = (wp.y ?? 0) + yOffset;
    positions[cursor++] = wp.z - rz * halfWidth;
  }

  // Index buffer: 2 triangles per segment between waypoints i and i+1.
  // Vertex layout: vertex 2i = right, vertex 2i+1 = left.
  // Triangles for segment (i, i+1):
  //   (2i, 2i+1, 2(i+1))      — CCW from above (right → left → next right)
  //   (2i+1, 2(i+1)+1, 2(i+1)) — CCW (left → next left → next right)
  const indices: number[] = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = 2 * i;
    const b = 2 * i + 1;
    const c = 2 * (i + 1);
    const d = 2 * (i + 1) + 1;
    indices.push(a, b, c, b, d, c);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.95 });
  return new THREE.Mesh(geom, mat);
};