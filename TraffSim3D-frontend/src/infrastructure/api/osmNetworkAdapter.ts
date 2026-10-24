// src/infrastructure/api/osmNetworkAdapter.ts
//
// OSM parse payload → frontend `RoadNetwork`.
//
// ## Why this module exists
//
// `POST /api/v1/maps/parse-osm` and `/api/v1/maps/parse-pbf` answer with
// **arrays**:
//
//   { roads: [...], intersections: [...], vehicles: [...],
//     spawnPoints: [ { id, roadId, laneIndex, s, occupiedBy } ],
//     originLat: number, originLon: number }
//
// The frontend's `RoadNetwork` is **record-shaped** (`roads: Record<string,
// Road>`) and is looked up by id (`network.road('w-201')`). The import
// path used to assign the payload verbatim (`loadNetwork(payload as
// never)`), so `Object.keys(network.roads)` was `["0","1","2","3"]` — the
// *array indices*. Every id lookup missed, `network.roads[v.roadId]` was
// `undefined`, and `spawnVehicle` died with
// `TypeError: Cannot read properties of undefined (reading 'waypoints')`.
//
// This module is the boundary that fixes it: **arrays → records keyed by
// the entity's own id**, never by array index.
//
// ## Frame
//
// The backend projects lat/lon into a local metric frame
// (`TraffSim3D-backend/app/apps/maps/osm_parser.py::_project_nodes`):
//
//   x = (lon - originLon) * 111000 * cos(originLat)   → east-positive
//   z = (lat - originLat) * 111000                     → north-positive
//
// The frontend world frame is the opposite on Z (north = -Z — see
// `application/services/defaultScene.ts` and
// `infrastructure/cesium/cameraSync.ts`). The payload's Z is therefore
// negated once, here, at the boundary, so an imported network shares the
// frame of every other scene in the app (and therefore lines up with the
// Cesium basemap).
//
// If the backend ever changes its projection, flip
// `OSM_PAYLOAD_NORTH_IS_POSITIVE_Z` — that constant is the only place
// the convention is encoded.
//
// ## Tolerance
//
// The backend group is still filling this payload in (`spawnPoints` and
// `originLat`/`originLon` may be absent). Everything optional is
// tolerated: a missing `spawnPoints` falls back to spawn points derived
// from the roads, a missing origin means "no geographic anchor" (the
// Cesium layer then falls back to its default origin).
//
// ## The junction box
//
// The payload carries an `intersectionRadius` per intersection, and the
// adapter **does not trust it**: the radius is derived from the roads the
// junction connects (`@domain/services/junctionRadius` — the same rule
// the built-in scenes use). The payload's value is kept as a cross-check
// and reported in `stats.radiusMismatches`.
//
// The reason is that the two numbers have to be the same number: the
// backend places the spawn points and sizes the junction boxes against
// it, and the frontend puts the stop line on the box's edge. Two
// independent answers would put the car in one place and the stop line in
// another. The backend derives the same number from the same lane model
// (`app/apps/maps/osm_parser.py` → `junction_radius`), and a
// cross-check over the real Shenzhen OSM extract (7991 junctions)
// proved the two agree on every one of them.
//
// ## Layering
//
// `spawnImportedVehicles` calls the existing `spawnVehicle` use case
// (`application/services/spawnVehicle.ts`) instead of re-implementing
// spawn selection. The adapter owns the whole "payload → network →
// vehicles" sequence of the import chain, so it is the only place that
// has to know about both.

import { spawnVehicle } from '@application/services/spawnVehicle'
import type { Intersection } from '@domain/entities/Intersection'
import type { Road } from '@domain/entities/Road'
import {
  createRoadNetworkFrom,
  type GeoOrigin,
  type RoadNetwork,
} from '@domain/entities/RoadNetwork'
import type { SpawnPoint } from '@domain/entities/SpawnPoint'
import type { TrafficLight } from '@domain/entities/TrafficLight'
import type { Vehicle, VehicleStatus, VehicleType } from '@domain/entities/Vehicle'
import { junctionRadiusForRoads } from '@domain/services/junctionRadius'
import { LaneId } from '@domain/value-objects/LaneId'
import { LightPhase } from '@domain/value-objects/Phase'
import type { Position } from '@domain/value-objects/Position'

