// src/infrastructure/physics/RapierBodySpec.spec.ts
//
// buildRigidBodySpec is pure: entity attributes → rigid-body numbers.
// Every assertion below is an exact expected value, not a shape check.

import { describe, it, expect } from 'vitest';
import { buildRigidBodySpec } from './RapierBodySpec';
import { VEHICLE_BODY_SPEC } from '@shared/constants/simulation';
import type { VehicleType } from '@domain/entities/Vehicle';

const TYPES: VehicleType[] = ['car', 'truck', 'bus'];

describe('buildRigidBodySpec', () => {
  it('car: mass 1500 kg, halfExtents (length/2, 0.75, width/2) = (2.1, 0.75, 0.9)', () => {
    const spec = buildRigidBodySpec('v-1', 'car', { x: 1, y: 0, z: -2 }, 0);
    expect(spec.mass).toBe(1500);
    expect(spec.halfExtents.x).toBeCloseTo(2.1, 10);
    expect(spec.halfExtents.y).toBe(0.75);
    expect(spec.halfExtents.z).toBeCloseTo(0.9, 10);
  });

  it('truck: mass 4500 kg, halfExtents = (3.25, 0.75, 1.1)', () => {
    const spec = buildRigidBodySpec('v-2', 'truck', { x: 0, y: 0, z: 0 }, 0);
    expect(spec.mass).toBe(4500);
    expect(spec.halfExtents.x).toBeCloseTo(3.25, 10);
    expect(spec.halfExtents.y).toBe(0.75);
    expect(spec.halfExtents.z).toBeCloseTo(1.1, 10);
  });

  it('bus: mass 8000 kg, halfExtents = (4.5, 0.75, 1.25)', () => {
    const spec = buildRigidBodySpec('v-3', 'bus', { x: 0, y: 0, z: 0 }, 0);
    expect(spec.mass).toBe(8000);
    expect(spec.halfExtents.x).toBeCloseTo(4.5, 10);
    expect(spec.halfExtents.y).toBe(0.75);
    expect(spec.halfExtents.z).toBeCloseTo(1.25, 10);
  });

  it('every type derives x/z from VEHICLE_BODY_SPEC and y from the hard-coded 0.75', () => {
    for (const type of TYPES) {
      const spec = buildRigidBodySpec(`v-${type}`, type, { x: 0, y: 0, z: 0 }, 0);
      expect(spec.mass).toBe(VEHICLE_BODY_SPEC[type].mass);
      expect(spec.halfExtents.x).toBe(VEHICLE_BODY_SPEC[type].length / 2);
      expect(spec.halfExtents.z).toBe(VEHICLE_BODY_SPEC[type].width / 2);
      // y is NOT derived from the type table — it is a constant half-height.
      expect(spec.halfExtents.y).toBe(0.75);
    }
  });

  it('passes vehicleId / type / heading through verbatim', () => {
    const spec = buildRigidBodySpec('veh-abc-9', 'truck', { x: 0, y: 0, z: 0 }, -1.25);
    expect(spec.vehicleId).toBe('veh-abc-9');
    expect(spec.type).toBe('truck');
    expect(spec.heading).toBe(-1.25);
  });

  it('keeps the caller position by reference (no defensive copy)', () => {
    const pos = { x: 7.5, y: 0.25, z: -13 };
    const spec = buildRigidBodySpec('v-1', 'car', pos, 0);
    expect(spec.position).toBe(pos);
  });

  it('heavier types get strictly larger mass and no smaller footprint', () => {
    const [car, truck, bus] = TYPES.map((t) =>
      buildRigidBodySpec('v', t, { x: 0, y: 0, z: 0 }, 0),
    );
    expect(car!.mass).toBeLessThan(truck!.mass);
    expect(truck!.mass).toBeLessThan(bus!.mass);
    expect(car!.halfExtents.x).toBeLessThan(truck!.halfExtents.x);
    expect(truck!.halfExtents.x).toBeLessThan(bus!.halfExtents.x);
    expect(car!.halfExtents.z).toBeLessThan(truck!.halfExtents.z);
    expect(truck!.halfExtents.z).toBeLessThan(bus!.halfExtents.z);
  });
});
