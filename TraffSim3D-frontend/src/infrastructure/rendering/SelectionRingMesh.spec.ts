// src/infrastructure/rendering/SelectionRingMesh.spec.ts
//
// The selection ring is a fixed-radius annulus drawn on the ground plane.
// Its size, orientation and initial hidden state are the whole contract.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createSelectionRing } from './SelectionRingMesh';

describe('createSelectionRing', () => {
  it('is a 1.2 -> 1.6 ring: 0.4u wide annulus with 32 theta segments', () => {
    const geom = createSelectionRing().geometry as THREE.RingGeometry;
    expect(geom.type).toBe('RingGeometry');
    const p = geom.parameters as {
      innerRadius: number; outerRadius: number; thetaSegments: number; phiSegments: number;
    };
    expect(p.innerRadius).toBe(1.2);
    expect(p.outerRadius).toBe(1.6);
    expect(p.outerRadius - p.innerRadius).toBeCloseTo(0.4, 12);
    expect(p.thetaSegments).toBe(32);
    expect(p.phiSegments).toBe(1);
  });

  it('66 vertices = (thetaSegments + 1) * 2 rings', () => {
    expect(createSelectionRing().geometry.attributes.position!.count).toBe(66);
  });

  it('lies flat at y = 0.05 — above the ground, below the road decal layer', () => {
    const mesh = createSelectionRing();
    expect(mesh.rotation.x).toBeCloseTo(-Math.PI / 2, 12);
    expect(mesh.position.y).toBeCloseTo(0.05, 12);
    expect(mesh.position.x).toBe(0);
    expect(mesh.position.z).toBe(0);
  });

  it('starts hidden so nothing is ringed before the first selection', () => {
    expect(createSelectionRing().visible).toBe(false);
  });

  it('is a translucent double-sided MeshBasicMaterial in yellow (0xfde047 / 0.85)', () => {
    const mat = createSelectionRing().material as THREE.MeshBasicMaterial;
    expect(mat.type).toBe('MeshBasicMaterial');
    expect(mat.color.getHex()).toBe(0xfde047);
    expect(mat.side).toBe(THREE.DoubleSide);
    expect(mat.transparent).toBe(true);
    expect(mat.opacity).toBeCloseTo(0.85, 12);
    // Basic (unlit) so the ring stays readable in shadow and under fog.
    expect(mat.isMeshBasicMaterial).toBe(true);
  });

  it('is a Mesh, not a Group — the renderer reparents the single ring', () => {
    const mesh = createSelectionRing();
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(mesh.children).toHaveLength(0);
  });
});
