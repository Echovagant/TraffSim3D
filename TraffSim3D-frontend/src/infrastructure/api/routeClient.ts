/**
 * Route planning client — `POST /api/v1/routes/plan`.
 *
 * The backend (`app/api/v1/routes.py`) answers one question: given a
 * scene's road network and the two ends of a route, what is the
 * cheapest sequence of roads between them? It uses the **directed**
 * graph over the network's waypoints, so a one-way street cannot be
 * driven against its traffic, and the returned legs say which way each
 * road is entered.
 *
 * Why this module issues its own request
 * ---------------------------------------
 * The shared `createHttpClient` (`httpClient.ts`) exposes `get` only —
 * it is deliberately a read-only client. A route plan is a POST (it
 * carries the network), so this module performs the request itself
 * against the same `/api/v1` prefix the Vite dev proxy forwards to
 * FastAPI — the same shape as `rlTrainingClient.ts`.
 */

/** One end of a planned route. */
export interface RouteEndpoint {
  /** A junction of the network. */
  junctionId?: string
  /** A road of the network. */
  roadId?: string
  /**
   * Which end of that road the traveller is heading for: `forward` is
   * the road's start→end direction, `backward` the opposite.
   */
  direction?: 'forward' | 'backward'
}

/** One road traversal of the route. */
export interface RouteLeg {
  road_id: string
  from: { x: number; y: number; z: number }
  to: { x: number; y: number; z: number }
  cost_m: number
}

/** The backend's answer. */
export interface RoutePlanResponse {
  /** False when the two ends are not connected. */
  found: boolean
  /** The road ids of the legs, in order. */
  roads: string[]
  legs: RouteLeg[]
  /** The route's total length in metres. */
  cost_m: number
  start_node: string
  end_node: string
}

/** The scene network, in the shape the backend reads. */
export interface RouteNetworkPayload {
  roads: unknown[]
  intersections: unknown[]
  vehicles: unknown[]
  spawnPoints?: unknown[]
}

export interface RouteClient {
  /** POST /routes/plan → the cheapest route between the two ends.
   *  Never throws: a backend error comes back as `{ok: false, error}`. */
  planRoute(
    network: RouteNetworkPayload,
    start: RouteEndpoint,
    end: RouteEndpoint,
  ): Promise<{ ok: true; route: RoutePlanResponse } | { ok: false; error: string }>
}

/** Path of the route endpoint, relative to the API prefix. */
export const ROUTE_PLAN_PATH = '/routes/plan'

/** Default API prefix — the Vite dev proxy forwards `/api/v1/*` to FastAPI. */
export const ROUTE_API_PREFIX = '/api/v1'

/**
 * How long a route plan may take, in milliseconds.
 *
 * The endpoint builds a graph over the network and runs A* over it. On
 * the biggest scene in the product (a 5 km OSM district, ~800 nodes) a
 * plan is a fraction of a millisecond; the budget is generous because
 * the first request after a backend start also pays the import.
 */
export const ROUTE_PLAN_TIMEOUT_MS = 10000

const readDetail = (body: unknown): string | undefined => {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail?: unknown }).detail
    if (typeof detail === 'string') return detail
  }
  return undefined
}

const safeJsonParse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export const createRouteClient = (baseUrl: string = ROUTE_API_PREFIX): RouteClient => ({
  planRoute: async (network, start, end) => {
    const prefix = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
    const url = `${prefix}${ROUTE_PLAN_PATH}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ROUTE_PLAN_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          network,
          start: {
            ...(start.junctionId ? { junction_id: start.junctionId } : {}),
            ...(start.roadId ? { road_id: start.roadId } : {}),
            ...(start.direction ? { direction: start.direction } : {}),
          },
          end: {
            ...(end.junctionId ? { junction_id: end.junctionId } : {}),
            ...(end.roadId ? { road_id: end.roadId } : {}),
            ...(end.direction ? { direction: end.direction } : {}),
          },
        }),
        signal: controller.signal,
      })
      const text = await res.text()
      const body: unknown = text.length > 0 ? safeJsonParse(text) : null
      if (!res.ok) {
        return { ok: false, error: readDetail(body) ?? `${res.status} ${res.statusText}` }
      }
      return { ok: true, route: body as RoutePlanResponse }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return {
          ok: false,
          error: `POST ${url} timed out after ${ROUTE_PLAN_TIMEOUT_MS}ms`,
        }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `POST ${url} failed: ${msg}` }
    } finally {
      clearTimeout(timer)
    }
  },
})

/** Default client — same `/api/v1` prefix as the rest of the API layer. */
export const defaultRouteClient = createRouteClient()
