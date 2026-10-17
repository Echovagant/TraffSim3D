// src/infrastructure/rendering/VehicleInstances.spec.ts
//
// Plan 062 replaces per-vehicle Groups with a pool of 3 InstancedMesh
// (one per type, 256 slots each). Everything interesting here is the
// slot bookkeeping: allocate / remove / update / pickByInstance /
// getPosition are all pure mappings over that pool, and the instance
// matrices are readable without a GPU.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import { createVehicleInstances, MAX_VEHICLES_PER_TYPE, type VehicleInstances } from './VehicleInstances';
import { makeTestVehicle } from '@__fixtures__/testNetwork';
import { Y_BODY } from './VehicleMesh';
import { TRAIL_LENGTH } from '@shared/constants/simulation';

const TYPES = ['car', 'truck', 'bus'] as const;

const matrixAt = (mesh: THREE.InstancedMesh, i: number): THREE.Matrix4 => {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(i, m);
  return m;
};

const decompose = (mesh: THREE.InstancedMesh, i: number) => {
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrixAt(mesh, i).decompose(pos, quat, scale);
  return { pos, quat, scale };
};

const colorAt = (mesh: THREE.InstancedMesh, i: number): THREE.Color => {
  const c = new THREE.Color();
  mesh.getColorAt(i, c);
  return c;
};

let pool: VehicleInstances;
beforeEach(() => {
  pool = createVehicleInstances();
});

describe('createVehicleInstances — pool construction', () => {
  it('caps each type at MAX_VEHICLES_PER_TYPE (256) slots', () => {
    expect(MAX_VEHICLES_PER_TYPE).toBe(256);
    for (const t of TYPES) {
      expect(pool.meshes[t]).toBeInstanceOf(THREE.InstancedMesh);
      expect(pool.meshes[t].instanceMatrix.count).toBe(256);
    }
  });

  it('names the meshes vehicles-<type> and starts them empty and unculled', () => {
    for (const t of TYPES) {
      expect(pool.meshes[t].name).toBe(`vehicles-${t}`);
      expect(pool.meshes[t].count).toBe(0);
      expect(pool.meshes[t].frustumCulled).toBe(false);
    }
  });

  it('sizes each instanced box to the type silhouette and offsets y by yCenter', () => {
    const expect3 = (t: typeof TYPES[number], w: number, h: number, d: number) => {
      expect(pool.meshes[t].geometry.parameters).toMatchObject({ width: w, height: h, depth: d });
    };
    expect3('car', 4.2, 0.9, 1.8);
    expect3('truck', 6.5, 1.8, 2.2);
    expect3('bus', 9.0, 2.0, 2.4);
    expect(Y_BODY + 0.45).toBeCloseTo(1.0, 12);
  });

  it('uses one white lit material per type so instanceColor can tint each car', () => {
    const mat = pool.meshes.car.material as THREE.MeshStandardMaterial;
    expect(mat.color.getHex()).toBe(0xffffff);
    expect(mat.roughness).toBe(0.6);
    expect(mat.metalness).toBe(0.1);
    expect(pool.meshes.bus.material).not.toBe(pool.meshes.car.material);
  });

  it('pre-fills instanceColor with opaque white so an unwritten slot is not black', () => {
    const arr = pool.meshes.car.instanceColor!.array as Float32Array;
    expect(arr).toHaveLength(256 * 3);
    expect(arr.every((v) => v === 1)).toBe(true);
    expect(pool.meshes.car.instanceColor!.itemSize).toBe(3);
  });

  it('starts with no trails', () => {
    expect(pool.trails.size).toBe(0);
  });
});

