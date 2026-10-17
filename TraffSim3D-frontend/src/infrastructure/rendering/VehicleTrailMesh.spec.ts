// src/infrastructure/rendering/VehicleTrailMesh.spec.ts
//
// A trail is a Float32Array ring buffer wrapped in a THREE.Line. The
// buffer/ref-sharing contract matters because the renderer mutates
// `positions` in place every frame and only flips `needsUpdate`.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createVehicleTrail } from './VehicleTrailMesh';
import { makeTestVehicle } from '@__fixtures__/testNetwork';
import { TRAIL_LENGTH } from '@shared/constants/simulation';

const V = makeTestVehicle({ position: { x: 12.5, y: 0.4, z: -7.25 }, color: '#3a86ff' });

describe('createVehicleTrail', () => {
  it('allocates TRAIL_LENGTH (60) samples = 180 floats', () => {
    const t = createVehicleTrail(V);
    expect(TRAIL_LENGTH).toBe(60);
    expect(t.positions).toBeInstanceOf(Float32Array);
    expect(t.positions).toHaveLength(180);
    expect(t.history).toHaveLength(60);
  });

  it('pre-fills the buffer with the vehicle position, lifted 0.1u', () => {
    const t = createVehicleTrail(V);
    for (let i = 0; i < TRAIL_LENGTH; i++) {
      expect(t.positions[i * 3 + 0]).toBeCloseTo(12.5, 6);
      expect(t.positions[i * 3 + 1]).toBeCloseTo(0.5, 6);
      expect(t.positions[i * 3 + 2]).toBeCloseTo(-7.25, 6);
    }
  });

  it('the last sample matches the first (the trail is invisible until it fills)', () => {
    const t = createVehicleTrail(V);
    expect(Array.from(t.positions.slice(177))).toEqual(
      [12.5, 0.5, -7.25].map((n) => Math.fround(n)),
    );
  });

  it('keeps the raw position (no +0.1 lift) in the domain-facing history', () => {
    const t = createVehicleTrail(V);
    expect(t.history[0]).toEqual({ x: 12.5, y: 0.4, z: -7.25 });
    expect(t.history[59]).toEqual({ x: 12.5, y: 0.4, z: -7.25 });
    // history holds copies, not a reference to the vehicle entity
    V.position.x = 999;
    expect(t.history[0]!.x).toBe(12.5);
  });

  it('shares one Float32Array between the handle and the BufferAttribute', () => {
    const t = createVehicleTrail(V);
    expect(t.attribute.array).toBe(t.positions);
    expect(t.line.geometry.attributes['position']).toBe(t.attribute);
    // The "view" is live: writing through the handle is visible in the attribute.
    t.positions[0] = 42;
    expect(t.attribute.getX(0)).toBe(42);
  });

  it('marks the attribute DynamicDrawUsage so per-frame rewrites are not re-uploaded as static', () => {
    expect(createVehicleTrail(V).attribute.usage).toBe(THREE.DynamicDrawUsage);
    expect(THREE.DynamicDrawUsage).toBe(35048);
  });

  it('disables frustum culling — a moving trail briefly leaves the bounding sphere', () => {
    expect(createVehicleTrail(V).line.frustumCulled).toBe(false);
  });

  it('tints the line with the vehicle colour at 0.85 opacity', () => {
    const mat = createVehicleTrail(V).line.material as THREE.LineBasicMaterial;
    expect(mat.type).toBe('LineBasicMaterial');
    expect(mat.color.getHexString()).toBe('3a86ff');
    expect(mat.transparent).toBe(true);
    expect(mat.opacity).toBeCloseTo(0.85, 12);
  });

  it('gives every vehicle its own buffers', () => {
    const a = createVehicleTrail(makeTestVehicle({ id: 'a', position: { x: 0, y: 0, z: 0 } }));
    const b = createVehicleTrail(makeTestVehicle({ id: 'b', position: { x: 0, y: 0, z: 0 } }));
    expect(a.positions).not.toBe(b.positions);
    expect(a.attribute).not.toBe(b.attribute);
    expect(a.line).not.toBe(b.line);
    expect(a.history).not.toBe(b.history);
  });
});