/**
 * Does the backend payload's local frame use **north-positive Z**?
 *
 * `true`  → the payload's `z` is metres north of the projection origin,
 *           so the adapter negates it to reach the app frame (north = -Z).
 * `false` → the payload is already south-positive; the adapter keeps it.
 *
 * Source of truth: `osm_parser.py::_project_nodes`
 * (`z = (lat - center_lat) * 111000.0`).
 */
export const OSM_PAYLOAD_NORTH_IS_POSITIVE_Z = true

/** Metres per degree of latitude used by the backend projection. */
export const OSM_METERS_PER_DEGREE_LAT = 111000

const DEFAULT_LANE_COUNT = 2
const DEFAULT_SPEED_LIMIT = 13.89
const DEFAULT_LIGHT_CYCLE_SECONDS = 63
const DEFAULT_LIGHT_PHASE_REMAINING = 30
const DEFAULT_AXIS: TrafficLight['axis'] = 'ns'
const VEHICLE_TYPES: readonly VehicleType[] = ['car', 'truck', 'bus']
const VEHICLE_STATUSES: readonly VehicleStatus[] = ['driving', 'waiting', 'crashed']
const KNOWN_PHASES: ReadonlySet<string> = new Set<string>(Object.values(LightPhase))

/**
 * How far two radii may differ before the payload's value counts as a
 * disagreement with the derived one (metres). The two sides compute the
 * same number from the same lane model, so this only catches a real
 * divergence, not a rounding artefact.
 */
const RADIUS_EPSILON = 1e-6

/** The raw shape the backend answers with (all fields optional on purpose). */
export interface OsmNetworkPayload {
  roads?: unknown
  intersections?: unknown
  vehicles?: unknown
  spawnPoints?: unknown
  originLat?: unknown
  originLon?: unknown
}

/** Counts of the normalized network — the "what did we import" readout. */
export interface OsmPayloadStats {
  roads: number
  intersections: number
  lights: number
  vehicles: number
  spawnPoints: number
  /** Entries that were dropped because they were malformed. */
  dropped: number
  /** Spawn points the frontend derived because the payload had none. */
  derivedSpawnPoints: number
  /**
   * Intersections whose **payload** radius disagreed with the radius the
   * frontend derived from the same roads' lane counts.
   *
   * The frontend derives the radius itself (the rule lives in
   * `@domain/services/junctionRadius`), so the payload's value is a
   * cross-check: a non-zero count means the backend and the frontend
   * disagree about the junction geometry — the stop line and the
   * intersection-occupancy rule would then be sized differently on the
   * two sides.
   */
  radiusMismatches: number
}

