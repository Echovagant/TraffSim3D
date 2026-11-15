// src/interfaces/composables/useSampleCity.ts
//
// Load the city that ships with the backend.
//
// Until now the Smart City view ran a hand-built two-road junction while
// the picture underneath showed a real city — the cars drove on a road
// the picture did not contain, and the two road layers disagreed with
// each other. That was the single biggest thing wrong with the view.
//
// This loads the SAME city the backend carries (the 深圳福田 extract,
// parsed server-side), so:
//
//   - the simulated network and the drawn basemap describe one place;
//   - the drawn vector roads are the network's own waypoints, so a car
//     is always on the line under it;
//   - the projection origin is the centre of the drawn rectangle, which
//     is also the frontend's fallback tangent origin.
//
// The import path is the one the map importer already uses
// (`normalizeOsmPayload` → `spawnImportedVehicles` → `loadNetwork`), so
// an imported city and the bundled city behave identically.

import { ref } from 'vue'
import type { Ref } from 'vue'
import { useWorldStore } from '@interfaces/stores/worldStore'
import {
  importVehicleCountFor,
  normalizeOsmPayload,
  spawnImportedVehicles,
} from '@infrastructure/api/osmNetworkAdapter'

/** The label the toolbar shows for the bundled city. */
export const SAMPLE_CITY_LABEL = '福田中心(深圳).osm'

/**
 * How many cars the command centre puts on the bundled city.
 *
 * The map importer scales by `roads / 13` and stops at 40 — that is the
 * right number for a map you just imported and want to look at. The
 * command centre is a different job: it is a city that has to look
 * alive from the bird's-eye view. Density TIERS calibrated against
 * real urban-traffic numbers (2026-11-15 research): the Futian extract
 * is ~167 km of road over ~334 lane-km, and congested Chinese urban
 * arterials run ~20-30 km/h at 30-60 veh/km/lane (LOS D-F), so:
 *   low  = ~10 veh/lane-km  (light, free-flow-ish)
 *   mid  = ~20 veh/lane-km  (dense but moving — the default)
 *   high = ~40 veh/lane-km  (peak hour, LOS F — the jam demo)
 */
export const DENSITY_TIERS = [
  { id: 'low', label: '低密度', divisor: 6, cap: 400 },
  { id: 'mid', label: '中密度', divisor: 3, cap: 900 },
  { id: 'high', label: '高密度（高峰）', divisor: 1.5, cap: 2000 },
] as const

export type DensityTierId = (typeof DENSITY_TIERS)[number]['id']

const DENSITY_STORAGE_KEY = 'traffsim3d-density'

export const densityTierSetting = (): DensityTierId => {
  try {
    const raw = localStorage.getItem(DENSITY_STORAGE_KEY) as DensityTierId | null
    if (raw && DENSITY_TIERS.some((t) => t.id === raw)) return raw
  } catch {
    /* storage unavailable — fall through to the default */
  }
  return 'mid'
}

export const setDensityTierSetting = (id: DensityTierId): void => {
  try {
    localStorage.setItem(DENSITY_STORAGE_KEY, id)
  } catch {
    /* storage unavailable */
  }
}

export const sampleCityVehicleCountFor = (roadCount: number, tier: DensityTierId): number => {
  if (!Number.isFinite(roadCount) || roadCount <= 0) return 40
  const tierDef = DENSITY_TIERS.find((t) => t.id === tier) ?? DENSITY_TIERS[1]
  return Math.min(tierDef.cap, Math.max(40, Math.round(roadCount / tierDef.divisor)))
}

export const sampleCityVehicleCount = (roadCount: number): number => {
  if (!Number.isFinite(roadCount) || roadCount <= 0) return 40
  return sampleCityVehicleCountFor(roadCount, densityTierSetting())
}

export interface SampleCityResult {
  ok: boolean
  roadCount: number
  intersectionCount: number
  vehicleCount: number
  /** The failure, when there was one. */
  error?: string
}

export interface SampleCityState {
  loading: Ref<boolean>
  error: Ref<string | null>
  loadSampleCity: () => Promise<SampleCityResult>
}

/**
 * Fetch the bundled city and put it in the store.
 *
 * A failure is NOT fatal: the caller keeps whatever scene was in the
 * store and reports the error. A command centre with no city is worse
 * than one with a demo junction, but a command centre that throws on a
 * network blip is worse than both.
 */
export const useSampleCity = (): SampleCityState => {
  const world = useWorldStore()
  const loading = ref(false)
  const error = ref<string | null>(null)

  const loadSampleCity = async (): Promise<SampleCityResult> => {
    loading.value = true
    error.value = null
    try {
      const res = await fetch('/api/v1/maps/parse-sample', { method: 'POST' })
      if (!res.ok) {
        const detail = await res.text()
        const message = `后端返回 ${res.status}: ${detail.slice(0, 200)}`
        error.value = message
        return { ok: false, roadCount: 0, intersectionCount: 0, vehicleCount: 0, error: message }
      }
      const payload = (await res.json()) as unknown
      const normalized = normalizeOsmPayload(payload)
      const network = normalized.network
      const roadCount = Object.keys(network.roads).length

      // The cars go onto the imported lanes through the same spawn path
      // the scene editor uses, so they obey the imported signals and
      // release from their spawn point the same way.
      const wanted = sampleCityVehicleCount(roadCount)
      const vehicles = spawnImportedVehicles(network, wanted)

      // The network replaces the store's network; the vehicles are
      // already inside it (the spawn helper writes them into
      // `network.vehicles`).
      world.loadNetwork(network, SAMPLE_CITY_LABEL)

      return {
        ok: true,
        roadCount,
        intersectionCount: Object.keys(network.intersections).length,
        vehicleCount: vehicles,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      error.value = message
      return { ok: false, roadCount: 0, intersectionCount: 0, vehicleCount: 0, error: message }
    } finally {
      loading.value = false
    }
  }

  return { loading, error, loadSampleCity }
}
