import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Vehicle } from '@domain/entities/Vehicle'
import type { TrafficLight } from '@domain/entities/TrafficLight'
import type { Intersection } from '@domain/entities/Intersection'
import type { Road } from '@domain/entities/Road'
import { LightPhase } from '@domain/value-objects/Phase'
import { createRoadNetwork } from '@domain/entities/RoadNetwork'

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
// 2-point roads) and `intersectionRadius` defaults to 8 in code.
// Bumped to v6: Vehicle gained `desiredStatus: VehicleStatus`
// (intent-based state for the bug-2 hysteresis). RoadNetwork gained
// `spawnPoints: Record<string, SpawnPoint>`. Old v5 scenes load with
// `desiredStatus` defaulted to the vehicle's current `status` and an
// empty `spawnPoints` map (tick treats empty as "no spawn limits").
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

export const serializeNetwork = (network: RoadNetwork): SerializedScene => ({
  schemaVersion: SCENE_SCHEMA_VERSION,
  savedAtMs: Date.now(),
  network: {
    roads: Object.values(network.roads),
    intersections: Object.values(network.intersections),
    vehicles: Object.values(network.vehicles),
  },
})

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
      // helpers fall back to straight 2-point roads, intersection box
      // uses the per-intersection radius (default 8 in code).
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
  for (const i of n.intersections as Array<SerializedIntersection>) net.intersections[i.id] = i
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

  return { ok: true, network: net }
}
