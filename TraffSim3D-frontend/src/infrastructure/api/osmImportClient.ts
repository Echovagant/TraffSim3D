/**
 * OSM import API helpers — bbox clipping query parameters.
 *
 * The backend `POST /api/v1/maps/parse-osm` and `/api/v1/maps/parse-pbf`
 * endpoints accept four optional query params that clip the parsed network to
 * an area of interest, in `(south, west, north, east)` order — the same order
 * Overpass QL uses.
 *
 * Two things this file exists to get right:
 *
 * 1. **Omitting the bbox must stay omission.** `formatOsmBBoxQuery(null)`
 *    returns `''`, so the request URL is byte-identical to the pre-bbox one.
 *    The e2e suites stub the bare parse-pbf URL with an exact glob, which a
 *    `?south=…` suffix would stop matching.
 * 2. **The 0.5° default is a memory cap, not a crop.** Users must never read
 *    "no bbox" as "nothing was clipped". `describeOsmClip(null)` says so
 *    explicitly, and MapLab renders it on screen.
 *
 * Validation mirrors the backend's rules so the UI can reject a bad box before
 * spending an upload on it. The backend still validates independently — this is
 * a convenience, never the enforcement point.
 */

/** Clip box in `(south, west, north, east)` degrees — Overpass QL order. */
export interface OsmBBox {
  south: number
  west: number
  north: number
  east: number
}

/** Query param order is significant in the emitted URL; matches Overpass QL. */
const BBOX_PARAM_ORDER: ReadonlyArray<keyof OsmBBox> = ['south', 'west', 'north', 'east']

/**
 * Backend memory-safety cap in degrees (~55 km at mid-latitudes), mirrored from
 * `osm_parser.MAX_BBOX_DEG` for display purposes. It is NOT a scene-sized crop.
 */
export const OSM_DEFAULT_CLIP_DEG = 0.5

/**
 * What the backend does when no bbox is supplied: drop nodes further than
 * `MAX_BBOX_DEG` from the data centroid. Used as the "unspecified" echo.
 */
export const OSM_UNSPECIFIED_CLIP_NOTE =
  `未指定裁剪边界 — 使用 ${OSM_DEFAULT_CLIP_DEG}° 内存安全上限（` +
  '丢弃距数据中心超过该半径的远点，并非按仿真区域裁剪）'

/** Return an error message, or `null` when `bbox` is acceptable. */
export const validateOsmBBox = (bbox: OsmBBox): string | null => {
  const { south, west, north, east } = bbox
  for (const key of BBOX_PARAM_ORDER) {
    const value = bbox[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `${key} 必须是有效数字`
    }
  }
  if (south < -90 || north > 90 || south > 90 || north < -90) {
    return '纬度必须在 -90 ~ 90 之间 (south / north)'
  }
  if (west < -180 || east > 180 || west > 180 || east < -180) {
    return '经度必须在 -180 ~ 180 之间 (west / east)'
  }
  if (south > north) {
    return `south (${south}) 必须 ≤ north (${north})`
  }
  if (west > east) {
    return `west (${west}) 必须 ≤ east (${east})`
  }
  return null
}

/**
 * The coordinate datum the FILE's coordinates are in. OSM speaks WGS84;
 * Chinese map tooling exports GCJ-02 (高德) or BD-09 (百度) — importing
 * those without conversion lands the map 300-600 m off in mainland
 * China.
 */
export type OsmCoordDatum = 'wgs84' | 'gcj02' | 'bd09'

export const OSM_COORD_DATUMS: ReadonlyArray<{ value: OsmCoordDatum; label: string }> = [
  { value: 'wgs84', label: 'WGS84 (OSM 默认)' },
  { value: 'gcj02', label: 'GCJ-02 (高德)' },
  { value: 'bd09', label: 'BD-09 (百度)' },
]

/**
 * Build the query string for a parse request. Returns `''` when `bbox` is
 * `null`, which is what keeps the no-clip request identical to the old one.
 */
export const formatOsmBBoxQuery = (bbox: OsmBBox | null): string => {
  if (bbox === null) return ''
  const params = BBOX_PARAM_ORDER.map((key) => `${key}=${encodeURIComponent(bbox[key])}`)
  return `?${params.join('&')}`
}

/**
 * The `coord` query param. The default (`wgs84`) is OMITTED — a request
 * without the param and a request with `coord=wgs84` must be the same
 * URL, so the no-datum request stays identical to the historical one.
 */
export const formatOsmCoordQuery = (datum: OsmCoordDatum): string =>
  datum === 'wgs84' ? '' : `&coord=${encodeURIComponent(datum)}`

/**
 * Human-readable echo of the clip that is actually in effect, shown next to the
 * inputs so the user is never left guessing whether anything was cropped.
 */
export const describeOsmClip = (bbox: OsmBBox | null): string => {
  if (bbox === null) return OSM_UNSPECIFIED_CLIP_NOTE
  const fmt = (value: number): string => String(value)
  return (
    `裁剪中 — south ${fmt(bbox.south)}, west ${fmt(bbox.west)}, ` +
    `north ${fmt(bbox.north)}, east ${fmt(bbox.east)}`
  )
}

/** Append the optional bbox query to a parse endpoint URL. */
export const withOsmBBoxQuery = (endpoint: string, bbox: OsmBBox | null): string =>
  `${endpoint}${formatOsmBBoxQuery(bbox)}`

/**
 * Append the optional bbox and datum queries to a parse endpoint URL.
 * `datum` defaults to `wgs84`, which adds nothing — the historical URLs
 * are preserved byte for byte.
 */
export const withOsmQuery = (
  endpoint: string,
  bbox: OsmBBox | null,
  datum: OsmCoordDatum = 'wgs84',
): string => {
  const base = withOsmBBoxQuery(endpoint, bbox)
  if (base === '') return ''
  return `${base}${formatOsmCoordQuery(datum)}`
}
