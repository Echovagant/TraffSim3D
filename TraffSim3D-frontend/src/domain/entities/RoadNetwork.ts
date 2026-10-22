import type { Intersection } from './Intersection'
import type { Road } from './Road'
import type { SpawnPoint } from './SpawnPoint'
import type { Vehicle } from './Vehicle'

export interface RoadNetwork {
  roads: Record<string, Road>
  intersections: Record<string, Intersection>
  vehicles: Record<string, Vehicle>
  /** Spawn points keyed by id. Empty on legacy scenes that
   *  haven't been migrated; tick treats an empty map as "no spawn
   *  limits" so old scenes continue to work. */
  spawnPoints: Record<string, SpawnPoint>
  /** Find road by id; returns undefined if missing. */
  road(id: string): Road | undefined
  intersection(id: string): Intersection | undefined
  vehicle(id: string): Vehicle | undefined
  spawnPoint(id: string): SpawnPoint | undefined
}

export const createRoadNetwork = (): RoadNetwork => {
  const roads: Record<string, Road> = {}
  const intersections: Record<string, Intersection> = {}
  const vehicles: Record<string, Vehicle> = {}
  const spawnPoints: Record<string, SpawnPoint> = {}
  return {
    roads,
    intersections,
    vehicles,
    spawnPoints,
    road: (id) => roads[id],
    intersection: (id) => intersections[id],
    vehicle: (id) => vehicles[id],
    spawnPoint: (id) => spawnPoints[id],
  }
}
