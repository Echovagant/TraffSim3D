/**
 * The POI client — fetch the real-world points of interest around a map.
 *
 * The backend does the Overpass call (the public API is slow and
 * flaky, and its CORS behaviour is not worth relying on), and the
 * projection into the scene's local metres. What arrives here is ready
 * to draw: a list of POIs at scene coordinates.
 *
 * There is no key: the source is OpenStreetMap, whose data is ODbL
 * and whose coordinates are WGS84 — the same datum the scene's roads
 * are in, so the POIs need no conversion, only the projection.
 */

/** One POI, as the backend returns it (already in scene metres). */
export interface Poi {
  /** The source's id ("osm-node-123456"). */
  id: string
  /** The name — often empty (a quarter of OSM's POIs carry none). */
  name: string
  /** The tag that made it a POI ("amenity=cafe"). */
  type: string
  /** The OSM tag key ("amenity"). */
  typeCode: string
  /** The plain-language category ("餐饮"). */
  category: string
  /** The street address — usually empty in OSM. */
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
  /** The OSM tags to fetch (comma-separated). Empty = the default set. */
  tags?: string
  /** A free-text filter — only the POIs whose name contains it. */
  keywords?: string
  /** How many POIs to ask for. */
  limit?: number
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
 * Overpass is a volunteer-run public service: it answers a
 * scene-sized rectangle in 50–73 s when it is not busy (measured), and
 * it refuses outright when it is. The backend's own budget is 100 s
 * (the whole instance chain shares it), so the browser's has to be a
 * little longer. The backend caches every answer on disk, so the
 * second load of the same rectangle is instant — the first one is the
 * slow one.
 */
export const POI_TIMEOUT_MS = 120000

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
          tags: query.tags ?? '',
          keywords: query.keywords ?? '',
          limit: query.limit ?? 25,
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
