// src/infrastructure/rendering/VehicleMesh.spec.ts
//
// createVehicleMesh returns a Group per vehicle type with a fixed child
// count, fixed box dimensions, and the lower body stashed in
// userData.pickable for the raycaster. All of that is assertable without
// a GPU.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createVehicleMesh, getVehicleBodyMesh, Y_BODY } from './VehicleMesh';
import { makeTestVehicle } from '@__fixtures__/testNetwork';

// `BoxGeometry.parameters` exists at runtime but is not declared on the
// `BufferGeometry` base type in three's typings, so narrow to BoxGeometry.
const boxParams = (m: THREE.Mesh) =>
  (m.geometry as THREE.BoxGeometry).parameters as { width: number; height: number; depth: number };
const mat = (m: THREE.Mesh) => m.material as THREE.MeshStandardMaterial;

describe('Y_BODY', () => {
  it('is 0.55 — the height the chassis bottom sits above the road plane', () => {
    expect(Y_BODY).toBe(0.55);
  });
});

describe('createVehicleMesh — car', () => {
  const v = makeTestVehicle({ type: 'car', color: '#3a86ff' });
  const g = createVehicleMesh(v);

  it('builds a Group of 6 meshes (body, cabin, 2 windshields, 2 side windows)', () => {
    expect(g).toBeInstanceOf(THREE.Group);
    expect(g.children).toHaveLength(6);
    expect(g.children.every((c) => c instanceof THREE.Mesh)).toBe(true);
  });

  it('the lower body is a 4.2 x 0.9 x 1.8 box sitting with its base at Y_BODY', () => {
    const body = g.children[0] as THREE.Mesh;
    expect(boxParams(body)).toMatchObject({ width: 4.2, height: 0.9, depth: 1.8 });
    expect(body.position.y).toBeCloseTo(Y_BODY + 0.45, 12);
    expect(body.position.y - boxParams(body).height / 2).toBeCloseTo(Y_BODY, 12);
  });

  it('paints the body + cabin in the vehicle colour and the glass dark slate', () => {
    const [body, cabin, wsFront, wsRear, sideL, sideR] = g.children as THREE.Mesh[];
    expect(mat(body!).color.getHexString()).toBe('3a86ff');
    expect(mat(cabin!).color.getHexString()).toBe('3a86ff');
    expect(mat(body!).roughness).toBe(0.6);
    expect(mat(body!).metalness).toBe(0.1);
    expect(mat(wsFront!).color.getHex()).toBe(0x1e293b);
    expect(mat(wsRear!).color.getHex()).toBe(0x1e293b);
    expect(mat(sideL!).color.getHex()).toBe(0x1e293b);
    expect(mat(sideR!).color.getHex()).toBe(0x1e293b);
  });

  it('mirrors the side windows on +/-0.82 and offsets the cabin rearward', () => {
    const [, cabin, , , sideL, sideR] = g.children as THREE.Mesh[];
    expect(sideL!.position.z).toBeCloseTo(0.82, 12);
    expect(sideR!.position.z).toBeCloseTo(-0.82, 12);
    expect(sideL!.position.x).toBeCloseTo(sideR!.position.x, 12);
    expect(cabin!.position.x).toBeCloseTo(-0.2, 12);
  });
});

describe('createVehicleMesh — truck', () => {
  const g = createVehicleMesh(makeTestVehicle({ type: 'truck', color: '#ff6b35' }));
  const [body, cab, cargo, ws] = g.children as THREE.Mesh[];

  it('builds 4 meshes with a longer 6.5 x 0.8 x 2.2 chassis', () => {
    expect(g.children).toHaveLength(4);
    expect(boxParams(body!)).toMatchObject({ width: 6.5, height: 0.8, depth: 2.2 });
    expect(body!.position.y).toBeCloseTo(Y_BODY + 0.4, 12);
  });

  it('puts the cab at the front (+x) and the taller cargo box behind it', () => {
    expect(boxParams(cab!)).toMatchObject({ width: 1.8, height: 1.4, depth: 2.0 });
    expect(boxParams(cargo!)).toMatchObject({ width: 4.0, height: 2.0, depth: 2.0 });
    expect(cab!.position.x).toBeGreaterThan(cargo!.position.x);
    expect(cargo!.position.x).toBeLessThan(0);
  });

  it('paints the cargo box near-white so the truck reads as commercial', () => {
    expect(mat(cargo!).color.getHex()).toBe(0xf5f5f4);
    expect(mat(body!).color.getHexString()).toBe('ff6b35');
    expect(mat(ws!).color.getHex()).toBe(0x1e293b);
  });
});

