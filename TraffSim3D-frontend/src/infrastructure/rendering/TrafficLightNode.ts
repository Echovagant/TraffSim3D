import * as THREE from 'three';
import type { TrafficLight } from '@domain/entities/TrafficLight';
import { LightPhase } from '@domain/value-objects/Phase';
import { PHASE_DURATIONS } from '@shared/constants/simulation';

// M2-B (plan 010): extended color map covers all 10 phase values.
// Per 007 §1.1 rendering enforcement — exhaustive (no `default: gray`).
// `Dark` = nearly black; renderer keeps emissiveIntensity low for it.
export const PHASE_COLOR: Record<TrafficLight['phase'], number> = {
  [LightPhase.Green]: 0x22c55e,          // (0.13, 0.77, 0.37)
  [LightPhase.Yellow]: 0xfbbf24,         // (0.98, 0.75, 0.14)
  [LightPhase.Red]: 0xef4444,            // (0.94, 0.27, 0.27)
  [LightPhase.GreenLeft]: 0x22c55e,      // same hue, different shape (left arrow — TODO M2-D)
  [LightPhase.YellowLeft]: 0xfbbf24,
  [LightPhase.RedLeft]: 0xef4444,
  [LightPhase.FlashingYellow]: 0xfbbf24, // 1Hz blink (see updateTrafficLightNode)
  [LightPhase.FlashingRed]: 0xef4444,    // 0.5Hz blink
  [LightPhase.AllRed]: 0xef4444,         // all 4 bulbs red
  [LightPhase.Dark]: 0x1a1a1a,           // near-black, no emissive
};

/** Per-phase emissive intensity baseline. Flashing phases modulated
 *  by `updateTrafficLightNode` based on `simTime % period`. */
export const PHASE_EMISSIVE_INTENSITY: Record<TrafficLight['phase'], number> = {
  [LightPhase.Green]: 0.7,
  [LightPhase.Yellow]: 0.7,
  [LightPhase.Red]: 0.7,
  [LightPhase.GreenLeft]: 0.7,
  [LightPhase.YellowLeft]: 0.7,
  [LightPhase.RedLeft]: 0.7,
  [LightPhase.FlashingYellow]: 0.5,
  [LightPhase.FlashingRed]: 0.5,
  [LightPhase.AllRed]: 0.7,
  [LightPhase.Dark]: 0.0,
};

export interface TrafficLightNode {
  group: THREE.Group;
  sphere: THREE.Mesh;
  bar: THREE.Mesh;
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
  group.position.set(light.position.x, light.position.y, light.position.z);

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
    emissiveIntensity: PHASE_EMISSIVE_INTENSITY[light.phase],
  });
  const sphere = new THREE.Mesh(sphereGeom, sphereMaterial);
  sphere.position.y = 3;
  group.add(sphere);

  // Phase-countdown bar — flat box above the bulb. Its `scale.x` is the
  // visual countdown; the renderer rewrites it every frame.
  const barGeom = new THREE.BoxGeometry(1.5, 0.15, 0.15);
  const barMaterial = new THREE.MeshStandardMaterial({
    color: phaseColor,
    emissive: phaseColor,
    emissiveIntensity: PHASE_EMISSIVE_INTENSITY[light.phase] * 0.6,
  });
  const bar = new THREE.Mesh(barGeom, barMaterial);
  bar.position.y = 3.7;
  group.add(bar);

  return { group, sphere, bar, sphereMaterial, barMaterial };
};

/**
 * Per-frame update for a traffic light node: change material color +
 * emissive based on current phase. Also handles flashing (1Hz / 0.5Hz)
 * and the phase-countdown bar scale (phaseRemaining / phaseTotal).
 *
 * Exposed as a separate function (vs inlined in SceneBuilder) so the
 * SceneBuilder doesn't import THREE types just to read these fields —
 * the rendering side stays decoupled from the domain.
 */
export const updateTrafficLightNode = (
  node: TrafficLightNode,
  light: TrafficLight,
  simTime: number,
): void => {
  let phase = light.phase;
  let visible = true;
  if (phase === LightPhase.FlashingYellow) {
    // 1Hz blink — on for 0.5s, off for 0.5s.
    const t = simTime % 1.0;
    visible = t < 0.5;
  } else if (phase === LightPhase.FlashingRed) {
    // 0.5Hz blink — on for 1s, off for 1s.
    const t = simTime % 2.0;
    visible = t < 1.0;
  }
  const color = PHASE_COLOR[phase];
  const intensity = visible ? PHASE_EMISSIVE_INTENSITY[phase] : 0;
  node.sphereMaterial.color.setHex(color);
  node.sphereMaterial.emissive.setHex(color);
  node.sphereMaterial.emissiveIntensity = intensity;
  node.barMaterial.color.setHex(color);
  node.barMaterial.emissive.setHex(color);
  node.barMaterial.emissiveIntensity = intensity * 0.6;

  // Phase-countdown bar: width is the remaining time as a fraction of
  // the current phase's nominal duration. Falls back to red duration
  // for phases PHASE_DURATIONS doesn't list (e.g. GreenLeft) — fine
  // for M2-B; M2-D adds per-phase durations.
  const phaseTotal =
    phase === LightPhase.Green || phase === LightPhase.GreenLeft
      ? PHASE_DURATIONS.green
      : phase === LightPhase.Yellow || phase === LightPhase.YellowLeft
        ? PHASE_DURATIONS.yellow
        : PHASE_DURATIONS.red;
  // Clamp to a small positive value so the bar stays visible (not zero-width)
  // on a fresh phase.
  const ratio = Math.max(0.02, Math.min(1, light.phaseRemaining / phaseTotal));
  node.bar.scale.x = ratio;
};
