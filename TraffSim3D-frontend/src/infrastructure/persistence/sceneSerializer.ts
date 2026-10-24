import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { GeoOrigin } from '@domain/entities/RoadNetwork'
import type { Vehicle } from '@domain/entities/Vehicle'
import type { TrafficLight } from '@domain/entities/TrafficLight'
import type { Intersection } from '@domain/entities/Intersection'
import type { Road } from '@domain/entities/Road'
import { LightPhase } from '@domain/value-objects/Phase'
import { createRoadNetwork } from '@domain/entities/RoadNetwork'
import { junctionRadiusForRoads } from '@domain/services/junctionRadius'

// Bumped to v3: Vehicle gained `enteredIntersectionAt`
// (simulation-time when the car first crossed into an intersection box;
// used by the cross-road emergency-brake logic for right-of-way).
// Bumped to v4: LightPhase enum gained 7 new values
// (GreenLeft, YellowLeft, RedLeft, FlashingYellow, FlashingRed, AllRed, Dark).
// hydrateNetwork must accept v3 + v4 scenes; v3 scenes with unknown
// phase values fall back to Red (per the v4 migration rule).
// Bumped to v5: Road gained optional `waypoints: Position[]`
// (polyline support). Intersection gained `intersectionRadius: number`.
// v5 scenes are direct supersets of v4 — old v4 scenes load transparently
// with `waypoints === undefined` (geometry helpers fall back to straight
// 2-point roads) and their missing `intersectionRadius` is derived from
// the lane model on load (see `hydrateNetwork`).
// Bumped to v6: Vehicle gained `desiredStatus: VehicleStatus`
// (intent-based state for the bug-2 hysteresis). RoadNetwork gained
// `spawnPoints: Record<string, SpawnPoint>`. Old v5 scenes load with
// `desiredStatus` defaulted to the vehicle's current `status` and an
// empty `spawnPoints` map (tick treats empty as "no spawn limits").
//
// NOT bumped for `network.origin` (the WGS84 geographic anchor):
// the field is optional and purely additive, so a v6 payload without it
// loads with `origin === undefined` — exactly the behaviour of every
// scene saved before the field existed.
//
// The version is also the **LocalStorage key** (`traffsim3d:scene:v6`,
// see `LocalStorageAdapter`), so a bump would orphan every saved scene
// of every existing user: the new key would be empty and the payload
// under the old key would never be read again. That — not the field
// count — is what decides the version here.
export const SCENE_SCHEMA_VERSION = 6

export interface SerializedScene {
  schemaVersion: number
  savedAtMs: number
  network: {
    roads: Road[]
    intersections: SerializedIntersection[]
    vehicles: Vehicle[]
    /** Optional on v5 → v6+ scenes; absent on older payloads. */
    spawnPoints?: SpawnPoint[]
    /**
     * Geographic anchor (WGS84) of the network's local metric frame.
     *
     * Optional and additive: absent on every scene saved before the
     * field existed, and absent on the synthetic (built-in) scenes,
     * which have no geographic meaning. Those load with
     * `origin === undefined`, so the Cesium layer falls back to its
     * default origin — the behaviour before the field was introduced.
     */
    origin?: GeoOrigin
  }
}

import type { SpawnPoint } from '@domain/entities/SpawnPoint'

interface SerializedIntersection extends Omit<Intersection, 'trafficLights'> {
  trafficLights: TrafficLight[]
}

const KNOWN_PHASES = new Set<string>([
  'green',
  'yellow',
  'red',
  'greenLeft',
  'yellowLeft',
  'redLeft',
  'flashingYellow',
  'flashingRed',
  'allRed',
  'dark',
])

const isLightPhase = (v: unknown): v is TrafficLight['phase'] =>
  typeof v === 'string' && KNOWN_PHASES.has(v)

/**
 * Read a serialized geographic anchor.
 *
 * `null` when the field is absent (every scene saved before the field
 * existed) — the caller then leaves `network.origin` undefined.
 *
 * A **present but malformed** anchor is an error, not an absent one:
 * silently dropping it would move an imported map off the real basemap
 * without telling anybody, which is worse than refusing the load.
 */