describe('createVehicleMesh — bus', () => {
  const g = createVehicleMesh(makeTestVehicle({ type: 'bus', color: '#2ec4b6' }));
  const [body, roof, winL, winR, ws] = g.children as THREE.Mesh[];

  it('builds 5 meshes with a 9.0 x 2.0 x 2.4 body', () => {
    expect(g.children).toHaveLength(5);
    expect(boxParams(body!)).toMatchObject({ width: 9.0, height: 2.0, depth: 2.4 });
    expect(body!.position.y).toBeCloseTo(Y_BODY + 1.0, 12);
  });

  it('has an inset roof sitting on top of the body', () => {
    expect(boxParams(roof!)).toMatchObject({ width: 8.6, height: 0.1, depth: 2.2 });
    expect(roof!.position.y).toBeCloseTo(Y_BODY + 2.05, 12);
    expect(mat(roof!).color.getHex()).toBe(0xe2e8f0);
  });

  it('runs the window band along both flanks and a tall windshield at +x', () => {
    expect(boxParams(winL!)).toMatchObject({ width: 7.6, height: 0.7, depth: 0.05 });
    expect(winL!.position.z).toBeCloseTo(1.22, 12);
    expect(winR!.position.z).toBeCloseTo(-1.22, 12);
    expect(winL!.material).toBe(winR!.material); // shared glass material
    expect(ws!.position.x).toBeCloseTo(4.5, 12);
    expect(ws!.material).toBe(winL!.material);
  });

  it('paints the bus body in the vehicle colour', () => {
    expect(mat(body!).color.getHexString()).toBe('2ec4b6');
  });
});

describe('getVehicleBodyMesh', () => {
  const vehicle = makeTestVehicle({ type: 'bus', color: '#2ec4b6' });

  it('returns the body stashed on userData.pickable', () => {
    const g = createVehicleMesh(vehicle);
    expect(g.userData['pickable']).toBe(g.children[0]);
    expect(getVehicleBodyMesh(g)).toBe(g.children[0]);
  });

  it('returns the same mesh for every vehicle type', () => {
    for (const type of ['car', 'truck', 'bus'] as const) {
      const g = createVehicleMesh(makeTestVehicle({ type }));
      expect(getVehicleBodyMesh(g)).toBe(g.children[0]);
      expect(getVehicleBodyMesh(g)).toBeInstanceOf(THREE.Mesh);
    }
  });

  it('falls back to the first child when userData.pickable is missing', () => {
    const g = createVehicleMesh(vehicle);
    delete g.userData['pickable'];
    expect(getVehicleBodyMesh(g)).toBe(g.children[0]);
  });

  it('falls back to the first child when userData.pickable is not a Mesh', () => {
    const g = createVehicleMesh(vehicle);
    g.userData['pickable'] = new THREE.Group();
    expect(getVehicleBodyMesh(g)).toBe(g.children[0]);
  });

  it('throws when the group has neither a pickable nor a Mesh first child', () => {
    expect(() => getVehicleBodyMesh(new THREE.Group())).toThrowError(
      'createVehicleMesh: group has no pickable body mesh',
    );
    const nested = new THREE.Group();
    nested.add(new THREE.Group());
    expect(() => getVehicleBodyMesh(nested)).toThrowError(
      'createVehicleMesh: group has no pickable body mesh',
    );
  });
});

describe('createVehicleMesh — instance isolation', () => {
  it('builds fresh geometry and materials per call (nothing is shared across vehicles)', () => {
    const a = createVehicleMesh(makeTestVehicle({ id: 'a', type: 'car' }));
    const b = createVehicleMesh(makeTestVehicle({ id: 'b', type: 'car' }));
    expect(a).not.toBe(b);
    expect(a.children[0]).not.toBe(b.children[0]);
    expect((a.children[0] as THREE.Mesh).geometry).not.toBe((b.children[0] as THREE.Mesh).geometry);
    // ...but within one group the two windshields DO share a geometry/material.
    const g = createVehicleMesh(makeTestVehicle({ type: 'car' }));
    const [, , wsF, wsR] = g.children as THREE.Mesh[];
    expect(wsF!.geometry).toBe(wsR!.geometry);
    expect(wsF!.material).toBe(wsR!.material);
  });
});
