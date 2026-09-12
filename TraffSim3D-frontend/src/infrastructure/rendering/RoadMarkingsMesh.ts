import * as THREE from 'three';
import type { Road } from '@domain/entities/Road';
import { ROAD_LANE_WIDTH, STOP_LINE_DISTANCE } from '@shared/constants/simulation';
import {
  laneOffset,
  laneForwardSign,
  roadForward,
  roadLength,
  roadPolylineLengths,
  roadRight,
  roadWaypoints,
  segmentAt,
} from '@domain/services/laneGeometry';

const CENTERLINE_COLOR = 0xfacc15;  // yellow
const DIVIDER_COLOR = 0xe2e8f0;    // near-white
const STOPLINE_COLOR = 0xffffff;   // bright white
const ARROW_COLOR = 0xffffff;      // white arrows, also painted on the road

/** Length of each dashed segment and gap, in world units. */
const DASH = 0.6;
const GAP = 0.6;

/**
 * Build a small "↑" arrow in a lane's center, pointing in the
 * road's *forward* direction (local +z). For backward lanes the
 * caller rotates the returned group by 180° around y.
 */
const buildArrow = (arrowSize: number): THREE.LineSegments => {
  const a = arrowSize;
  const pts: Array<[number, number]> = [
    [-a * 0.5, -a * 1.0],
    [-a * 0.5,  a * 0.6],
    [-a * 0.5,  a * 0.6],
    [ a * 0.5,  a * 0.6],
    [-a * 0.7,  a * 0.4],
    [0,         a * 1.0],
    [0,         a * 1.0],
    [ a * 0.7,  a * 0.4],
  ];
  const positions: number[] = [];
  for (const [x, z] of pts) {
    positions.push(x, 0, z);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({ color: ARROW_COLOR });
  return new THREE.LineSegments(geom, mat);
};

/**
 * Plan 035: polyline-aware road markings. Centerline follows the
 * polyline (N-1 segments). Dashed dividers distribute along the
 * polyline arc length, snapping to the local segment tangent at each
 * dash. Stop lines are perpendicular to the LOCAL tangent at the
 * intersection midpoints (one per road end). Arrows are placed at
 * `s = 0.2·len` and `0.8·len`, rotated to the local tangent.
 *
 * For 2-point roads (N=2), the result is mathematically the same as
 * the pre-035 single-segment road.
 */
export const createRoadMarkings = (road: Road): THREE.Group => {
  const group = new THREE.Group();
  const wps = roadWaypoints(road);
  const length = roadLength(road);
  if (length < 1e-6 || wps.length < 2) return group;

  const laneWidth = ROAD_LANE_WIDTH;
  const halfWidth = (road.laneCount * laneWidth) / 2;

  // Centerline: solid yellow line from waypoints[0] → waypoints[N-1].
  if (road.laneCount % 2 === 0) {
    const positions = new Float32Array(wps.length * 3);
    for (let i = 0; i < wps.length; i++) {
      positions[i * 3 + 0] = wps[i]!.x;
      positions[i * 3 + 1] = (wps[i]!.y ?? 0) + 0.02;
      positions[i * 3 + 2] = wps[i]!.z;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({ color: CENTERLINE_COLOR });
    group.add(new THREE.Line(geom, mat));
  }

  // Lane divider offsets (perpendicular distance from centerline).
  const dividerOffsets: number[] = [];
  for (let i = 0; i < road.laneCount - 1; i++) {
    const offset = laneOffset(i, road.laneCount) + laneWidth / 2;
    if (Math.abs(offset) > 1e-3) dividerOffsets.push(offset);
  }
  if (dividerOffsets.length === 0) return group;

  // Distribute dashes evenly along the polyline arc length.
  const segLen = DASH + GAP;
  const totalDashes = Math.max(0, Math.floor((length + GAP) / segLen));

  // Per-offset, walk the polyline and emit a dash at each `s`.
  const dashSegments: Array<{ offset: number; sStart: number; sEnd: number }> = [];
  for (const offset of dividerOffsets) {
    for (let i = 0; i < totalDashes; i++) {
      const sCenter = i * segLen;
      const sStart = sCenter;
      const sEnd = Math.min(length, sCenter + DASH);
      if (sEnd <= sStart) continue;
      dashSegments.push({ offset, sStart, sEnd });
    }
  }

  if (dashSegments.length > 0) {
    // Emit each dash as a line segment in world space.
    const positions = new Float32Array(dashSegments.length * 2 * 3);
    let cursor = 0;
    for (const d of dashSegments) {
      const pStart = pointAt(road, d.offset, d.sStart);
      const pEnd = pointAt(road, d.offset, d.sEnd);
      positions[cursor++] = pStart.x;
      positions[cursor++] = pStart.y + 0.02;
      positions[cursor++] = pStart.z;
      positions[cursor++] = pEnd.x;
      positions[cursor++] = pEnd.y + 0.02;
      positions[cursor++] = pEnd.z;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({ color: DIVIDER_COLOR });
    group.add(new THREE.LineSegments(geom, mat));
  }

  // Stop lines at the two ends of the road (intersection areas).
  for (const sign of [-1, 1]) {
    const along = sign * (length / 2 - STOP_LINE_DISTANCE);
    if (Math.abs(along) > length) continue;
    const sClamped = Math.max(0, Math.min(length, length / 2 + along));
    const fwd = roadForward(road, sClamped);
    const rgt = roadRight(road, sClamped);
    const cx = pointAt(road, 0, sClamped);
    const a = new THREE.Vector3(cx.x + rgt.ux * (-halfWidth), cx.y + 0.03, cx.z + rgt.uz * (-halfWidth));
    const b = new THREE.Vector3(cx.x + rgt.ux * halfWidth, cx.y + 0.03, cx.z + rgt.uz * halfWidth);
    const lineGeom = new THREE.BufferGeometry().setFromPoints([a, b]);
    const lineMat = new THREE.LineBasicMaterial({ color: STOPLINE_COLOR });
    group.add(new THREE.Line(lineGeom, lineMat));
  }

  // Lane direction arrows at s = 0.2·len and 0.8·len, per lane.
  if (road.laneCount >= 3) {
    const arrowSize = 0.55;
    const arrowSlots = [length * 0.20, length * 0.80];
    for (let laneIndex = 0; laneIndex < road.laneCount; laneIndex++) {
      const sign = laneForwardSign(laneIndex, road.laneCount);
      const off = laneOffset(laneIndex, road.laneCount);
      for (const s of arrowSlots) {
        const arrow = buildArrow(arrowSize);
        const p = pointAt(road, off, s);
        arrow.position.set(p.x, p.y + 0.025, p.z);
        const fwd = roadForward(road, s);
        const yaw = Math.atan2(fwd.uz, fwd.ux);
        arrow.rotation.y = -yaw + (sign === -1 ? Math.PI : 0);
        group.add(arrow);
      }
    }
  }

  return group;
};

/**
 * Helper: world position of a point at perpendicular offset from
 * centerline, at arc-length `s` along the polyline. Mirrors
 * `lanePoint()` but takes the perpendicular offset directly (not a
 * laneIndex) so markings can pick any offset (e.g. divider lines that
 * sit between lanes).
 */
const pointAt = (road: Road, perpOffset: number, s: number): { x: number; y: number; z: number } => {
  const wps = roadWaypoints(road);
  const sClamped = Math.max(0, Math.min(roadLength(road), s));
  const seg = segmentAt(road, sClamped);
  const a = wps[seg.segIdx]!;
  const b = wps[seg.segIdx + 1]!;
  const localT = seg.segLen < 1e-6 ? 0 : (sClamped - seg.segStartS) / seg.segLen;
  const baseX = a.x + (b.x - a.x) * localT;
  const baseZ = a.z + (b.z - a.z) * localT;
  // Right-perpendicular at this s.
  const fwd = roadForward(road, sClamped);
  const rx = fwd.uz;
  const rz = -fwd.ux;
  return {
    x: baseX + rx * perpOffset,
    y: (a.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * localT,
    z: baseZ + rz * perpOffset,
  };
};