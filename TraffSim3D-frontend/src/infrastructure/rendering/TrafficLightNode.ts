import * as THREE from 'three';
import type { TrafficLight } from '@domain/entities/TrafficLight';
import { LightPhase } from '@domain/value-objects/Phase';

export const PHASE_COLOR: Record<TrafficLight['phase'], number> = {
  [LightPhase.Red]: 0xef4444,
  [LightPhase.Yellow]: 0xfbbf24,
  [LightPhase.Green]: 0x22c55e,
};

export interface TrafficLightNode {
  /** Group anchored at the intersection position; the renderer repositions this per frame. */
  group: THREE.Group;
  /** The glowing bulb; the renderer sets color + emissive per frame from the current phase. */
  sphere: THREE.Mesh;
  /** Horizontal phase-countdown bar floating just above the sphere. */
  bar: THREE.Mesh;
  /** Cached material refs so the renderer can mutate color in place. */
  sphereMaterial: THREE.MeshStandardMaterial;
  barMaterial: THREE.MeshStandardMaterial;
}

/**
 * Build a traffic light as a Group: pole + bulb + phase countdown bar.
 * The bar's `scale.x` is updated each frame to reflect `phaseRemaining`
 * normalized against the current phase's full duration (see PHASE_DURATIONS).
 */
export const createTrafficLightNode = (light: TrafficLight): TrafficLightNode => {
  const group = new THREE.Group();
  group.position.set(light.position.x, 0, light.position.z);

  // Pole — thin cylinder anchored to the ground.
  const poleGeom = new THREE.CylinderGeometry(0.15, 0.15, 3, 8);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.8 });
  const pole = new THREE.Mesh(poleGeom, poleMat);
  pole.position.y = 1.5;
  group.add(pole);

  // Bulb — sphere at the top of the pole, glowing in the phase color.
  const sphereGeom = new THREE.SphereGeometry(0.6, 16, 16);
  const phaseColor = PHASE_COLOR[light.phase];
  const sphereMaterial = new THREE.MeshStandardMaterial({
    color: phaseColor,
    emissive: phaseColor,
    emissiveIntensity: 0.7,
  });
  const sphere = new THREE.Mesh(sphereGeom, sphereMaterial);
  sphere.position.y = 3;
  group.add(sphere);

  // Phase-countdown bar — flat box above the bulb. Its `scale.x` is the
  // visual countdown; the renderer rewrites it every frame.
  const barGeom = new THREE.BoxGeometry(1.5, 0.15, 0.15);
  const barMaterial = new THREE.MeshStandardMaterial({ color: phaseColor, emissive: phaseColor, emissiveIntensity: 0.4 });
  const bar = new THREE.Mesh(barGeom, barMaterial);
  bar.position.y = 3.7;
  group.add(bar);

  return { group, sphere, bar, sphereMaterial, barMaterial };
};
