/**
 * The delivery page's live evidence.
 *
 * The capability matrix used to be a sheet of claims: four cards, each
 * asserting that a capability was live, with the numbers hardcoded in
 * the template. A claim cannot be checked, and it goes stale — the page
 * still said "58 e2e 用例" after the suite lost a spec, and it quoted
 * the city's road count without ever asking the backend.
 *
 * This composable asks the running product instead:
 *
 *   - `/health` / `/ping`      — is the backend there at all;
 *   - `/maps/sample-stats`     — the bundled city, counted by the
 *                                 backend that serves it;
 *   - `/rl/capabilities`       — the training stack that is actually
 *                                 installed (torch build, CUDA, device);
 *   - `/rl/scenes`             — the training scenes on offer;
 *   - `/rl/checkpoints`        — the trained policies on disk.
 *
 * When the backend is down the evidence says so. It does NOT fall back
 * to the old hardcoded numbers and pretend — a page that shows a green
 * "已实现" chip next to a number it could not verify is exactly the
 * kind of claim this replaced.
 */
import { onMounted, ref, type Ref } from 'vue'
import { createHttpClient } from '@infrastructure/api'

export interface CityEvidence {
  source: string
  roads: number
  intersections: number
  trafficLights: number
  spawnPoints: number
}

export interface RlEvidence {
  checkpoints: number
  scenes: string[]
  torch: string
  device: string
  cuda: boolean
}

export type EvidenceState = 'probing' | 'live' | 'offline'

export interface LiveEvidence {
  /** 'probing' until the first answer arrives; 'offline' if none did. */
  state: Ref<EvidenceState>
  city: Ref<CityEvidence | null>
  rl: Ref<RlEvidence | null>
  /** What went wrong, in the user's language. */
  note: Ref<string>
}

interface CapabilitiesResponse {
  torch_version?: string
  cuda_available?: boolean
  device_name?: string
  sb3_available?: boolean
}

interface CheckpointsResponse {
  checkpoints?: unknown[]
}

interface ScenesResponse {
  scenes?: string[]
}

// The endpoints register their paths in full (the OpenAPI paths are
// final), so this client is created with an empty prefix — the same
// reason BackendView's probe client is.
const http = createHttpClient('')

const fetchCity = async (): Promise<CityEvidence> => {
  const body = await http.get<CityEvidence>('/api/v1/maps/sample-stats', { timeoutMs: 20_000 })
  return body
}

const fetchRl = async (): Promise<RlEvidence> => {
  const [capabilities, scenes, checkpoints] = await Promise.all([
    http.get<CapabilitiesResponse>('/api/v1/rl/capabilities'),
    http.get<ScenesResponse>('/api/v1/rl/scenes'),
    http.get<CheckpointsResponse>('/api/v1/rl/checkpoints'),
  ])
  return {
    checkpoints: checkpoints.checkpoints?.length ?? 0,
    scenes: scenes.scenes ?? [],
    torch: capabilities.torch_version ?? '未知',
    device: capabilities.device_name ?? 'CPU',
    cuda: Boolean(capabilities.cuda_available),
  }
}

/**
 * Probe the running product for the numbers the delivery page quotes.
 *
 * The city probe is asked for on its own: it parses the bundled
 * extract the first time (about two seconds) and is free afterwards,
 * while the RL probes are cheap. A failure of the city probe does not
 * throw away the RL evidence.
 */
export const useLiveEvidence = (): LiveEvidence => {
  const state = ref<EvidenceState>('probing')
  const city = ref<CityEvidence | null>(null)
  const rl = ref<RlEvidence | null>(null)
  const note = ref('')

  const probe = async (): Promise<void> => {
    try {
      await http.get<{ status?: string }>('/health')
    } catch {
      state.value = 'offline'
      note.value = '后端未连接 — 下面显示的是构建时的记录'
      return
    }
    // The backend is there. Ask what it can actually do.
    const [cityResult, rlResult] = await Promise.allSettled([fetchCity(), fetchRl()])
    if (cityResult.status === 'fulfilled') {
      city.value = cityResult.value
    }
    if (rlResult.status === 'fulfilled') {
      rl.value = rlResult.value
    }
    if (cityResult.status === 'rejected' && rlResult.status === 'rejected') {
      state.value = 'offline'
      note.value = '后端已连接但没有回答 — 下面显示的是构建时的记录'
      return
    }
    state.value = 'live'
  }

  onMounted(() => {
    void probe()
  })

  return { state, city, rl, note }
}
