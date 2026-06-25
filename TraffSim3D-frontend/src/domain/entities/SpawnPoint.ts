// src/domain/entities/SpawnPoint.ts
//
// Plan 037 (bug 3): explicit spawn-point entity. A road has 0..N
// spawn points, each bound to a (roadId, laneIndex, s) tuple. When
// `spawnVehicle` is called, it picks the first free spawn point
// (`occupiedBy === null`) and marks it occupied. The tick releases
// the spawn point once the vehicle has driven past
// `SPAWN_POINT_RELEASE_DISTANCE` (20 m) — that way the road's entry
// point can host a steady stream of vehicles instead of being
// single-use.

export interface SpawnPoint {
  readonly id: string;
  /** Road id this spawn point lives on. */
  roadId: string;
  /** Lane index on that road (forward lanes = 0..N/2-1). */
  laneIndex: number;
  /** Arc-length at which the vehicle enters. Typically 0 (road start). */
  s: number;
  /** vehicleId currently sitting on this spawn point; `null` = free. */
  occupiedBy: string | null;
}