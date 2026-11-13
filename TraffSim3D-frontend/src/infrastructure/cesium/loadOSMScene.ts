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
import type { GeoOrigin, RoadNetwork } from '@domain/entities/RoadNetwork'
import { roadWidthM, vehicleFitsRoad, roadHeightLimitM } from '@domain/services/roadAccess'

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

export interface LoadedOSMBuildings {
  buildings: Cesium.GeoJsonDataSource
  /** How many buildings were drawn. */
  buildingCount: number
  /** Re-apply the theme's building colours (a theme switch changes them). */
  restyle: () => void
}

/** The simulated network's roads, drawn on the basemap as ribbons. */
export interface LoadedNetworkRoads {
  /** The entity collection the ribbons and barriers live in. */
  entities: Cesium.EntityCollection
  /** How many road ribbons were drawn. */
  roadCount: number
  /** How many roads are barred to cars (too narrow — see roadAccess). */
  barredCount: number
  /** Re-apply the theme's road colours (a theme switch changes them). */
  restyle: () => void
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
    // A CLOSED way is an area — that is the OSM convention, and for the
    // building query it is THE rule: a building footprint is a closed
    // way, and almost none of them carry `area=yes` (the `building` tag
    // itself implies the area). Testing only `area === 'yes'` turned
    // 99% of the buildings into LineStrings — the city rendered as
    // white outlines with nothing inside them (measured on the Futian
    // extract: 396 of 400 sampled building entities were polylines).
    // `area=no` is the explicit opt-out.
    const closed =
      coords.length >= 4 &&
      coords[0]![0] === coords[coords.length - 1]![0] &&
      coords[0]![1] === coords[coords.length - 1]![1]
    const isArea = closed && tags['area'] !== 'no'
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

const BUILDING_OPACITY = 0.75
const DEFAULT_BUILDING_HEIGHT_M = 10
const METERS_PER_LEVEL = 3.5

/**
 * The store's local metric frame → WGS84 degrees.
 *
 * The parser's flat projection is
 *   `x = (lon - originLon) · 111000 · cos(lat)`, `z = (lat - originLat) · 111000`
 * — north POSITIVE on z — but the adapter flips z on the way into the
 * store (`toAppFrame`, see `OSM_PAYLOAD_NORTH_IS_POSITIVE_Z`): the app
 * frame is north NEGATIVE, the same convention the camera sync uses
 * (`three.z = -north`). The store's roads therefore carry north-negative
 * z, and the inverse has to negate it back:
 *   `lat = originLat − z / 111000`.
 *
 * Getting this sign wrong mirrors the whole drawn city north-south
 * about the projection origin — the roads land on the far side of the
 * city while the vehicles (rendered in the app frame by Three.js) stay
 * on the true side. That was the "cars are not on the network" bug.
 */
export const localToLngLat = (
  origin: GeoOrigin,
  x: number,
  z: number,
): { lng: number; lat: number } => {
  const cosLat = Math.max(0.05, Math.cos((origin.lat * Math.PI) / 180))
  return {
    lng: origin.lon + x / (OSM_METERS_PER_DEGREE_LAT * cosLat),
    lat: origin.lat - z / OSM_METERS_PER_DEGREE_LAT,
  }
}

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

/**
 * Load the city BLOCKS (buildings) onto the basemap.
 *
 * Only the buildings come from Overpass. The ROADS are the simulated
 * network's own waypoints (see `loadNetworkRoads`) — drawing a second,
 * independent road layer on top of the same rectangle would put two
 * slightly different sets of lines under the cars, and the cars would
 * sit on neither of them.
 */
export const loadOSMBuildings = async (
  viewer: Cesium.Viewer,
  bbox: Bbox,
  abortSignal?: AbortSignal,
): Promise<LoadedOSMBuildings> => {
  const buildingsGeo = await overpassFetch(overpassBuildingsQuery(bbox), abortSignal)

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

  /**
   * Re-apply the theme's building colours.
   *
   * The datasource bakes the colours in at creation; a theme switch has
   * to reach the entities themselves. The outline colour is included —
   * it is the one style that survives every per-entity reset.
   */
  const restyle = (): void => {
    for (const entity of buildings.entities.values) {
      if (!entity.polygon) continue
      const props = entity.properties
      const getTag = (key: string): string | undefined => {
        const p = props?.[key as keyof typeof props]
        if (p && typeof (p as any).getValue === 'function')
          return (p as any).getValue() as string | undefined
        return p as string | undefined
      }
      const color = getBuildingColor({
        building: getTag('building'),
        amenity: getTag('amenity'),
      })
      entity.polygon.material = new Cesium.ColorMaterialProperty(
        Cesium.Color.fromCssColorString(color).withAlpha(BUILDING_OPACITY),
      )
      entity.polygon.outlineColor = new Cesium.ColorMaterialProperty(
        Cesium.Color.fromCssColorString(token('--dc-building-edge', '#1e40af')),
      )
    }
  }

  return {
    buildings,
    buildingCount: buildings.entities.values.length,
    restyle,
  }
}

/**
 * Draw the **simulated** network's own roads on the basemap.
 *
 * Why not the Overpass roads: until now the picture and the simulation
 * were two independent readings of the same city — the Overpass snapshot
 * for the vector layer, the OSM file for the cars. They agree roughly
 * and disagree exactly where it shows: a car drove along a street the
 * picture did not draw, because the two came from two different
 * snapshots of the same place.
 *
 * Drawing the network's own waypoints removes the second source of
 * truth. The ribbon under the car IS the road the car drives on — not
 * an approximation of it.
 *
 * The roads are drawn as CORRIDOR PRIMITIVES, not lines: a corridor has
 * real width (`roadWidthM` — lane count × the class's lane metres), a
 * real opaque material, and it sits IN the white model between the
 * matte buildings. The buildings render at 75% alpha, the road surface
 * at 100% — the transparency is what separates the two materials in the
 * clay theme. A road too narrow for a car (`vehicleFitsRoad` says no)
 * is drawn darker and blocked with a barrier at its entrance: the
 * simulation refuses to spawn or turn a car into it, and the picture
 * says why.
 *
 * The projection is the flat local frame the parser used:
 * `x = (lon - originLon) · 111000 · cos(lat)`, `z = (lat - originLat) · 111000`
 * (north-positive, see `OSM_PAYLOAD_NORTH_IS_POSITIVE_Z`). This inverts
 * it back to degrees.
 */
/** The road's two ends, each with the next point along the polyline. */
const roadEnds = (
  points: ReadonlyArray<{ x: number; y: number; z: number }>,
): Array<{
  at: { x: number; y: number; z: number }
  next: { x: number; y: number; z: number }
}> => {
  if (points.length < 2) return []
  return [
    { at: points[0]!, next: points[1]! },
    { at: points[points.length - 1]!, next: points[points.length - 2]! },
  ]
}

/**
 * The normal of the end segment, in the local frame.
 *
 * The bar and the gantry span the lane ON the normal, so they sit
 * across the road whatever its heading is.
 */
const endNormal = (
  at: { x: number; y: number; z: number },
  next: { x: number; y: number; z: number },
): { nx: number; nz: number } => {
  const dx = next.x - at.x
  const dz = next.z - at.z
  const segLen = Math.hypot(dx, dz) || 1
  return { nx: dz / segLen, nz: -dx / segLen }
}

/**
 * The city view draws these ribbons UNDER a satellite basemap. The
 * theme's asphalt is tuned for the editor's dark ground, where it is
 * the brightest thing on screen; over imagery it is darker than the
 * streets it is meant to describe — the network vanished at bird's-eye
 * and the cars looked like they were floating across blocks. Brighten
 * it here, once, for this view only (the editor keeps the token).
 */
const CITY_ROAD_BRIGHTEN = 0.45
const cityAsphalt = (css: string): Cesium.Color =>
  Cesium.Color.fromCssColorString(css).brighten(CITY_ROAD_BRIGHTEN, new Cesium.Color())

export const loadNetworkRoads = async (
  viewer: Cesium.Viewer,
  network: RoadNetwork,
  origin: GeoOrigin | null,
): Promise<LoadedNetworkRoads> => {
  const empty: LoadedNetworkRoads = {
    entities: viewer.entities,
    roadCount: 0,
    barredCount: 0,
    restyle: () => undefined,
  }
  // Without an anchor there is no way to place the roads on the globe.
  if (!origin) return empty
  if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lon)) return empty

  const carto = (p: { x: number; y: number; z: number }): Cesium.Cartesian3 => {
    const ll = localToLngLat(origin, p.x, p.z)
    return Cesium.Cartesian3.fromDegrees(ll.lng, ll.lat, Number.isFinite(p.y) ? p.y : 0)
  }

  const collection = new Cesium.CustomDataSource('sim-roads')
  viewer.dataSources.add(collection)
  let roadCount = 0
  let barredCount = 0

  for (const road of Object.values(network.roads)) {
    const points =
      road.waypoints && road.waypoints.length >= 2 ? road.waypoints : [road.startNode, road.endNode]
    const positions = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.z)).map(carto)
    if (positions.length < 2) continue
    const fits = vehicleFitsRoad(road, 'car')
    if (!fits) barredCount += 1
    roadCount += 1
    collection.entities.add({
      corridor: {
        positions,
        // The width the domain agrees on — the same number the spawn
        // and turn decisions use, so a drawn lane is a drivable lane.
        width: roadWidthM(road),
        height: 0.15,
        material: new Cesium.ColorMaterialProperty(
          cityAsphalt(
            fits ? token('--dc-road-main', '#3d4653') : token('--dc-road-local', '#2a323c'),
          ),
        ),
        outline: false,
      },
      properties: { access: fits ? 'road' : 'barred' },
    })

    // The HEIGHT limit of this road, when the map states one (the
    // 春风隧道 tunnel is signed 3.5 m). It is drawn as a GANTRY: a
    // portal whose cross-beam sits AT the limit height, with the
    // number on it — so the picture says "this is how low it is"
    // instead of merely "something is forbidden here". A bus does not
    // fit under it; the cars do, so the road itself is NOT drawn
    // barred (only the vehicles that do not fit are kept off it).
    const heightLimit = roadHeightLimitM(road)
    if (heightLimit !== null) {
      const half = roadWidthM(road) / 2
      for (const { at, next } of roadEnds(points)) {
        const junction = Object.values(network.intersections).find(
          (i) =>
            i.connectedRoads.includes(road.id) &&
            Math.hypot(i.position.x - at.x, i.position.z - at.z) < 8,
        )
        if (!junction) continue
        // Only where a car could actually turn in — a tunnel mouth in
        // the middle of nowhere needs no sign.
        const hasDrivableExit = junction.connectedRoads.some(
          (id) => id !== road.id && network.roads[id] && vehicleFitsRoad(network.roads[id]!, 'car'),
        )
        if (!hasDrivableExit) continue
        const { nx, nz } = endNormal(at, next)
        const post = (side: number): Cesium.Cartesian3 => {
          const ll = localToLngLat(origin, at.x + nx * side, at.z + nz * side)
          // The posts stand on the ground and reach the limit height.
          return Cesium.Cartesian3.fromDegrees(ll.lng, ll.lat, heightLimit / 2)
        }
        const beam = (side: number): Cesium.Cartesian3 => {
          const ll = localToLngLat(origin, at.x + nx * side, at.z + nz * side)
          return Cesium.Cartesian3.fromDegrees(ll.lng, ll.lat, heightLimit)
        }
        // The cross-beam, AT the limit height.
        collection.entities.add({
          corridor: {
            positions: [beam(-half), beam(half)],
            width: 0.18,
            height: 0.18,
            material: new Cesium.ColorMaterialProperty(
              Cesium.Color.fromCssColorString(token('--dc-warning', '#f59e0b')),
            ),
          },
          properties: { access: 'gantry' },
        })
        // The two posts.
        for (const side of [-half, half]) {
          collection.entities.add({
            position: post(side),
            cylinder: {
              length: heightLimit,
              topRadius: 0.08,
              bottomRadius: 0.08,
              material: new Cesium.ColorMaterialProperty(
                Cesium.Color.fromCssColorString(token('--dc-warning', '#f59e0b')),
              ),
            },
            properties: { access: 'gantry' },
          })
        }
        // The number: "3.5 m", on the beam.
        const labelPoint = (): Cesium.Cartesian3 => {
          const ll = localToLngLat(origin, at.x, at.z)
          return Cesium.Cartesian3.fromDegrees(ll.lng, ll.lat, heightLimit + 0.45)
        }
        collection.entities.add({
          position: labelPoint(),
          label: {
            text: `${heightLimit.toFixed(1)} m`,
            font: '600 15px system-ui, sans-serif',
            fillColor: Cesium.Color.fromCssColorString(token('--dc-warning', '#f59e0b')),
            outlineColor: Cesium.Color.fromCssColorString('#0b1220'),
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          properties: { access: 'gantry' },
        })
      }
    }

    if (fits) continue
    // Barriers at every entrance a car could actually TRY: the road's
    // endpoints that meet a junction which also connects a drivable
    // road (a barred lane ending in the middle of nowhere gets none —
    // nobody turns into it from there). The bar spans the lane on the
    // END SEGMENT's normal: a short corridor, which fits any heading —
    // a box could not rotate to match, and the old longitude-offset
    // version skewed across every road that does not run east-west.
    const ends: Array<{
      at: { x: number; y: number; z: number }
      next: { x: number; y: number; z: number }
    }> = []
    if (points.length >= 2) {
      ends.push({ at: points[0]!, next: points[1]! })
      ends.push({ at: points[points.length - 1]!, next: points[points.length - 2]! })
    }
    const half = roadWidthM(road) / 2
    for (const { at, next } of ends) {
      const junction = Object.values(network.intersections).find(
        (i) =>
          i.connectedRoads.includes(road.id) &&
          Math.hypot(i.position.x - at.x, i.position.z - at.z) < 8,
      )
      if (!junction) continue
      const hasDrivableExit = junction.connectedRoads.some(
        (id) => id !== road.id && network.roads[id] && vehicleFitsRoad(network.roads[id]!, 'car'),
      )
      if (!hasDrivableExit) continue
      // The end segment's tangent → its normal, in the local frame.
      const dx = next.x - at.x
      const dz = next.z - at.z
      const segLen = Math.hypot(dx, dz) || 1
      const nx = dz / segLen
      const nz = -dx / segLen
      const corner = (side: number): Cesium.Cartesian3 => {
        const ll = localToLngLat(origin, at.x + nx * side, at.z + nz * side)
        return Cesium.Cartesian3.fromDegrees(ll.lng, ll.lat, 1.35)
      }
      collection.entities.add({
        corridor: {
          positions: [corner(-half), corner(half)],
          width: 0.25,
          height: 1.35,
          material: new Cesium.ColorMaterialProperty(
            Cesium.Color.fromCssColorString(token('--dc-alert', '#f43f5e')),
          ),
        },
        properties: { access: 'barrier' },
      })
      for (const side of [-half, half]) {
        collection.entities.add({
          position: corner(side),
          cylinder: {
            length: 2.7,
            topRadius: 0.09,
            bottomRadius: 0.09,
            material: new Cesium.ColorMaterialProperty(
              Cesium.Color.fromCssColorString(token('--dc-alert', '#f43f5e')),
            ),
          },
          properties: { access: 'barrier' },
        })
      }
    }
  }

  /**
   * Re-apply the theme's road colours.
   *
   * The corridor bakes its colour in at creation, so a theme switch has
   * to reach the entities themselves. Each entity carries its access
   * class (`road` / `barred` / `barrier`) so the restyle knows which
   * token to apply.
   */
  const restyle = (): void => {
    const roadColor = cityAsphalt(token('--dc-road-main', '#3d4653'))
    const barredColor = cityAsphalt(token('--dc-road-local', '#2a323c'))
    const barColor = Cesium.Color.fromCssColorString(token('--dc-alert', '#f43f5e'))
    for (const entity of collection.entities.values) {
      const access = entity.properties?.access?.getValue(undefined)
      if (access === 'barrier') {
        const bar = Cesium.Color.fromCssColorString(token('--dc-alert', '#f43f5e'))
        if (entity.corridor) entity.corridor.material = new Cesium.ColorMaterialProperty(bar)
        if (entity.cylinder) entity.cylinder.material = new Cesium.ColorMaterialProperty(bar)
        continue
      }
      if (access === 'gantry') {
        // The height gantry is a WARNING, not a prohibition: the cars
        // go under it, the tall ones do not. It is therefore the
        // warning colour, not the alert colour.
        const gantry = Cesium.Color.fromCssColorString(token('--dc-warning', '#f59e0b'))
        if (entity.corridor) entity.corridor.material = new Cesium.ColorMaterialProperty(gantry)
        if (entity.cylinder) entity.cylinder.material = new Cesium.ColorMaterialProperty(gantry)
        if (entity.label) {
          entity.label.fillColor = new Cesium.ConstantProperty(gantry)
          entity.label.outlineColor = new Cesium.ConstantProperty(
            Cesium.Color.fromCssColorString(token('--dc-surface', '#0b1220')),
          )
        }
        continue
      }
      if (entity.corridor) {
        entity.corridor.material = new Cesium.ColorMaterialProperty(
          access === 'barred' ? barredColor : roadColor,
        )
      }
    }
  }
  restyle()

  return { entities: collection.entities, roadCount, barredCount, restyle }
}

/**
 * Default bbox around **深圳福田中心** (~4.4 km × 4.7 km).
 *
 * It is the city the project's own map data comes from
 * (`geojson/福田中心(深圳).osm`), so the Smart City view, the POI
 * layer and the imported maps are all about the same place.
 *
 * The eastern edge reaches the 春风隧道's mouth — the one stretch of
 * the extract with a height limit (`maxheight=3.5`), so the city can
 * show a road a bus may not enter. It must stay the SAME rectangle as
 * the backend's `SAMPLE_BBOX`: one is the area the basemap draws, the
 * other is the area the simulation drives, and they only describe one
 * place when they are the same rectangle.
 */
export const DEFAULT_BBOX: Bbox = {
  south: 22.52297,
  west: 114.04865,
  north: 22.56297,
  east: 114.095,
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
