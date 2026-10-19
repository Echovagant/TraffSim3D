// src/infrastructure/rendering/TrafficLightNode.behavior.spec.ts
//
// The sibling TrafficLightNode.spec.ts pins the two lookup tables; this
// file covers the node factory and the per-frame update — the geometry
// layout, the blink modulation and the phase-countdown bar.
//
// (Separate file rather than an edit of the existing spec so that file
// stays untouched.)

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createTrafficLightNode, updateTrafficLightNode, PHASE_COLOR, PHASE_EMISSIVE_INTENSITY } from './TrafficLightNode';
import { makeTestLight } from '@__fixtures__/testNetwork';
import { LightPhase } from '@domain/value-objects/Phase';
import { PHASE_DURATIONS } from '@shared/constants/simulation';

const pos = (o: THREE.Object3D) => ({ x: o.position.x, y: o.position.y, z: o.position.z });

describe('createTrafficLightNode', () => {
  const light = makeTestLight({ id: 'tl-1', position: { x: 7, y: 0, z: -3 } });
  const node = createTrafficLightNode(light);

  it('anchors the group at the light world position', () => {
    expect(node.group.position.x).toBe(7);
    expect(node.group.position.y).toBe(0);
    expect(node.group.position.z).toBe(-3);
  });

  it('builds pole + bulb + countdown bar, in that child order', () => {
    expect(node.group.children).toHaveLength(3);
    expect(node.group.children[1]).toBe(node.sphere);
    expect(node.group.children[2]).toBe(node.bar);
    const pole = node.group.children[0] as THREE.Mesh;
    const params = (pole.geometry as THREE.CylinderGeometry).parameters;
    expect(pole.geometry.type).toBe('CylinderGeometry');
    expect(params.radiusTop).toBeCloseTo(0.15, 6);
    expect(params.radiusBottom).toBeCloseTo(0.15, 6);
    expect(params.height).toBe(3);
    expect(params.radialSegments).toBe(8);
    expect(pole.position.y).toBe(1.5);
    expect((pole.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x475569);
  });

  it('hangs a 0.6r sphere at y = 3 and a 1.5-wide bar at y = 3.7', () => {
    const sph = (node.sphere.geometry as THREE.SphereGeometry).parameters;
    expect(sph.radius).toBe(0.6);
    expect(sph.widthSegments).toBe(16);
    expect(sph.heightSegments).toBe(16);
    expect(node.sphere.position.y).toBe(3);
    expect((node.bar.geometry as THREE.BoxGeometry).parameters).toMatchObject({
      width: 1.5,
      height: 0.15,
      depth: 0.15,
    });
    expect(node.bar.position.y).toBe(3.7);
  });

  it('paints bulb + bar with the initial phase colour and emissive', () => {
    expect(node.sphereMaterial.color.getHex()).toBe(PHASE_COLOR[LightPhase.Green]);
    expect(node.sphereMaterial.emissive.getHex()).toBe(PHASE_COLOR[LightPhase.Green]);
    expect(node.sphereMaterial.emissiveIntensity).toBe(0.7);
    expect(node.barMaterial.color.getHex()).toBe(PHASE_COLOR[LightPhase.Green]);
    // The bar runs at 60% of the bulb's emissive so the bulb dominates.
    expect(node.barMaterial.emissiveIntensity).toBeCloseTo(0.42, 12);
  });

  it('a Dark light starts unlit', () => {
    const dark = createTrafficLightNode(makeTestLight({ phase: LightPhase.Dark }));
    expect(dark.sphereMaterial.color.getHex()).toBe(0x1a1a1a);
    expect(dark.sphereMaterial.emissiveIntensity).toBe(0);
    expect(dark.barMaterial.emissiveIntensity).toBe(0);
  });

  it('returns the live materials, not copies (the update mutates them in place)', () => {
    expect(node.sphere.material).toBe(node.sphereMaterial);
    expect(node.bar.material).toBe(node.barMaterial);
  });
});

describe('updateTrafficLightNode — phase colour', () => {
  it('switches the bulb to the new phase colour and emissive', () => {
    const node = createTrafficLightNode(makeTestLight({ phase: LightPhase.Green }));
    updateTrafficLightNode(node, makeTestLight({ phase: LightPhase.Red }), 0);
    expect(node.sphereMaterial.color.getHex()).toBe(0xef4444);
    expect(node.sphereMaterial.emissive.getHex()).toBe(0xef4444);
    expect(node.sphereMaterial.emissiveIntensity).toBe(0.7);
    expect(node.barMaterial.color.getHex()).toBe(0xef4444);
    expect(node.barMaterial.emissiveIntensity).toBeCloseTo(0.42, 12);
  });

  it('keeps Dark unlit whatever the sim clock says', () => {
    const node = createTrafficLightNode(makeTestLight({ phase: LightPhase.Green }));
    updateTrafficLightNode(node, makeTestLight({ phase: LightPhase.Dark, phaseRemaining: 10 }), 0.25);
    expect(node.sphereMaterial.emissiveIntensity).toBe(0);
  });
});

describe('updateTrafficLightNode — blink modulation', () => {
  it('FlashingYellow blinks at 1 Hz (on for 0.5 s, off for 0.5 s)', () => {
    const node = createTrafficLightNode(makeTestLight());
    const fy = makeTestLight({ phase: LightPhase.FlashingYellow, phaseRemaining: 0.5 });
    updateTrafficLightNode(node, fy, 0.0);
    expect(node.sphereMaterial.emissiveIntensity).toBe(0.5); // on
    updateTrafficLightNode(node, fy, 0.49);
    expect(node.sphereMaterial.emissiveIntensity).toBe(0.5); // still on
    updateTrafficLightNode(node, fy, 0.5);
    expect(node.sphereMaterial.emissiveIntensity).toBe(0); // off
    updateTrafficLightNode(node, fy, 0.75);
    expect(node.sphereMaterial.emissiveIntensity).toBe(0);
    // 1.49 % 1 = 0.49 -> back on; 1.5 % 1 = 0.5 exactly -> off again (the
    // on-window is the half-open [n, n+0.5)).
    updateTrafficLightNode(node, fy, 1.49);
    expect(node.sphereMaterial.emissiveIntensity).toBe(0.5);
    updateTrafficLightNode(node, fy, 1.5);
    expect(node.sphereMaterial.emissiveIntensity).toBe(0);
    updateTrafficLightNode(node, fy, 2.0);
    expect(node.sphereMaterial.emissiveIntensity).toBe(0.5); // second cycle
  });

  it('FlashingRed blinks at 0.5 Hz (on for 1 s, off for 1 s)', () => {
    const node = createTrafficLightNode(makeTestLight());
    const fr = makeTestLight({ phase: LightPhase.FlashingRed, phaseRemaining: 1 });
    updateTrafficLightNode(node, fr, 0.9);
    expect(node.sphereMaterial.emissiveIntensity).toBe(0.5);
    updateTrafficLightNode(node, fr, 1.0);
    expect(node.sphereMaterial.emissiveIntensity).toBe(0);
    updateTrafficLightNode(node, fr, 2.0);
    expect(node.sphereMaterial.emissiveIntensity).toBe(0.5);
  });

  it('the bar mirrors the bulb blink at 60% intensity', () => {
    const node = createTrafficLightNode(makeTestLight());
    updateTrafficLightNode(node, makeTestLight({ phase: LightPhase.FlashingYellow }), 0.2);
    expect(node.barMaterial.emissiveIntensity).toBeCloseTo(0.3, 12);
    updateTrafficLightNode(node, makeTestLight({ phase: LightPhase.FlashingYellow }), 0.8);
    expect(node.barMaterial.emissiveIntensity).toBe(0);
  });

  it('a steady phase ignores simTime entirely', () => {
    const node = createTrafficLightNode(makeTestLight({ phase: LightPhase.Red }));
    for (const t of [0, 0.5, 1, 1.9, 100]) {
      updateTrafficLightNode(node, makeTestLight({ phase: LightPhase.Red }), t);
      expect(node.sphereMaterial.emissiveIntensity).toBe(0.7);
    }
  });
});

describe('updateTrafficLightNode — phase countdown bar', () => {
  it('scales the bar to phaseRemaining / phaseTotal', () => {
    const node = createTrafficLightNode(makeTestLight());
    expect(PHASE_DURATIONS.green).toBe(30);
    updateTrafficLightNode(node, makeTestLight({ phase: LightPhase.Green, phaseRemaining: 30 }), 0);
    expect(node.bar.scale.x).toBeCloseTo(1, 12);
    updateTrafficLightNode(node, makeTestLight({ phase: LightPhase.Green, phaseRemaining: 15 }), 0);
    expect(node.bar.scale.x).toBeCloseTo(0.5, 12);
  });

  it('never collapses below 0.02 so a fresh phase is still visible', () => {
    const node = createTrafficLightNode(makeTestLight());
    updateTrafficLightNode(node, makeTestLight({ phase: LightPhase.Green, phaseRemaining: 0 }), 0);
    expect(node.bar.scale.x).toBeCloseTo(0.02, 12);
    updateTrafficLightNode(node, makeTestLight({ phase: LightPhase.Green, phaseRemaining: -5 }), 0);
    expect(node.bar.scale.x).toBeCloseTo(0.02, 12);
  });

  it('clamps an over-long remaining time to full width', () => {
    const node = createTrafficLightNode(makeTestLight());
    updateTrafficLightNode(node, makeTestLight({ phase: LightPhase.Green, phaseRemaining: 999 }), 0);
    expect(node.bar.scale.x).toBe(1);
  });

  it('uses the 3 s yellow duration, not the 30 s green one', () => {
    const node = createTrafficLightNode(makeTestLight());
    expect(PHASE_DURATIONS.yellow).toBe(3);
    updateTrafficLightNode(node, makeTestLight({ phase: LightPhase.Yellow, phaseRemaining: 1.5 }), 0);
    expect(node.bar.scale.x).toBeCloseTo(0.5, 12);
    updateTrafficLightNode(node, makeTestLight({ phase: LightPhase.Yellow, phaseRemaining: 9 }), 0);
    expect(node.bar.scale.x).toBe(1);
  });

  it('the left-arrow phases reuse the base green / yellow durations', () => {
    const node = createTrafficLightNode(makeTestLight());
    updateTrafficLightNode(node, makeTestLight({ phase: LightPhase.GreenLeft, phaseRemaining: 10 }), 0);
    expect(node.bar.scale.x).toBeCloseTo(10 / 30, 12);
    updateTrafficLightNode(node, makeTestLight({ phase: LightPhase.YellowLeft, phaseRemaining: 1 }), 0);
    expect(node.bar.scale.x).toBeCloseTo(1 / 3, 12);
  });

  it('AllRed and the flashing phases fall back to the 30 s red duration', () => {
    const node = createTrafficLightNode(makeTestLight());
    expect(PHASE_DURATIONS.red).toBe(30);
    for (const phase of [LightPhase.AllRed, LightPhase.RedLeft, LightPhase.FlashingRed]) {
      updateTrafficLightNode(node, makeTestLight({ phase, phaseRemaining: 6 }), 0);
      expect(node.bar.scale.x).toBeCloseTo(0.2, 12);
    }
  });

  it('a Dark phase still renders the countdown bar', () => {
    const node = createTrafficLightNode(makeTestLight());
    updateTrafficLightNode(node, makeTestLight({ phase: LightPhase.Dark, phaseRemaining: 30 }), 0);
    expect(node.bar.scale.x).toBe(1);
    expect(node.barMaterial.emissiveIntensity).toBe(0);
  });

  it('does not move the bulb or the group', () => {
    const node = createTrafficLightNode(makeTestLight({ position: { x: 7, y: 0, z: -3 } }));
    const beforeGroup = pos(node.group);
    const beforeSphere = pos(node.sphere);
    updateTrafficLightNode(node, makeTestLight({ phase: LightPhase.Red, position: { x: 99, y: 9, z: 9 } }), 0);
    expect(pos(node.group)).toEqual(beforeGroup);
    expect(pos(node.sphere)).toEqual(beforeSphere);
  });

  it('every LightPhase has both a colour and an emissive intensity', () => {
    const phases = Object.values(LightPhase);
    expect(phases).toHaveLength(10);
    for (const phase of phases) {
      expect(PHASE_COLOR[phase]).toBeTypeOf('number');
      expect(PHASE_EMISSIVE_INTENSITY[phase]).toBeTypeOf('number');
      // Only Dark is unlit; every other phase glows.
      if (phase === LightPhase.Dark) expect(PHASE_EMISSIVE_INTENSITY[phase]).toBe(0);
      else expect(PHASE_EMISSIVE_INTENSITY[phase]).toBeGreaterThan(0);
    }
  });
});
