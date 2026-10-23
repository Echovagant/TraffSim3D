/**
 * RL training bridge client — sends custom RoadNetwork data from the
 * frontend scene editor to the backend for RL training.
 *
 * Why this module issues its own request
 * ---------------------------------------
 * The shared `createHttpClient` (`httpClient.ts`) exposes `get` only — it is
 * deliberately a read-only client, and extending it is out of scope here.
 * `validate-network` is a POST, so this module performs the request itself
 * against the same `/api/v1` prefix the Vite dev proxy forwards to FastAPI.
 *
 * The endpoint it talks to is `POST /api/v1/rl/validate-network`: the
 * backend builds the network graph, runs one step of the 24-dimension
 * network-level sim core and reports what came out. It is the counterpart
 * of the 14-dimension contract core, which only knows the fixed
 * cross/corridor scenes.
 */

export interface ValidateResult {
  ok: boolean
  obs_dim?: number
  n_roads?: number
  n_intersections?: number
  error?: string
}

export interface NetworkPayload {
  roads: unknown[]
  intersections: unknown[]
  vehicles: unknown[]
  spawnPoints?: unknown[]
}

export interface RLTrainingClient {
  /** POST /rl/validate-network → whether the backend can simulate this network.
   *  Never throws: a backend error comes back as `{ok: false, error}`. */
  validateNetwork(network: NetworkPayload): Promise<ValidateResult>
}

/** Path of the validation endpoint, relative to the API prefix. */
export const VALIDATE_NETWORK_PATH = '/rl/validate-network'

/** Default API prefix — the Vite dev proxy forwards `/api/v1/*` to FastAPI. */
export const RL_TRAINING_API_PREFIX = '/api/v1'

/** How long the validation request may take, in milliseconds. */
export const VALIDATE_NETWORK_TIMEOUT_MS = 10000

const readDetail = (body: unknown): string | undefined => {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail?: unknown }).detail
    if (typeof detail === 'string') return detail
  }
  return undefined
}

export const createRLTrainingClient = (
  baseUrl: string = RL_TRAINING_API_PREFIX,
): RLTrainingClient => ({
  validateNetwork: async (network: NetworkPayload): Promise<ValidateResult> => {
    const prefix = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
    const url = `${prefix}${VALIDATE_NETWORK_PATH}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), VALIDATE_NETWORK_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ network }),
        signal: controller.signal,
      })
      const text = await res.text()
      const body: unknown = text.length > 0 ? safeJsonParse(text) : null
      if (!res.ok) {
        return { ok: false, error: readDetail(body) ?? `${res.status} ${res.statusText}` }
      }
      return body as ValidateResult
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return {
          ok: false,
          error: `POST ${url} timed out after ${VALIDATE_NETWORK_TIMEOUT_MS}ms`,
        }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `POST ${url} failed: ${msg}` }
    } finally {
      clearTimeout(timer)
    }
  },
})

const safeJsonParse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Default client — same `/api/v1` prefix as the rest of the API layer. */
export const defaultRLTraining = createRLTrainingClient()
