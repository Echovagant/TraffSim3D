import type { Intersection } from './Intersection'
import type { Road } from './Road'
import type { SpawnPoint } from './SpawnPoint'
import type { Vehicle } from './Vehicle'

/**
 * Geographic anchor (WGS84) of the network's local metric frame.
 *
 * The local frame is X = east, Z = south (north is -Z — see
 * `application/services/defaultScene.ts` and
 * `infrastructure/cesium/cameraSync.ts`). `origin` says where that
 * frame sits on the globe, which is what makes an imported OSM map
 * alignable with a real basemap.
 *
 * `undefined` for synthetic scenes (the built-in demo scenes) — they
 * have no geographic meaning.
 */
export interface GeoOrigin {
  /** Latitude in degrees (WGS84). */
  lat: number
  /** Longitude in degrees (WGS84). */
  lon: number
}

export interface RoadNetwork {
  roads: Record<string, Road>
  intersections: Record<string, Intersection>
  vehicles: Record<string, Vehicle>
  /** Spawn points keyed by id. Empty on legacy scenes that
   *  haven't been migrated; tick treats an empty map as "no spawn
   *  limits" so old scenes continue to work. */
  spawnPoints: Record<string, SpawnPoint>
  /**
   * Geographic anchor of the local frame. `undefined` for synthetic
   * scenes (and for scenes saved before this field existed).
   */
  origin?: GeoOrigin
  /** Find road by id; returns undefined if missing. */
  road(id: string): Road | undefined
  intersection(id: string): Intersection | undefined
  vehicle(id: string): Vehicle | undefined
  spawnPoint(id: string): SpawnPoint | undefined
}

/**
 * The four id-keyed collections that make up a network. Used by
 * `createRoadNetworkFrom` to build a `RoadNetwork` from records that
 * were assembled elsewhere (e.g. the OSM import adapter).
 */
export interface RoadNetworkRecords {
  roads: Record<string, Road>
  intersections: Record<string, Intersection>
  vehicles: Record<string, Vehicle>
  spawnPoints: Record<string, SpawnPoint>
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

/**
 * Build a `RoadNetwork` from already-keyed records.
 *
 * The four lookup methods close over the *same* record objects that are
 * exposed on the network, so `network.road(id)` and
 * `network.roads[id]` can never drift apart — the imported-network bug
 * (a payload assigned with `as never`, whose `roads` were keyed by
 * array index) is exactly the failure mode this factory removes.
 *
 * `origin` is optional: synthetic scenes stay anchor-less.
 */
export const createRoadNetworkFrom = (
  records: RoadNetworkRecords,
  origin?: GeoOrigin,
): RoadNetwork => {
  const { roads, intersections, vehicles, spawnPoints } = records
  return {
    roads,
    intersections,
    vehicles,
    spawnPoints,
    ...(origin ? { origin } : {}),
    road: (id) => roads[id],
    intersection: (id) => intersections[id],
    vehicle: (id) => vehicles[id],
    spawnPoint: (id) => spawnPoints[id],
  }
}
