// src/infrastructure/cesium/loadOSMScene.ts
//
// Pull OSM buildings + roads from Overpass, hand the
// GeoJSON FeatureCollection directly to Cesium.GeoJsonDataSource.
//
// Why pass an object instead of a URL:
//   - Cesium's `load(url)` does an extra HTTP fetch + shows the
//     loading spinner. We already have the data — handing the
//     in-memory FeatureCollection is instant.
//   - Lets us mutate entity styles (extrudedHeight for buildings,
//     stroke color/width for roads) immediately after load, in one
//     pass.
//
// Overpass bbox format: (south, west, north, east). We use the
// same compact query templates as the MapImporterView.vue so
// users get consistent output regardless of which surface they use.

import * as Cesium from 'cesium'

export interface Bbox {
  /** South-west corner (lat, lng). */
  south: number
  /** South-west corner (lat, lng). */
  west: number
  /** North-east corner. */
  north: number
  /** North-east corner. */
  east: number
}

export interface LoadedOSMScene {
  roads: Cesium.GeoJsonDataSource
  buildings: Cesium.GeoJsonDataSource
  /** Combined feature counts for the AI Playground / status display. */
  roadCount: number
  buildingCount: number
}

// ---- Overpass query templates ----
//
// `way["highway"~"^(...)$"]["area"!="yes"]` excludes pedestrian plazas
// (which OSM tags as `area=yes`) and matches only the road classes
// TraffSim3D's renderer accepts (see shared/constants/simulation.ts).
//
// `way["building"]` and `relation["building"]` cover both standalone
// buildings and multi-polygon complexes (campus blocks, courtyards).
// `building:levels` is OSM's standard "approximate floor count" —
// multiply by 3.5m for a rough extrusion height. Buildings without
// levels default to 10m.

const overpassBuildingsQuery = (b: Bbox): string => `
[out:json][timeout:60];
(
  way["building"](${b.south},${b.west},${b.north},${b.east});
  relation["building"](${b.south},${b.west},${b.north},${b.east});
);
out body; >; out skel qt;
`

const overpassRoadsQuery = (b: Bbox): string => `
[out:json][timeout:60];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified)$"]
     ["area"!="yes"]
     (${b.south},${b.west},${b.north},${b.east});
);
out body; >; out skel qt;
`

// ---- Overpass HTTP fetcher ----
//
// We DO NOT call overpass-api.de directly from the browser:
//   1. It is slow / blocked from China (the user reported the
//      "正在从 Overpass 加载 OSM 数据..." toast staying forever).
//   2. Every page reload re-fetches the same bbox.
//
// The FastAPI backend exposes `GET /api/v1/maps/overpass`
// which forwards the query once, caches to `geojson/cache/<hash>.json`,
// and serves subsequent identical queries from disk. The frontend
// just hits our own endpoint (proxied via vite → `localhost:8000`).

const OVERPASS_PROXY_URL = '/api/v1/maps/overpass'

/** Minimal GeoJSON namespace (we only use FeatureCollection /
 *  Feature / LineString / Polygon). The full spec would pull in
 *  `@types/geojson` as a dep; for our use the duck-typed shapes are
 *  enough and avoid a 100+ kB type dependency. */
interface MinimalGeoJSON {
  type: 'FeatureCollection' | 'Feature'
  features?: MinimalFeature[]
  geometry?: { type: string; coordinates: unknown }
  properties?: Record<string, unknown>
  id?: number
}
interface MinimalFeature extends MinimalGeoJSON {
  type: 'Feature'
  geometry: { type: string; coordinates: unknown }
}

