import * as THREE from 'three';
import type { TrafficLight } from '@domain/entities/TrafficLight';
import { LightPhase } from '@domain/value-objects/Phase';

const PHASE_COLOR: Record<TrafficLight['phase'], number> = {
  [LightPhase.Red]: 0xef4444,
  [LightPhase.Yellow]: 0xfbbf24,
  [LightPhase.Green]: 0x22c55e,
};

export const createTrafficLightMesh = (light: TrafficLight): THREE.Mesh => {
  const geom = new THREE.SphereGeometry(0.6, 16, 16);
  const mat = new THREE.MeshStandardMaterial({
    color: PHASE_COLOR[light.phase],
    emissive: PHASE_COLOR[light.phase],
    emissiveIntensity: 0.7,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(light.position.x, 3, light.position.z);
  return mesh;
};