describe('createVehicleInstances — allocate', () => {
  it('places the instance at position + yCenter and keeps unit scale', () => {
    pool.allocate(makeTestVehicle({ id: 'v-1', position: { x: 5, y: 0.3, z: -7 } }));
    const p = pool.getPosition('v-1')!;
    expect(p.x).toBeCloseTo(5, 10);
    expect(p.y).toBeCloseTo(0.3 + 1.0, 10); // car yCenter = Y_BODY + 0.45
    expect(p.z).toBeCloseTo(-7, 10);
    const { scale } = decompose(pool.meshes.car, 0);
    expect(scale.x).toBe(1);
    expect(scale.y).toBe(1);
    expect(scale.z).toBe(1);
  });

  it('uses a per-type yCenter (truck 1.45, bus 1.55)', () => {
    pool.allocate(makeTestVehicle({ id: 't', type: 'truck', position: { x: 0, y: 0, z: 0 } }));
    pool.allocate(makeTestVehicle({ id: 'b', type: 'bus', position: { x: 0, y: 0, z: 0 } }));
    expect(pool.getPosition('t')!.y).toBeCloseTo(Y_BODY + 0.9, 10);
    expect(pool.getPosition('b')!.y).toBeCloseTo(Y_BODY + 1.0, 10);
  });

  it('yaws the instance by -heading about Y', () => {
    pool.allocate(makeTestVehicle({ id: 'v-1', heading: Math.PI / 2 }));
    const { quat } = decompose(pool.meshes.car, 0);
    // euler.y = -PI/2  =>  quat = (0, sin(-PI/4), 0, cos(-PI/4))
    expect(quat.x).toBeCloseTo(0, 10);
    expect(quat.z).toBeCloseTo(0, 10);
    expect(quat.y).toBeCloseTo(-Math.SQRT1_2, 10);
    expect(quat.w).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it('hands out sequential slots per type and tracks the mesh count', () => {
    pool.allocate(makeTestVehicle({ id: 'a' }));
    pool.allocate(makeTestVehicle({ id: 'b' }));
    pool.allocate(makeTestVehicle({ id: 'c' }));
    expect(pool.meshes.car.count).toBe(3);
    expect(pool.pickByInstance(pool.meshes.car, 0)).toBe('a');
    expect(pool.pickByInstance(pool.meshes.car, 2)).toBe('c');
  });

  it('keeps per-type pools independent', () => {
    pool.allocate(makeTestVehicle({ id: 'c1', type: 'car' }));
    pool.allocate(makeTestVehicle({ id: 'b1', type: 'bus' }));
    expect(pool.meshes.car.count).toBe(1);
    expect(pool.meshes.bus.count).toBe(1);
    expect(pool.pickByInstance(pool.meshes.car, 0)).toBe('c1');
    expect(pool.pickByInstance(pool.meshes.bus, 0)).toBe('b1');
  });

  it('tints the instance with the vehicle colour', () => {
    pool.allocate(makeTestVehicle({ id: 'v-1', color: '#3a86ff' }));
    expect(colorAt(pool.meshes.car, 0).getHexString()).toBe('3a86ff');
  });

  it('creates a pre-filled trail alongside the slot', () => {
    pool.allocate(makeTestVehicle({ id: 'v-1', position: { x: 1, y: 0, z: 2 } }));
    const trail = pool.trails.get('v-1')!;
    expect(trail).toBeDefined();
    expect(trail.history).toHaveLength(TRAIL_LENGTH);
    expect(trail.history[59]).toEqual({ x: 1, y: 0, z: 2 });
  });

  it('is a silent no-op once the 256-slot pool for that type is exhausted', () => {
    for (let i = 0; i < MAX_VEHICLES_PER_TYPE; i++) {
      pool.allocate(makeTestVehicle({ id: `v-${i}` }));
    }
    expect(pool.meshes.car.count).toBe(256);
    pool.allocate(makeTestVehicle({ id: 'overflow' }));
    expect(pool.trails.has('overflow')).toBe(false);
    expect(pool.getPosition('overflow')).toBeNull();
    expect(pool.meshes.car.count).toBe(256);
  });

  it('getPosition returns null for an unknown id', () => {
    expect(pool.getPosition('nope')).toBeNull();
  });
});

describe('createVehicleInstances — remove', () => {
  it('zeroes the freed slot matrix and drops the trail', () => {
    pool.allocate(makeTestVehicle({ id: 'v-1' }));
    const trail = pool.trails.get('v-1')!;
    const disposeGeom = vi.spyOn(trail.line.geometry, 'dispose');
    const disposeMat = vi.spyOn(trail.line.material as THREE.Material, 'dispose');

    pool.remove('v-1');

    const { scale } = decompose(pool.meshes.car, 0);
    expect(scale.x).toBe(0);
    expect(scale.y).toBe(0);
    expect(scale.z).toBe(0);
    expect(pool.getPosition('v-1')).toBeNull();
    expect(pool.pickByInstance(pool.meshes.car, 0)).toBeNull();
    expect(pool.trails.has('v-1')).toBe(false);
    expect(disposeGeom).toHaveBeenCalledTimes(1);
    expect(disposeMat).toHaveBeenCalledTimes(1);
  });

  it('shrinks count only when the removed slot was the last one', () => {
    pool.allocate(makeTestVehicle({ id: 'a' }));
    pool.allocate(makeTestVehicle({ id: 'b' }));
    pool.allocate(makeTestVehicle({ id: 'c' }));
    expect(pool.meshes.car.count).toBe(3);

    pool.remove('b'); // middle slot -> count must not shrink (slot 2 is live)
    expect(pool.meshes.car.count).toBe(3);

    pool.remove('c'); // last slot -> walk back over the hole left by 'b'
    expect(pool.meshes.car.count).toBe(1);
  });

  it('converges back to count 0 when every vehicle is removed', () => {
    for (const id of ['a', 'b', 'c']) pool.allocate(makeTestVehicle({ id }));
    for (const id of ['b', 'c', 'a']) pool.remove(id);
    expect(pool.meshes.car.count).toBe(0);
    expect(pool.trails.size).toBe(0);
  });

  it('recycles the freed slot for the next vehicle of that type', () => {
    pool.allocate(makeTestVehicle({ id: 'a' }));
    pool.remove('a');
    pool.allocate(makeTestVehicle({ id: 'b' }));
    expect(pool.pickByInstance(pool.meshes.car, 0)).toBe('b');
    expect(pool.meshes.car.count).toBe(1);
  });

  it('removing an unknown id is a no-op', () => {
    pool.allocate(makeTestVehicle({ id: 'a' }));
    expect(() => pool.remove('ghost')).not.toThrow();
    expect(pool.meshes.car.count).toBe(1);
    expect(pool.pickByInstance(pool.meshes.car, 0)).toBe('a');
  });

  it('finds a vehicle in whichever type pool holds it', () => {
    pool.allocate(makeTestVehicle({ id: 'b1', type: 'bus' }));
    pool.remove('b1');
    expect(pool.meshes.bus.count).toBe(0);
    expect(pool.meshes.car.count).toBe(0);
  });
});

describe('createVehicleInstances — update', () => {
  it('moves the instance matrix and advances the trail when the vehicle moves', () => {
    pool.allocate(makeTestVehicle({ id: 'v-1', position: { x: 0, y: 0, z: 0 } }));
    pool.update(makeTestVehicle({ id: 'v-1', position: { x: 3, y: 0, z: 4 } }));
    const p = pool.getPosition('v-1')!;
    expect(p.x).toBeCloseTo(3, 10);
    expect(p.z).toBeCloseTo(4, 10);
    const trail = pool.trails.get('v-1')!;
    expect(trail.history).toHaveLength(TRAIL_LENGTH);
    expect(trail.history[TRAIL_LENGTH - 1]).toEqual({ x: 3, y: 0, z: 4 });
    // buffer mirrors the history, lifted 0.1u
    expect(trail.positions[(TRAIL_LENGTH - 1) * 3 + 0]).toBeCloseTo(3, 5);
    expect(trail.positions[(TRAIL_LENGTH - 1) * 3 + 1]).toBeCloseTo(0.1, 5);
    expect(trail.positions[(TRAIL_LENGTH - 1) * 3 + 2]).toBeCloseTo(4, 5);
  });

  it('a heading-only change still counts as moved', () => {
    pool.allocate(makeTestVehicle({ id: 'v-1', position: { x: 0, y: 0, z: 0 }, heading: 0 }));
    pool.update(makeTestVehicle({ id: 'v-1', position: { x: 0, y: 0, z: 0 }, heading: Math.PI / 2 }));
    const { quat } = decompose(pool.meshes.car, 0);
    expect(quat.y).toBeCloseTo(-Math.SQRT1_2, 10);
  });

  it('a completely unchanged vehicle does not advance the trail', () => {
    pool.allocate(makeTestVehicle({ id: 'v-1', position: { x: 0, y: 0, z: 0 } }));
    const trail = pool.trails.get('v-1')!;
    const before = trail.positions.slice();
    pool.update(makeTestVehicle({ id: 'v-1', position: { x: 0, y: 0, z: 0 } }));
    expect(Array.from(trail.positions)).toEqual(Array.from(before));
    expect(trail.history[TRAIL_LENGTH - 1]).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('re-tints the instance when the colour changes', () => {
    pool.allocate(makeTestVehicle({ id: 'v-1', color: '#3a86ff' }));
    pool.update(makeTestVehicle({ id: 'v-1', position: { x: 0, y: 0, z: 0 }, color: '#ff0000' }));
    expect(colorAt(pool.meshes.car, 0).getHexString()).toBe('ff0000');
  });

  it('keeps the instance colour when nothing changed', () => {
    pool.allocate(makeTestVehicle({ id: 'v-1', color: '#3a86ff' }));
    pool.update(makeTestVehicle({ id: 'v-1', position: { x: 0, y: 0, z: 0 }, color: '#3a86ff' }));
    expect(colorAt(pool.meshes.car, 0).getHexString()).toBe('3a86ff');
  });

  it('resets the whole trail on a >20m teleport instead of drawing a line across the map', () => {
    pool.allocate(makeTestVehicle({ id: 'v-1', position: { x: 0, y: 0, z: 0 } }));
    const trail = pool.trails.get('v-1')!;
    // a 15m nudge stays under the wrap threshold -> history is appended to
    pool.update(makeTestVehicle({ id: 'v-1', position: { x: 15, y: 0, z: 0 } }));
    expect(trail.history[0]).toEqual({ x: 0, y: 0, z: 0 });
    // a 25m jump exceeds it -> every sample is refilled at the new spot
    pool.update(makeTestVehicle({ id: 'v-1', position: { x: 40, y: 0, z: 0 } }));
    expect(trail.history.every((h) => h.x === 40)).toBe(true);
    expect(trail.history).toHaveLength(TRAIL_LENGTH);
  });

  it('an unknown id is a no-op', () => {
    pool.allocate(makeTestVehicle({ id: 'v-1' }));
    expect(() => pool.update(makeTestVehicle({ id: 'ghost', position: { x: 9, y: 0, z: 9 } }))).not.toThrow();
    expect(pool.getPosition('v-1')!.x).toBeCloseTo(0, 10);
    expect(pool.trails.size).toBe(1);
  });

  it('does not advance a trail that was already removed', () => {
    pool.allocate(makeTestVehicle({ id: 'v-1' }));
    pool.remove('v-1');
    expect(() => pool.update(makeTestVehicle({ id: 'v-1', position: { x: 5, y: 0, z: 5 } }))).not.toThrow();
  });
});

describe('createVehicleInstances — pickByInstance', () => {
  it('maps an InstancedMesh + instanceId back to the entity id', () => {
    pool.allocate(makeTestVehicle({ id: 'a' }));
    pool.allocate(makeTestVehicle({ id: 'b', type: 'truck' }));
    expect(pool.pickByInstance(pool.meshes.car, 0)).toBe('a');
    expect(pool.pickByInstance(pool.meshes.truck, 0)).toBe('b');
  });

  it('returns null for a free slot and for a foreign mesh', () => {
    pool.allocate(makeTestVehicle({ id: 'a' }));
    expect(pool.pickByInstance(pool.meshes.car, 7)).toBeNull();
    expect(pool.pickByInstance(new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 1), 0)).toBeNull();
  });
});

describe('createVehicleInstances — dispose', () => {
  it('disposes every instanced geometry + material and clears the trail map', () => {
    pool.allocate(makeTestVehicle({ id: 'a' }));
    pool.allocate(makeTestVehicle({ id: 'b', type: 'bus' }));
    const spies = TYPES.map((t) => ({
      geom: vi.spyOn(pool.meshes[t].geometry, 'dispose'),
      mat: vi.spyOn(pool.meshes[t].material as THREE.Material, 'dispose'),
    }));
    const trailGeoms = [...pool.trails.values()].map((tr) =>
      vi.spyOn(tr.line.geometry, 'dispose'),
    );
    const trailMats = [...pool.trails.values()].map((tr) =>
      vi.spyOn(tr.line.material as THREE.Material, 'dispose'),
    );

    pool.dispose();

    for (const s of spies) {
      expect(s.geom).toHaveBeenCalledTimes(1);
      expect(s.mat).toHaveBeenCalledTimes(1);
    }
    expect(trailGeoms).toHaveLength(2);
    for (const g of trailGeoms) expect(g).toHaveBeenCalledTimes(1);
    for (const m of trailMats) expect(m).toHaveBeenCalledTimes(1);
    expect(pool.trails.size).toBe(0);
  });
});