const readOrigin = (raw: unknown): GeoOrigin | null | undefined => {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const lat = obj.lat
  const lon = obj.lon
  if (typeof lat !== 'number' || !Number.isFinite(lat)) return undefined
  if (typeof lon !== 'number' || !Number.isFinite(lon)) return undefined
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return undefined
  return { lat, lon }
}

export const serializeNetwork = (network: RoadNetwork): SerializedScene => {
  const origin = network.origin
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    savedAtMs: Date.now(),
    network: {
      roads: Object.values(network.roads),
      intersections: Object.values(network.intersections),
      vehicles: Object.values(network.vehicles),
      // The spawn points are part of the scene: without them a reloaded
      // scene has no places to spawn vehicles from, and `tick` treats an
      // empty map as "no spawn limits" — the saved scene would silently
      // lose the ability to spawn. They are written in the same array
      // shape `hydrateNetwork` reads back.
      spawnPoints: Object.values(network.spawnPoints).map((sp) => ({
        id: sp.id,
        roadId: sp.roadId,
        laneIndex: sp.laneIndex,
        s: sp.s,
        occupiedBy: sp.occupiedBy,
      })),
      // The anchor is copied field by field — the network keeps its own
      // object, so a later mutation of the scene must not reach it.
      ...(origin ? { origin: { lat: origin.lat, lon: origin.lon } } : {}),
    },
  }
}

export interface HydrationResult {
  ok: boolean
  reason?: string
  network?: RoadNetwork
}

/**
 * Schema migration dispatcher. Receives a `SerializedScene` of
 * any known version and returns the current version, or `null`
 * if the input is unrecognised.
 *
 * CRITICAL: do NOT coerce `schemaVersion` to a number implicitly.
 * If the input has no schemaVersion (corrupted payload, or hand-
 * edited localStorage), return null and let the caller surface a
 * "saved scene is corrupted" error.
 */
const migrateScene = (d: unknown): SerializedScene | null => {
  if (typeof d !== 'object' || d === null) return null
  const obj = d as Record<string, unknown>
  const v = obj.schemaVersion
  if (typeof v !== 'number') return null
  switch (v) {
    case 1:
    case 2:
    case 3:
      // v1, v2, v3 all upgrade to v4. If we add more versions,
      // add cases here. Missing cases fall through to the default
      // which returns null.
      return { ...obj, schemaVersion: SCENE_SCHEMA_VERSION } as SerializedScene
    case 4:
      // v4 → v5. Road gains optional waypoints, Intersection
      // gains intersectionRadius. Old v4 scenes load as-is — geometry
      // helpers fall back to straight 2-point roads, and the junction
      // box's radius is derived from the lane model on load (a v4 scene
      // has no radius of its own; it used to load as `undefined`, which
      // made the stop line NaN and the traffic light never stopped
      // anyone).
      return { ...obj, schemaVersion: SCENE_SCHEMA_VERSION } as SerializedScene
    case 5:
      // v5 → v6. Vehicle gains desiredStatus (defaults to
      // the vehicle's current status on load), RoadNetwork gains
      // spawnPoints (empty on old scenes → no spawn limit). Same
      // shape, just a version bump.
      return { ...obj, schemaVersion: SCENE_SCHEMA_VERSION } as SerializedScene
    case SCENE_SCHEMA_VERSION:
      return obj as unknown as SerializedScene
    default:
      return null
  }
}

/**
 * Parse a raw `localStorage` payload into a `RoadNetwork`. Returns
 * `{ ok: true, network }` on success, `{ ok: false, reason }` on
 * any validation failure. Failures are intentional: a corrupted
 * saved scene must NOT silently replace the user's in-memory
 * network with garbage.
 *
 * Accepts either a raw JSON string (preferred for unified error
 * reporting) or an already-parsed object (legacy callers).
 */
