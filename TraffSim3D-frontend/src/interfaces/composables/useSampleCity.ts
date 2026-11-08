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
 * alive from the bird's-eye view, so it scales by `roads / 11` and
 * allows twice the importer's ceiling.
 */
export const sampleCityVehicleCount = (roadCount: number): number => {
  if (!Number.isFinite(roadCount) || roadCount <= 0) return 40
  return Math.min(120, Math.max(40, Math.round(roadCount / 11)))
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
