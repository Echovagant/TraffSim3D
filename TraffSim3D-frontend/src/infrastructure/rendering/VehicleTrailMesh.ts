import * as THREE from 'three';
import type { Vehicle } from '@domain/entities/Vehicle';
import { TRAIL_LENGTH } from '@shared/constants/simulation';

export interface VehicleTrail {
  /** THREE.Line drawn at the vehicle's y level. Add to the vehicle group. */
  line: THREE.Line;
  /**
   * Ring buffer of the last N (x, y, z) world positions. The renderer mutates
   * this every frame and re-uploads to the line's BufferAttribute. Stored
   * on the renderer (not the domain entity) because the trail is a pure
   * render-time concern.
   */
  history: { x: number; y: number; z: number }[];
  /** Float32Array view into the BufferAttribute; mutate in place to avoid GC. */
  positions: Float32Array;
  /** Underlying BufferAttribute; set `needsUpdate = true` after writing `positions`. */
  attribute: THREE.BufferAttribute;
}

/**
 * Create a trail `THREE.Line` for one vehicle. The history is pre-filled
 * with the vehicle's current position N times, so the line is invisible
 * until enough frames have elapsed to extend it.
 */
export const createVehicleTrail = (vehicle: Vehicle): VehicleTrail => {
  const positions = new Float32Array(TRAIL_LENGTH * 3);
  for (let i = 0; i < TRAIL_LENGTH; i++) {
    positions[i * 3 + 0] = vehicle.position.x;
    positions[i * 3 + 1] = vehicle.position.y + 0.1;
    positions[i * 3 + 2] = vehicle.position.z;
  }
  const geom = new THREE.BufferGeometry();
  const attribute = new THREE.BufferAttribute(positions, 3);
  attribute.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('position', attribute);
  const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(vehicle.color), transparent: true, opacity: 0.85 });
  const line = new THREE.Line(geom, mat);
  line.frustumCulled = false;  // history may briefly extend off-frustum; cheaper than recalculating bounds every frame

  const history: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < TRAIL_LENGTH; i++) history.push({ x: vehicle.position.x, y: vehicle.position.y, z: vehicle.position.z });

  return { line, history, positions, attribute };
};
