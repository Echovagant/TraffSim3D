// src/domain/services/cityBounds.ts
//
// The fleet's home rectangle: the area the city's 3D-modelled buildings
// actually cover. Vehicles spawn and drive inside it; the out-of-bounds
// cleanup removes anything that leaves.
//
// Lives in the domain layer because both the store (spawn-point pruning,
// the per-tick guard) and the view (which owns the building data) need
// it — and because it must NOT know about Cesium: the loadOSMScene's
// `Bbox` type is re-exported from here, the other way around would make
// the domain depend on infrastructure (see rendererRegistry.ts on the
// layering rule).

import type { GeoOrigin } from '@domain/entities/RoadNetwork'

/** A WGS84 rectangle, corners in degrees. Same shape loadOSMScene's
 *  Overpass queries take. */
export interface Bbox {
  south: number
  west: number
  north: number
  east: number
}

/** The same rectangle in the simulation's local metric frame (metres,
 *  north-negative z — the app convention every vehicle position uses). */
export interface LocalRect {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/**
 * The flat projection constant the OSM parser and `localToLngLat` use.
 * Mirrors `OSM_METERS_PER_DEGREE_LAT` in osmNetworkAdapter — the two
 * MUST stay the same number or the boundary lands somewhere else than
 * the drawing does. (Infrastructure re-exports this one.)
 */
export const METERS_PER_DEGREE_LAT = 111000

/**
 * Convert a WGS84 rectangle into the local metric frame. Exact inverse
 * of `localToLngLat` (same flat projection: `x = Δlon·111000·cos(lat)`,
 * `z = −Δlat·111000` in the app frame, north-negative).
 */
export const bboxToLocalRect = (origin: GeoOrigin, bbox: Bbox): LocalRect => {
  const cosLat = Math.max(0.05, Math.cos((origin.lat * Math.PI) / 180))
  const xOf = (lng: number): number => (lng - origin.lon) * METERS_PER_DEGREE_LAT * cosLat
  const zOf = (lat: number): number => -(lat - origin.lat) * METERS_PER_DEGREE_LAT
  return {
    minX: xOf(bbox.west),
    maxX: xOf(bbox.east),
    minZ: zOf(bbox.north),
    maxZ: zOf(bbox.south),
  }
}

/**
 * The slack around the buildings rectangle before a vehicle counts as
 * "outside". The rectangle comes from the buildings' own coordinates —
 * a road that grazes the boundary keeps its vehicles even though their
 * lane centre sits a few metres outside the last rooftop.
 */
export const VEHICLE_BOUNDS_MARGIN_M = 30

/** Is the position outside the rect (with the slack)? Pure arithmetic. */
export const outOfRect = (
  position: { x: number; z: number },
  rect: LocalRect,
  margin = VEHICLE_BOUNDS_MARGIN_M,
): boolean => {
  return (
    position.x < rect.minX - margin ||
    position.x > rect.maxX + margin ||
    position.z < rect.minZ - margin ||
    position.z > rect.maxZ + margin
  )
}
