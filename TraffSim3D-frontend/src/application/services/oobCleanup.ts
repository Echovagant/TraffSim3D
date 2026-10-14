// src/application/services/oobCleanup.ts
//
// Plan 034: out-of-bounds cleanup. Pure function for testing.
// tick.ts calls this once per tick; tests can mock deps and run
// without worldStore.
//
// (See 032 §Issue 2 + 034 plan for the full design rationale.)

import type { Vehicle } from '@domain/entities/Vehicle';
import type { Road } from '@domain/entities/Road';
import { lanePoint } from '@domain/services/laneGeometry';
import { OUT_OF_BOUNDS_M } from '@shared/constants/simulation';

export interface TickOobDeps {
  /** Look up a road by id; returns undefined if missing. */
  getRoad: (roadId: string) => Road | undefined;
  /** Hard-delete a vehicle (called when road is missing). */
  removeVehicle: (id: string) => void;
  /** Snap Rapier body to (position, heading) for a respawned vehicle. */
  snapVehicle: (id: string, position: { x: number; y: number; z: number }, heading: number) => void;
}

export const tickOobCleanup = (
  deps: TickOobDeps,
  vehicles: ReadonlyArray<Vehicle>,
  simTime: number,
): void => {
  for (const v of vehicles) {
    // Skip mid lane-change — position is intentionally off-center.
    if (v.desiredLaneIndex !== null) continue;
    // Skip recently spawned (1s grace — Rapier body may not yet have aligned).
    if (simTime - v.spawnedAt < 1.0) continue;

    const road = deps.getRoad(v.roadId);
    if (!road) {
      deps.removeVehicle(v.id);
      continue;
    }

    const expected = lanePoint(road, v.laneIndex, v.s);
    const dx = v.position.x - expected.position.x;
    const dz = v.position.z - expected.position.z;
    const dist = Math.hypot(dx, dz);

    if (dist > OUT_OF_BOUNDS_M) {
      // Respawn at s=0 of same road/lane.
      v.s = 0;
      v.speed = 0;
      const lp = lanePoint(road, v.laneIndex, 0);
      v.position = { x: lp.position.x, y: lp.position.y, z: lp.position.z };
      v.heading = lp.heading;
      deps.snapVehicle(v.id, { x: lp.position.x, y: lp.position.y ?? v.position.y, z: lp.position.z }, lp.heading);
    }
  }
};
