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
import { OSM_METERS_PER_DEGREE_LAT } from '@infrastructure/api/osmNetworkAdapter'

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

/**
 * Read a design token from the document root.
 *
 * The 3D city and the dashboard must show the SAME palette — a theme
 * switch has to move the road network and the panels together. The
 * palette therefore lives in CSS (`interfaces/theme/tokens.css`) and
 * the scene reads the resolved values (`getComputedStyle` resolves
 * `color-mix()` to a concrete colour, so the scene gets exactly what
 * the screen shows).
 */
const token = (name: string, fallback: string): string => {
  if (typeof document === 'undefined') return fallback
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return raw.length > 0 ? raw : fallback
}

const ROAD_COLOR = () => token('--dc-road-main', '#2b5fa8')
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

// Building tones come from the theme tokens too — the night palette
// wants dark blocks with a cool edge, not the old daylight sandstones.
const COLOR_RESIDENTIAL = () => token('--dc-building-residential', '#1b2c4a')
const COLOR_COMMERCIAL = () => token('--dc-building-commercial', '#20395c')
const COLOR_PUBLIC = () => token('--dc-building-public', '#264a6b')
const COLOR_INDUSTRIAL = () => token('--dc-building-industrial', '#182234')
const COLOR_DEFAULT = () => token('--dc-building', '#16243c')

const getBuildingColor = (tags: Record<string, unknown> | undefined): string => {
  if (!tags) return COLOR_DEFAULT()
  const buildingTag = (tags['building'] as string | undefined)?.toLowerCase() ?? ''
  if (RESIDENTIAL_TAGS.has(buildingTag)) return COLOR_RESIDENTIAL()
  if (COMMERCIAL_TAGS.has(buildingTag)) return COLOR_COMMERCIAL()
  if (PUBLIC_TAGS.has(buildingTag)) return COLOR_PUBLIC()
  if (INDUSTRIAL_TAGS.has(buildingTag)) return COLOR_INDUSTRIAL()
  // amenity tag as fallback for public buildings
  const amenity = (tags['amenity'] as string | undefined)?.toLowerCase() ?? ''
  if (amenity) return COLOR_PUBLIC()
  return COLOR_DEFAULT()
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
    stroke: Cesium.Color.fromCssColorString(ROAD_COLOR()),
    strokeWidth: ROAD_WIDTH_PX,
  })
  viewer.dataSources.add(roads)

  // Buildings: extruded polygons. We post-process to set heights
  // and a violet semi-transparent material so the road network
  // underneath stays visible through them.
  const buildings = await Cesium.GeoJsonDataSource.load(buildingsGeo, {
    clampToGround: true,
    // The DEFAULT outline colour of a GeoJson polygon is Cesium's own
    // yellow — and on a ground-clamped polygon the outline survives
    // every per-entity attempt to switch it off (measured 2026-11-05:
    // setting `outline = false`, `outlineWidth = 0` and the theme's
    // outline colour per entity all left 3014 yellow footprints; only
    // 5 of 3014 entities even kept the per-entity value, because
    // adding the datasource to the viewer rewrites the polygon
    // graphics). The styles that DO stick are the ones applied at
    // creation, so the outline and the fill are set here.
    stroke: Cesium.Color.fromCssColorString(token('--dc-building-edge', '#1e40af')),
    fill: Cesium.Color.fromCssColorString(token('--dc-building', '#16243c')).withAlpha(
      BUILDING_OPACITY,
    ),
  })
  /**
   * Style one building entity.
   *
   * The order matters, and it cost two measured rounds to get right
   * (2026-11-05): adding a ground-clamped datasource to the viewer
   * REWRITES the entities' polygon graphics, so a style applied
   * before the add is thrown away — measured: 5 of 3014 buildings kept
   * it, the other 3009 came back with Cesium's DEFAULT yellow outline,
   * which on the night map was the loudest thing on screen. So the
   * style is applied AFTER the add, and `entityAdded` covers the
   * entities that arrive later.
   */
  const styleBuilding = (entity: Cesium.Entity): void => {
    if (!entity.polygon) return
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
    // The outline is the one thing the per-entity flags do NOT settle:
    // on a ground-clamped polygon Cesium still draws the footprint with
    // `outlineColor` (its default is YELLOW). So the colour is set to
    // the theme's edge tone and the width to zero: whichever path
    // draws it, it is now dark.
    entity.polygon.outline = new Cesium.ConstantProperty(false)
    entity.polygon.outlineWidth = new Cesium.ConstantProperty(0)
    entity.polygon.outlineColor = new Cesium.ColorMaterialProperty(
      Cesium.Color.fromCssColorString(token('--dc-building-edge', '#1e40af')),
    )
    entity.polygon.closeTop = new Cesium.ConstantProperty(true)
    entity.polygon.closeBottom = new Cesium.ConstantProperty(true)
  }
  viewer.dataSources.add(buildings)
  for (const entity of buildings.entities.values) styleBuilding(entity)
  // Entities that arrive later (the datasource keeps creating them for
  // a while) get the same style — the event is not in this Cesium
  // build's typings, hence the cast.
  const addable = buildings as unknown as {
    entityAdded?: { addEventListener: (fn: (entity: Cesium.Entity) => void) => void }
  }
  addable.entityAdded?.addEventListener((entity) => styleBuilding(entity))

  return {
    roads,
    buildings,
    roadCount: roads.entities.values.length,
    buildingCount: buildings.entities.values.length,
  }
}

/**
 * Default bbox around **深圳福田中心** (~4.4 km × 4.1 km).
 *
 * It is the city the project's own map data comes from
 * (`geojson/福田中心(深圳).osm`), so the Smart City view, the POI
 * layer and the imported maps are all about the same place.
 */
export const DEFAULT_BBOX: Bbox = {
  south: 22.52297,
  west: 114.04865,
  north: 22.56297,
  east: 114.08865,
}

/**
 * Build a bbox (in degrees) around a geographic origin, sized in metres.
 *
 * Used to load the basemap of an *imported* city: the imported OSM
 * network carries its own projection origin (`originLat`/`originLon`),
 * so the basemap has to be fetched around that point instead of the
 * hard-coded 天安门 area.
 *
 * The metre→degree conversion mirrors the backend's flat projection
 * (`osm_parser.py::_project_nodes`): 111000 m per degree of latitude,
 * the same factor scaled by cos(latitude) for longitude.
 */
export const bboxAround = (lat: number, lon: number, halfMeters: number): Bbox => {
  const half = Math.max(1, halfMeters)
  const halfLat = half / OSM_METERS_PER_DEGREE_LAT
  const cosLat = Math.max(0.05, Math.cos((lat * Math.PI) / 180))
  const halfLon = half / (OSM_METERS_PER_DEGREE_LAT * cosLat)
  return {
    south: lat - halfLat,
    west: lon - halfLon,
    north: lat + halfLat,
    east: lon + halfLon,
  }
}
