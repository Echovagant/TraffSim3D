import * as THREE from 'three';
import type { Road } from '@domain/entities/Road';
import { ROAD_LANE_WIDTH, STOP_LINE_DISTANCE } from '@shared/constants/simulation';
import { roadLength, laneOffset, roadForward, roadRight, laneForwardSign } from '@domain/services/laneGeometry';

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
 *
 * `arrowSize` controls the overall size of the arrow (in world
 * units). The arrow is a 6-point chevron: two shaft segments + a
 * V-shaped head, all in the xz plane.
 */
const buildArrow = (arrowSize: number): THREE.LineSegments => {
  const a = arrowSize;
  // Vertex pairs (x, z) in local frame. Local +z = arrow's forward.
  // Shaft: two parallel lines from y=-a to y=+a*0.6.
  // Head: V from y=+a*0.4 out to y=+a, then back to y=+a*0.4.
  const pts: Array<[number, number]> = [
    [-a * 0.5, -a * 1.0],
    [-a * 0.5,  a * 0.6],
    [-a * 0.5,  a * 0.6],
    [ a * 0.5,  a * 0.6],
    [-a * 0.7,  a * 0.4],
    [ 0,        a * 1.0],
    [ 0,        a * 1.0],
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
 * Build a Group of road markings: a solid yellow centerline (if the
 * road has an even number of lanes) plus a pair of white dashed lane
 * dividers between adjacent lanes. Stop lines mark where vehicles
 * must halt at the intersection.
 *
 * Road markings are drawn slightly above the road plane to avoid z-fighting
 * (RoadMesh sits at y=0.01, we sit at y=0.02).
 */
export const createRoadMarkings = (road: Road): THREE.Group => {
  const group = new THREE.Group();

  const length = roadLength(road);
  if (length < 1e-6) return group;  // degenerate, skip
  // Unit vector along the road, and a perpendicular unit vector in the xz plane.
  const f = roadForward(road);
  const r = roadRight(road);
  const midX = (road.startNode.x + road.endNode.x) / 2;
  const midZ = (road.startNode.z + road.endNode.z) / 2;

  const laneWidth = ROAD_LANE_WIDTH;

  // Centerline — only when there's an even number of lanes (so a true
  // center line exists between opposing directions).
  if (road.laneCount % 2 === 0) {
    const a = new THREE.Vector3(
      midX + f.ux * (-length / 2),
      0.02,
      midZ + f.uz * (-length / 2),
    );
    const b = new THREE.Vector3(
      midX + f.ux * (length / 2),
      0.02,
      midZ + f.uz * (length / 2),
    );
    const geom = new THREE.BufferGeometry().setFromPoints([a, b]);
    const mat = new THREE.LineBasicMaterial({ color: CENTERLINE_COLOR });
    group.add(new THREE.Line(geom, mat));
  }

  // Lane dividers — between each pair of adjacent lanes.
  // Lane index 0..N-1. Boundary between lane i and lane i+1 sits at
  // offset (i - (N-1)/2) * laneWidth, but easier to just enumerate the
  // boundary offsets that are not the centerline.
  const dividerOffsets: number[] = [];
  for (let i = 0; i < road.laneCount - 1; i++) {
    // Midpoint between lane i and lane i+1 in (laneIndex + 0.5) terms.
    // We want the offset from road center of the boundary line.
    const offset = laneOffset(i, road.laneCount) + laneWidth / 2;
    if (Math.abs(offset) > 1e-3) dividerOffsets.push(offset);
  }
  if (dividerOffsets.length === 0) return group;

  // Build all dashed segments into one BufferGeometry so we get a single
  // draw call for the entire road's lane dividers.
  const segLen = DASH + GAP;
  const dashCount = Math.max(0, Math.floor((length + GAP) / segLen));
  const totalVertices = dashCount * dividerOffsets.length * 2;  // 2 endpoints per segment
  const positions = new Float32Array(totalVertices * 3);
  let cursor = 0;
  for (const offset of dividerOffsets) {
    // Center of the dash line in the xz plane.
    const cx = midX + r.ux * offset;
    const cz = midZ + r.uz * offset;
    for (let i = 0; i < dashCount; i++) {
      const t0 = -length / 2 + i * segLen;
      const t1 = t0 + DASH;
      positions[cursor++] = cx + f.ux * t0;
      positions[cursor++] = 0.02;
      positions[cursor++] = cz + f.uz * t0;
      positions[cursor++] = cx + f.ux * t1;
      positions[cursor++] = 0.02;
      positions[cursor++] = cz + f.uz * t1;
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({ color: DIVIDER_COLOR });
  group.add(new THREE.LineSegments(geom, mat));

  // Stop lines: one at each end of the road, at the intersection. The
  // line spans the full road width and is drawn thicker than the
  // dashed lane dividers. It sits at `±length/2 - STOP_LINE_DISTANCE`
  // along the road, and runs perpendicular to it.
  for (const sign of [-1, 1]) {
    // Skip the stop line if it would sit past the road end.
    if (STOP_LINE_DISTANCE >= length / 2) continue;
    const along = sign * (length / 2 - STOP_LINE_DISTANCE);
    const cx = midX + f.ux * along;
    const cz = midZ + f.uz * along;
    const halfWidth = (road.laneCount * laneWidth) / 2;
    const a = new THREE.Vector3(
      cx + r.ux * (-halfWidth) + f.ux * 0,
      0.03,
      cz + r.uz * (-halfWidth) + f.uz * 0,
    );
    const b = new THREE.Vector3(
      cx + r.ux * halfWidth,
      0.03,
      cz + r.uz * halfWidth,
    );
    const lineGeom = new THREE.BufferGeometry().setFromPoints([a, b]);
    const lineMat = new THREE.LineBasicMaterial({ color: STOPLINE_COLOR });
    group.add(new THREE.Line(lineGeom, lineMat));
  }

  // Lane direction arrows: paint a small "↑" in each lane's center,
  // pointing in the lane's forward direction. We draw two arrows per
  // lane — one in each half of the road, far enough from the stop
  // line that they don't visually conflict. For roads with very
  // few lanes (≤2) we skip — the road is too narrow to fit readable
  // arrows without crowding the dashed dividers.
  if (road.laneCount >= 3) {
    const arrowSize = 0.55;
    // Position arrows at s = length * (0.20) and (0.80) — visible from
    // a top-down camera, but well clear of the intersection area.
    const arrowSlots = [length * 0.20, length * 0.80];
    for (let laneIndex = 0; laneIndex < road.laneCount; laneIndex++) {
      const sign = laneForwardSign(laneIndex, road.laneCount);
      const off = laneOffset(laneIndex, road.laneCount);
      for (const s of arrowSlots) {
        const arrow = buildArrow(arrowSize);
        // Center of this arrow in the xz plane.
        const cx = midX + f.ux * (s - length / 2) + r.ux * off;
        const cz = midZ + f.uz * (s - length / 2) + r.uz * off;
        arrow.position.set(cx, 0.025, cz);
        // The arrow's local +z is its "forward" direction. Align
        // that with the lane's forward: rotation.y = -yaw where
        // yaw = atan2(f.uz, f.ux). For backward lanes (sign=-1)
        // we add π so the arrow points in the lane's -fwd direction.
        const yaw = Math.atan2(f.uz, f.ux);
        arrow.rotation.y = -yaw + (sign === -1 ? Math.PI : 0);
        group.add(arrow);
      }
    }
  }

  return group;
};
