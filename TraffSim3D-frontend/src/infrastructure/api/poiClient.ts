/**
 * The POI client — fetch the real-world points of interest around a map.
 *
 * The backend does the provider call (AMap's Web-service API needs a
 * key, and the key belongs to whoever runs the deployment), the datum
 * conversion (the provider's data is GCJ-02) and the projection into
 * the scene's local metres. What arrives here is ready to draw: a list
 * of POIs at scene coordinates.
 */

/** One POI, as the backend returns it (already in scene metres). */
export interface Poi {
  /** The provider's id. */
  id: string
  /** The name. */
  name: string
  /** The provider's full type path ("餐饮服务;咖啡厅"). */
  type: string
  /** The provider's type code. */
  typeCode: string
  /** The plain-language category ("餐饮"). */
  category: string
  /** The street address. */
  address: string
  /** The WGS84 longitude. */
  lon: number
  /** The WGS84 latitude. */
  lat: number
  /** The scene position: metres east of the origin. */
  x: number
  /** The scene position: metres north of the origin (the scene's z). */
  z: number
}

/** What to ask for. */
export interface PoiQuery {
  /** The rectangle, in WGS84 degrees. */
  south: number
  west: number
  north: number
  east: number
  /** The scene's projection origin. */
  originLat: number
  originLon: number
  /** The provider's category filter (its own type codes). */
  types?: string
  /** A free-text filter. */
  keywords?: string
  /** How many POIs to ask for (the provider's page size is 25). */
  limit?: number
  /** The provider's Web-service key. Empty = use the deployment's. */
  key?: string
}

export interface PoiResponse {
  source: string
  count: number
  pois: Poi[]
}

export interface PoiClient {
  /** POST /maps/poi → the POIs inside the rectangle.
   *  Never throws: a provider refusal comes back as an error message. */
  fetchPois(query: PoiQuery): Promise<{ ok: true; pois: Poi[] } | { ok: false; error: string }>
}

/** The POI endpoint, relative to the API prefix. */
export const POI_PATH = '/maps/poi'

/**
 * How long the request may take, in milliseconds.
 *
 * The provider is a third party on the far side of the network: the
 * backend's own timeout is 15 s, so the browser's must be a little
 * longer — but not unbounded (a hung provider must not hang the page).
 */
export const POI_TIMEOUT_MS = 20000

/**
 * The rectangle around a scene, in degrees.
 *
 * The scene's roads are in local metres around its origin; the POI
 * provider wants degrees. The conversion is the parser's own inverse:
 * 111000 m per degree of latitude, and the same for longitude scaled
 * by `cos(lat)`.
 */
export const boundsToDegrees = (
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  origin: { lat: number; lon: number },
): { south: number; west: number; north: number; east: number } => {
  const metresPerDegreeLat = 111000
  const metresPerDegreeLon = 111000 * Math.cos((origin.lat * Math.PI) / 180)
  const south = origin.lat + Math.min(bounds.minZ, bounds.maxZ) / metresPerDegreeLat
  const north = origin.lat + Math.max(bounds.minZ, bounds.maxZ) / metresPerDegreeLat
  const west = origin.lon + Math.min(bounds.minX, bounds.maxX) / metresPerDegreeLon
  const east = origin.lon + Math.max(bounds.minX, bounds.maxX) / metresPerDegreeLon
  return { south, west, north, east }
}

export const createPoiClient = (baseUrl = '/api/v1'): PoiClient => ({
  fetchPois: async (query) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), POI_TIMEOUT_MS)
    try {
      const response = await fetch(`${baseUrl}${POI_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          south: query.south,
          west: query.west,
          north: query.north,
          east: query.east,
          origin_lat: query.originLat,
          origin_lon: query.originLon,
          types: query.types ?? '',
          keywords: query.keywords ?? '',
          limit: query.limit ?? 25,
          key: query.key ?? '',
        }),
        signal: controller.signal,
      })
      const text = await response.text()
      let body: unknown = null
      try {
        body = text.length > 0 ? JSON.parse(text) : null
      } catch {
        body = null
      }
      if (!response.ok) {
        const detail =
          body && typeof body === 'object' && 'detail' in body
            ? String((body as { detail: unknown }).detail)
            : `${response.status} ${response.statusText}`
        return { ok: false, error: detail }
      }
      const pois = (body as PoiResponse | null)?.pois ?? []
      return { ok: true, pois }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { ok: false, error: `the POI request timed out after ${POI_TIMEOUT_MS}ms` }
      }
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message }
    } finally {
      clearTimeout(timer)
    }
  },
})

/** The default client — same `/api/v1` prefix as the rest of the API layer. */
export const defaultPoiClient = createPoiClient()