const overpassFetch = async (query: string, signal?: AbortSignal): Promise<MinimalGeoJSON> => {
  const url = `${OVERPASS_PROXY_URL}?` + new URLSearchParams({ query }).toString()
  const r = await fetch(url, { signal })
  if (!r.ok) {
    throw new Error(`Overpass proxy HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
  }
  // Our backend caches and returns the *raw* Overpass JSON
  // (`{ version, elements }`); we still need to convert it to a
  // FeatureCollection here so Cesium.GeoJsonDataSource.load can
  // accept it.
  const data = (await r.json()) as { elements?: unknown[] }
  return osmiumToFeatureCollection(data.elements ?? [])
}

/** Minimal Overpass JSON → GeoJSON FeatureCollection converter.
 *  We only handle the geometry types Cesium needs (Point, LineString,
 *  Polygon) and skip everything else (no multipolygons, no relations
 *  beyond building outlines — those are good enough for the
 *  bird's-eye basemap view). */
const osmiumToFeatureCollection = (elements: unknown[]): MinimalGeoJSON => {
  const features: MinimalFeature[] = []
  // Two-pass: collect nodes by id (for way references), then build
  // features from ways + relations.
  const nodes = new Map<number, { lat: number; lon: number }>()
  for (const el of elements as Array<{ type: string; id: number; lat?: number; lon?: number }>) {
    if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
      nodes.set(el.id, { lat: el.lat, lon: el.lon })
    }
  }
  for (const el of elements as Array<{
    type: string
    id: number
    nodes?: number[]
    tags?: Record<string, string>
  }>) {
    if (el.type !== 'way' || !el.nodes) continue
    const coords = el.nodes
      .map((nid) => nodes.get(nid))
      .filter((n): n is { lat: number; lon: number } => n !== undefined)
      .map((n) => [n.lon, n.lat])
    if (coords.length < 2) continue
    const tags = el.tags ?? {}
    const isArea = tags['area'] === 'yes'
    const geometry = isArea
      ? { type: 'Polygon', coordinates: [coords] }
      : { type: 'LineString', coordinates: coords }
    features.push({ type: 'Feature', id: el.id, properties: tags, geometry })
  }
  return { type: 'FeatureCollection', features }
}

// ---- Style helpers ----

const ROAD_COLOR = '#fbbf24' // amber, matches the toolbar's road tone
const ROAD_WIDTH_PX = 3
const BUILDING_OPACITY = 0.75
const DEFAULT_BUILDING_HEIGHT_M = 10
const METERS_PER_LEVEL = 3.5

// Classify buildings by OSM tag for visual variety.
// Each category gets a distinct hue so a bird's-eye view reads
// residential vs commercial vs public zones at a glance.
const RESIDENTIAL_TAGS = new Set([
  'residential',
  'house',
  'apartments',
  'detached',
  'semidetached_house',
  'terrace',
  'bungalow',
  'dormitory',
])
const COMMERCIAL_TAGS = new Set([
  'commercial',
  'retail',
  'office',
  'shop',
  'supermarket',
  'kiosk',
  'hotel',
  'restaurant',
  'cafe',
])
const PUBLIC_TAGS = new Set([
  'public',
  'civic',
  'school',
  'hospital',
  'church',
  'chapel',
  'mosque',
  'temple',
  'synagogue',
  'university',
  'college',
  'government',
  'library',
  'museum',
  'theatre',
  'cinema',
])
const INDUSTRIAL_TAGS = new Set(['industrial', 'warehouse', 'factory', 'manufacture'])

const COLOR_RESIDENTIAL = '#c4a882' // warm sandstone
const COLOR_COMMERCIAL = '#7890a8' // cool blue-grey
const COLOR_PUBLIC = '#88b0d0' // light steel blue
const COLOR_INDUSTRIAL = '#8a8a90' // dark neutral grey
const COLOR_DEFAULT = '#a0a0a8' // neutral grey

const getBuildingColor = (tags: Record<string, unknown> | undefined): string => {
  if (!tags) return COLOR_DEFAULT
  const buildingTag = (tags['building'] as string | undefined)?.toLowerCase() ?? ''
  if (RESIDENTIAL_TAGS.has(buildingTag)) return COLOR_RESIDENTIAL
  if (COMMERCIAL_TAGS.has(buildingTag)) return COLOR_COMMERCIAL
  if (PUBLIC_TAGS.has(buildingTag)) return COLOR_PUBLIC
  if (INDUSTRIAL_TAGS.has(buildingTag)) return COLOR_INDUSTRIAL
  // amenity tag as fallback for public buildings
  const amenity = (tags['amenity'] as string | undefined)?.toLowerCase() ?? ''
  if (amenity) return COLOR_PUBLIC
  return COLOR_DEFAULT
}

/** Main entry: load roads + buildings, attach styled GeoJsonDataSources
 *  to the Cesium viewer, return counts for UI display. */
export const loadOSMScene = async (
  viewer: Cesium.Viewer,
  bbox: Bbox,
  abortSignal?: AbortSignal,
): Promise<LoadedOSMScene> => {
  // Fetch in parallel — typical Overpass round-trip is 1-3s.
  const [roadsGeo, buildingsGeo] = await Promise.all([
    overpassFetch(overpassRoadsQuery(bbox), abortSignal),
    overpassFetch(overpassBuildingsQuery(bbox), abortSignal),
  ])

  // Roads: polyline clamped to ground. Cesium's clampToGround flag
  // is the GIS-standard way to render roads without z-fighting on
  // terrain (we don't use terrain here yet, but this is forward-compat).
  const roads = await Cesium.GeoJsonDataSource.load(roadsGeo, {
    clampToGround: true,
    stroke: Cesium.Color.fromCssColorString(ROAD_COLOR),
    strokeWidth: ROAD_WIDTH_PX,
  })
  viewer.dataSources.add(roads)

  // Buildings: extruded polygons. We post-process to set heights
  // and a violet semi-transparent material so the road network
  // underneath stays visible through them.
  const buildings = await Cesium.GeoJsonDataSource.load(buildingsGeo, {
    clampToGround: true,
  })
  for (const entity of buildings.entities.values) {
    if (!entity.polygon) continue
    const props = entity.properties
    const getTag = (key: string): string | undefined => {
      const p = props?.[key as keyof typeof props]
      if (p && typeof (p as any).getValue === 'function')
        return (p as any).getValue() as string | undefined
      return p as string | undefined
    }
    const levelsStr = getTag('building:levels')
    const heightStr = getTag('height')
    const height = heightStr
      ? parseFloat(heightStr)
      : levelsStr
        ? parseFloat(levelsStr) * METERS_PER_LEVEL
        : DEFAULT_BUILDING_HEIGHT_M
    entity.polygon.extrudedHeight = new Cesium.ConstantProperty(
      Number.isFinite(height) ? height : DEFAULT_BUILDING_HEIGHT_M,
    )
    const color = getBuildingColor({
      building: getTag('building'),
      amenity: getTag('amenity'),
    })
    entity.polygon.material = new Cesium.ColorMaterialProperty(
      Cesium.Color.fromCssColorString(color).withAlpha(BUILDING_OPACITY),
    )
    entity.polygon.outline = new Cesium.ConstantProperty(false)
    entity.polygon.closeTop = new Cesium.ConstantProperty(true)
    entity.polygon.closeBottom = new Cesium.ConstantProperty(true)
  }
  viewer.dataSources.add(buildings)

  return {
    roads,
    buildings,
    roadCount: roads.entities.values.length,
    buildingCount: buildings.entities.values.length,
  }
}

/** Default bbox around 天安门广场 (~2km × 2km). Same as the user's
 *  prior SmartCity.vue project. */
export const DEFAULT_BBOX: Bbox = {
  south: 39.885,
  west: 116.38,
  north: 39.925,
  east: 116.42,
}