export interface NormalizedOsmNetwork {
  /** Ready-to-use frontend network (records keyed by id). */
  network: RoadNetwork
  /** Geographic anchor of the payload, or `null` when it carries none. */
  origin: GeoOrigin | null
  stats: OsmPayloadStats
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const num = (value: unknown, fallback: number): number => finiteNumber(value) ?? fallback

const int = (value: unknown, fallback: number): number => Math.round(num(value, fallback))

/** Read an entity id: strings pass through, numbers are stringified. */
const readId = (value: unknown): string | null => {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

const readPosition = (value: unknown, fallback: Position = { x: 0, y: 0, z: 0 }): Position => {
  if (!isRecord(value)) return fallback
  return {
    x: num(value.x, fallback.x),
    y: num(value.y, fallback.y),
    z: num(value.z, fallback.z),
  }
}

/**
 * Backend local frame → app world frame.
 *
 * X is east in both frames; Z flips (backend: north-positive, app:
 * north-negative). Y (elevation) is untouched.
 */
const toAppFrame = (p: Position): Position =>
  OSM_PAYLOAD_NORTH_IS_POSITIVE_Z ? { x: p.x, y: p.y, z: -p.z } : { x: p.x, y: p.y, z: p.z }

/** Read the payload's projection origin; `null` when absent or invalid. */
export const readOsmOrigin = (payload: unknown): GeoOrigin | null => {
  if (!isRecord(payload)) return null
  const lat = finiteNumber(payload.originLat)
  const lon = finiteNumber(payload.originLon)
  if (lat === null || lon === null) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  return { lat, lon }
}

// ---------------------------------------------------------------------------
// entity normalization
// ---------------------------------------------------------------------------

const normalizeRoad = (raw: unknown): Road | null => {
  if (!isRecord(raw)) return null
  const id = readId(raw.id)
  if (id === null) return null

  const startNode = toAppFrame(readPosition(raw.startNode))
  const endNode = toAppFrame(readPosition(raw.endNode))
  const rawWaypoints = Array.isArray(raw.waypoints) ? raw.waypoints : null
  const waypoints = rawWaypoints
    ? rawWaypoints
        .filter(isRecord)
        .map((wp) => toAppFrame(readPosition(wp, startNode)))
        .filter((wp) => Number.isFinite(wp.x) && Number.isFinite(wp.z))
    : []

  const laneCount = Math.max(1, int(raw.laneCount, DEFAULT_LANE_COUNT))
  // The OSM parser emits `oneway` for every road it parses. Keeping it
  // here is what lets the network-level simulator honour a one-way
  // street; dropping it (as this adapter used to) turned every one-way
  // street in an imported map into a two-way one.
  const oneway = raw.oneway === true ? true : raw.oneway === false ? false : null
  return {
    id,
    startNode,
    endNode,
    // A polyline shorter than 2 points is meaningless — fall back to the
    // 2-point road form (`waypoints` absent ⇒ straight line).
    ...(waypoints.length >= 2 ? { waypoints } : {}),
    laneCount,
    speedLimit: num(raw.speedLimit, DEFAULT_SPEED_LIMIT),
    level: int(raw.level, 0),
    ...(oneway === null ? {} : { oneway }),
  }
}

const normalizeTrafficLight = (raw: unknown, fallbackId: string): TrafficLight | null => {
  if (!isRecord(raw)) return null
  const id = readId(raw.id) ?? fallbackId
  const phase =
    typeof raw.phase === 'string' && KNOWN_PHASES.has(raw.phase) ? raw.phase : LightPhase.Red
  const axis: TrafficLight['axis'] = raw.axis === 'ew' ? 'ew' : DEFAULT_AXIS
  const controlledLane = finiteNumber(raw.controlledLane)
  return {
    id,
    position: toAppFrame(readPosition(raw.position)),
    phase: phase as TrafficLight['phase'],
    phaseRemaining: num(raw.phaseRemaining, DEFAULT_LIGHT_PHASE_REMAINING),
    cycleSeconds: num(raw.cycleSeconds, DEFAULT_LIGHT_CYCLE_SECONDS),
    axis,
    ...(controlledLane === null ? {} : { controlledLane: int(controlledLane, 0) }),
  }
}

/**
 * One normalized intersection plus what the payload claimed about it.
 */
interface NormalizedIntersection {
  intersection: Intersection
  /** The radius the payload carried, or `null` when it carried none. */
  payloadRadius: number | null
  /** `true` when the payload's radius differs from the derived one. */
  radiusMismatch: boolean
}

/**
 * Normalize one intersection of the payload.
 *
 * The radius is **derived**, not read: the payload's `intersectionRadius`
 * is a cross-check, not the source of truth. The rule is the same one the
 * built-in scenes use (`@domain/services/junctionRadius`), so an imported
 * junction and a built-in one are sized by the same geometry — the
 * backend derives the same number from the same lane model
 * (`app/apps/maps/osm_parser.py` → `junction_radius`), and the cross-check
 * script proves the two agree on the real Shenzhen extract.
 */
const normalizeIntersection = (
  raw: unknown,
  laneCountOf: (roadId: string) => number | undefined,
): NormalizedIntersection | null => {
  if (!isRecord(raw)) return null
  const id = readId(raw.id)
  if (id === null) return null
  const rawLights = Array.isArray(raw.trafficLights) ? raw.trafficLights : []
  const trafficLights = rawLights
    .map((light, lightIndex) => normalizeTrafficLight(light, `${id}-tl-${lightIndex}`))
    .filter((light): light is TrafficLight => light !== null)
  const connectedRoads = Array.isArray(raw.connectedRoads)
    ? raw.connectedRoads.filter((roadId): roadId is string => typeof roadId === 'string')
    : []
  // The lane model of the roads this junction connects — the widest one
  // decides the half-width of the box.
  const laneCounts = connectedRoads
    .map((roadId) => laneCountOf(roadId))
    .filter((count): count is number => count !== undefined)
  // The rule is unconditional — the clearance applies to every junction,
  // imported or built-in. Every junction can hold a queue: the frontend
  // paints a stop line on **every** junction's box edge (`roadStopLines`
  // does not look at the traffic lights), and the cross-road yield rule
  // (`tick.ts` → `applyCrossRoadYield`) can stop a vehicle in front of
  // any of them, lit or not. The parser's own traffic lights are no proxy
  // for that — it only attaches one to the OSM nodes tagged
  // `highway=traffic_signals` (51 of the 7991 junctions in the Shenzhen
  // extract).
  //
  // A junction whose roads the payload did not carry falls back to the
  // default lane count — the same 2-lane road the old hard-coded 8 m
  // default assumed, but derived by the rule instead of asserted.
  const radius = junctionRadiusForRoads(laneCounts.length > 0 ? laneCounts : [DEFAULT_LANE_COUNT])
  const payloadRadius = finiteNumber(raw.intersectionRadius)
  return {
    intersection: {
      id,
      position: toAppFrame(readPosition(raw.position)),
      trafficLights,
      connectedRoads,
      intersectionRadius: radius,
    },
    payloadRadius,
    radiusMismatch: payloadRadius !== null && Math.abs(payloadRadius - radius) > RADIUS_EPSILON,
  }
}

const normalizeSpawnPoint = (raw: unknown, index: number): SpawnPoint | null => {
  if (!isRecord(raw)) return null
  const id = readId(raw.id) ?? `sp-${index}`
  const roadId = readId(raw.roadId)
  if (roadId === null) return null
  const occupiedBy = readId(raw.occupiedBy)
  return {
    id,
    roadId,
    laneIndex: Math.max(0, int(raw.laneIndex, 0)),
    // `s` is the arc length along the road where the car appears, and it
    // is **the backend's value**. An OSM junction is a node shared by two
    // ways, so it sits at a way *endpoint*: the backend projects the
    // junction onto the road and puts the spawn point at the end that is
    // furthest from every junction on it. Resetting `s` to 0 here would
    // put every imported car back into a junction — which is exactly what
    // this adapter used to do by derivation.
    s: Math.max(0, num(raw.s, 0)),
    occupiedBy,
  }
}

const normalizeVehicle = (raw: unknown, index: number): Vehicle | null => {
  if (!isRecord(raw)) return null
  const id = readId(raw.id) ?? `v-${index + 1}`
  const roadId = readId(raw.roadId) ?? ''
  const laneIndex = Math.max(0, int(raw.laneIndex, 0))
  const type: VehicleType = VEHICLE_TYPES.includes(raw.type as VehicleType)
    ? (raw.type as VehicleType)
    : 'car'
  const status: VehicleStatus = VEHICLE_STATUSES.includes(raw.status as VehicleStatus)
    ? (raw.status as VehicleStatus)
    : 'driving'
  return {
    id,
    type,
    color: typeof raw.color === 'string' ? raw.color : '#3a86ff',
    position: toAppFrame(readPosition(raw.position)),
    heading: num(raw.heading, 0),
    speed: num(raw.speed, 0),
    targetSpeed: num(raw.targetSpeed, 0),
    roadId,
    laneIndex,
    s: num(raw.s, 0),
    lane: LaneId.make(roadId, laneIndex),
    status,
    desiredStatus: VEHICLE_STATUSES.includes(raw.desiredStatus as VehicleStatus)
      ? (raw.desiredStatus as VehicleStatus)
      : status,
    enteredIntersectionAt: finiteNumber(raw.enteredIntersectionAt),
    desiredLaneIndex: finiteNumber(raw.desiredLaneIndex),
    laneChangeStartedAt: finiteNumber(raw.laneChangeStartedAt),
    spawnedAt: num(raw.spawnedAt, 0),
  }
}

// ---------------------------------------------------------------------------
// the adapter
// ---------------------------------------------------------------------------

/**
 * Normalize a backend parse payload into a frontend `RoadNetwork`.
 *
 * - `roads` / `intersections` / `vehicles` / `spawnPoints` **arrays** become
 *   records keyed by the entity's own `id` (never by array index).
 * - A payload that already carries records (not arrays) is accepted as-is.
 * - Missing `spawnPoints` → spawn points are derived from the roads.
 * - Missing `originLat`/`originLon` → no geographic anchor (`origin: null`).
 */
export const normalizeOsmPayload = (payload: unknown): NormalizedOsmNetwork => {
  const source: OsmNetworkPayload = isRecord(payload) ? payload : {}
  let dropped = 0

  // ---- roads ----
  const roads: Record<string, Road> = {}
  const rawRoads = Array.isArray(source.roads) ? source.roads : []
  for (const raw of rawRoads) {
    const road = normalizeRoad(raw)
    if (!road) {
      dropped += 1
      continue
    }
    roads[road.id] = road
  }

  // ---- intersections ----
  const intersections: Record<string, Intersection> = {}
  const rawIntersections = Array.isArray(source.intersections) ? source.intersections : []
  let radiusMismatches = 0
  for (const raw of rawIntersections) {
    const normalized = normalizeIntersection(raw, (roadId) => roads[roadId]?.laneCount)
    if (!normalized) {
      dropped += 1
      continue
    }
    // The payload's radius is a cross-check only (the frontend derives the
    // radius from the lane model). A mismatch means the backend and the
    // frontend disagree about the junction geometry — worth reporting.
    if (normalized.radiusMismatch) radiusMismatches += 1
    intersections[normalized.intersection.id] = normalized.intersection
  }

  // ---- vehicles ----
  const vehicles: Record<string, Vehicle> = {}
  const rawVehicles = Array.isArray(source.vehicles) ? source.vehicles : []
  for (const [index, raw] of rawVehicles.entries()) {
    const vehicle = normalizeVehicle(raw, index)
    if (!vehicle) {
      dropped += 1
      continue
    }
    vehicles[vehicle.id] = vehicle
  }

  // ---- spawn points ----
  const spawnPoints: Record<string, SpawnPoint> = {}
  const rawSpawnPoints = Array.isArray(source.spawnPoints) ? source.spawnPoints : []
  for (const [index, raw] of rawSpawnPoints.entries()) {
    const spawnPoint = normalizeSpawnPoint(raw, index)
    if (!spawnPoint) {
      dropped += 1
      continue
    }
    // A spawn point on a road that does not exist would make
    // `spawnVehicle` dereference `undefined.waypoints` — drop it here.
    if (!roads[spawnPoint.roadId]) {
      dropped += 1
      continue
    }
    const road = roads[spawnPoint.roadId]!
    spawnPoint.laneIndex = Math.min(spawnPoint.laneIndex, Math.max(0, road.laneCount - 1))
    spawnPoints[spawnPoint.id] = spawnPoint
  }

  const origin = readOsmOrigin(source)
  const network = createRoadNetworkFrom(
    { roads, intersections, vehicles, spawnPoints },
    origin ?? undefined,
  )

  // The backend may not ship spawn points yet — derive them so an
  // imported city is not an empty scene (see `deriveSpawnPoints`).
  const derivedSpawnPoints = Object.keys(spawnPoints).length === 0 ? deriveSpawnPoints(network) : 0

  const lights = Object.values(intersections).reduce(
    (sum, intersection) => sum + intersection.trafficLights.length,
    0,
  )

  return {
    network,
    origin,
    stats: {
      roads: Object.keys(roads).length,
      intersections: Object.keys(intersections).length,
      lights,
      vehicles: Object.keys(vehicles).length,
      spawnPoints: Object.keys(network.spawnPoints).length,
      dropped,
      derivedSpawnPoints,
      radiusMismatches,
    },
  }
}

// ---------------------------------------------------------------------------
// spawn points + vehicles
// ---------------------------------------------------------------------------

export interface DeriveSpawnPointsOptions {
  /** Spawn points per road. Default 1. */
  perRoad?: number
  /** Hard cap on derived spawn points (keeps a 500-road import cheap). */
  max?: number
}

/**
 * Derive spawn points from the network's roads — the **fallback** for a
 * payload that carries none.
 *
 * The backend's spawn points win whenever the payload has any. An OSM
 * junction is a node *shared* by two ways, so it sits at a way endpoint,
 * and `s = 0` (the road's start) is therefore usually right inside the
 * junction. The backend avoids that: it projects every junction onto its
 * road and places the spawn point at the end of the road that is
 * furthest from all of them (see `app/apps/maps/osm_parser.py`).
 *
 * This function only runs when the payload carries no spawn points at all
 * (an old backend, or a hand-written payload). It derives one spawn point
 * per road on lane 0 (the rightmost forward lane) at `s = 0` (the road's
 * start).
 *
 * Returns the number of spawn points that were added.
 */
export const deriveSpawnPoints = (
  network: RoadNetwork,
  options: DeriveSpawnPointsOptions = {},
): number => {
  const perRoad = Math.max(1, Math.floor(options.perRoad ?? 1))
  const max = Math.max(1, Math.floor(options.max ?? 256))
  let added = 0
  for (const road of Object.values(network.roads)) {
    if (added >= max) break
    if (road.laneCount <= 0) continue
    for (let lane = 0; lane < Math.min(perRoad, road.laneCount); lane++) {
      if (added >= max) break
      const id = `sp-${road.id}-${lane}`
      if (network.spawnPoints[id]) continue
      network.spawnPoints[id] = {
        id,
        roadId: road.id,
        laneIndex: lane,
        s: 0,
        occupiedBy: null,
      }
      added += 1
    }
  }
  return added
}

export interface SpawnImportedVehiclesOptions {
  /** Id prefix for the generated vehicles. Default `v`. */
  idPrefix?: string
}

/**
 * Spawn vehicles into an imported network via the existing
 * `spawnVehicle` use case.
 *
 * Returns the number of vehicles that were actually added. The spawn
 * path is the same one the editor toolbar uses, so an imported OSM city
 * gets cars that drive on the imported lanes, obey the imported signals
 * and are released from their spawn point once they drive off it.
 */
export const spawnImportedVehicles = (
  network: RoadNetwork,
  count: number,
  options: SpawnImportedVehiclesOptions = {},
): number => {
  const prefix = options.idPrefix ?? 'v'
  // Continue the id sequence after whatever the payload already had.
  let nextNumber = Object.keys(network.vehicles).length + 1
  for (const id of Object.keys(network.vehicles)) {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id)
    if (match) {
      const n = Number(match[1])
      if (Number.isFinite(n) && n >= nextNumber) nextNumber = n + 1
    }
  }

  let spawned = 0
  for (let i = 0; i < count; i++) {
    const result = spawnVehicle(network, `${prefix}-${nextNumber++}`)
    if (!result.ok) break
    network.vehicles[result.vehicle.id] = result.vehicle
    spawned += 1
  }
  return spawned
}