export const hydrateNetwork = (raw: unknown): HydrationResult => {
  if (raw === null || raw === undefined) return { ok: false, reason: 'no saved scene' }

  let parsed: unknown
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { ok: false, reason: 'saved scene is not valid JSON' }
    }
  } else {
    parsed = raw
  }

  const migrated = migrateScene(parsed)
  if (migrated === null) {
    return { ok: false, reason: 'saved scene has unsupported or missing schemaVersion' }
  }

  // Strict field validation. Empty arrays are OK (user saved a
  // cleared scene), but missing fields, wrong types, or non-array
  // shapes are not.
  if (typeof migrated.schemaVersion !== 'number') {
    return { ok: false, reason: 'migrated scene has no schemaVersion' }
  }
  if (migrated.schemaVersion !== SCENE_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `migrated scene is v${migrated.schemaVersion}, expected v${SCENE_SCHEMA_VERSION}`,
    }
  }
  const n = migrated.network as Record<string, unknown> | undefined
  if (typeof n !== 'object' || n === null) {
    return { ok: false, reason: 'saved scene has no network' }
  }
  if (!Array.isArray(n.roads) || !Array.isArray(n.intersections) || !Array.isArray(n.vehicles)) {
    return { ok: false, reason: 'saved scene network has malformed arrays' }
  }

  // Phase validation per traffic light
  for (const i of n.intersections as Array<Record<string, unknown>>) {
    const tls = i.trafficLights as unknown
    if (
      !Array.isArray(tls) ||
      !tls.every((l) => isLightPhase((l as Record<string, unknown>).phase))
    ) {
      return { ok: false, reason: 'invalid light phase' }
    }
  }

  // Geographic anchor: optional. Absent (the common case — every scene
  // saved before the field existed, and every synthetic scene) leaves
  // `network.origin` undefined, which is exactly the old behaviour.
  const origin = readOrigin((n as Record<string, unknown>).origin)
  if (origin === undefined) {
    return { ok: false, reason: 'invalid network origin' }
  }

  // Build network
  const net = createRoadNetwork()
  for (const r of n.roads as Array<Road>) {
    // Pre-v7 scenes don't have `level`. Default to 0 so
    // older localStorage payloads deserialize without error — they
    // simply render at ground level (existing behaviour). Will be
    // persisted with the field on next save.
    if (!('level' in r) || typeof (r as unknown as Record<string, unknown>).level !== 'number') {
      ;(r as unknown as Record<string, unknown>).level = 0
    }
    net.roads[r.id] = r
  }
  for (const i of n.intersections as Array<SerializedIntersection>) {
    // A scene saved before v5 carries no `intersectionRadius` at all.
    // It used to load as `undefined`, and the stop line is computed from
    // that value (`Math.max(0, undefined)` → NaN), so the traffic-light
    // constraint compared against NaN and **never fired** — cars in an
    // old scene ran red lights.
    //
    // The radius is now derived from the lane model of the roads the
    // junction connects — the same rule the built-in scenes and the
    // imported maps use (`@domain/services/junctionRadius`). `queueable`
    // is true: the front-end paints a stop line on every junction's box
    // edge and the cross-road yield rule can stop a vehicle in front of
    // any of them, lit or not.
    const raw = i as unknown as Record<string, unknown>
    if (typeof raw.intersectionRadius !== 'number' || !Number.isFinite(raw.intersectionRadius)) {
      const laneCounts = i.connectedRoads
        .map((roadId) => net.roads[roadId]?.laneCount)
        .filter((count): count is number => typeof count === 'number')
      raw.intersectionRadius = junctionRadiusForRoads(laneCounts, true)
    }
    net.intersections[i.id] = i
  }
  for (const v of n.vehicles as Array<Vehicle>) {
    // v5 → v6 migration. Old scenes don't have desiredStatus;
    // default it to the vehicle's current status so the hysteresis
    // logic has a sensible "intent" value to start from.
    if (v.desiredStatus === undefined || v.desiredStatus === null) {
      v.desiredStatus = v.status
    }
    net.vehicles[v.id] = v
  }
  // Spawn points: optional field on v6 scenes; old scenes have an empty
  // map (tick treats empty as "no spawn limit", so legacy spawning
  // behaviour is preserved).
  const spArr = (n as Record<string, unknown>).spawnPoints
  if (Array.isArray(spArr)) {
    for (const sp of spArr as Array<{
      id: string
      roadId: string
      laneIndex: number
      s: number
      occupiedBy: string | null
    }>) {
      if (net.spawnPoints[sp.id] === undefined) {
        net.spawnPoints[sp.id] = sp as never
      }
    }
  }

  // The geographic anchor (absent on scenes saved before the field
  // existed — those keep `origin === undefined`).
  if (origin) {
    net.origin = { lat: origin.lat, lon: origin.lon }
  }

  return { ok: true, network: net }
}
