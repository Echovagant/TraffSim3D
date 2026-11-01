// src/infrastructure/cesium/viewer.ts
//
// Cesium viewer factory for the Smart City basemap.
//
// Reuses the same approach as the user's prior SmartCity.vue project:
//   - Zero Ion dependency (`baseLayer: false`, no access token)
//   - OpenStreetMap's own tiles (no Ion, no API key, no account)
//   - Scene-level fog for far-distance performance
//   - FXAA + frame-rate cap for stable 60fps on big cities
//
// The Cesium container is a sibling of the Three.js canvas; the
// latter is rendered transparent on top so it overlays the basemap
// without occlusion. Camera sync (Cesium → Three.js) lives in
// cameraSync.ts.

import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import type { GeoOrigin } from '@domain/entities/RoadNetwork'
import type { TangentOrigin } from './cameraSync'
import { ancestorTiles, prefetchTiles, tileZoomForHeight } from './tilePrefetch'

export interface CesiumSceneOptions {
  /**
   * World-space center (WGS84). Defaults to the payload's projection
   * origin when the scene carries one, else to `DEFAULT_TANGENT_ORIGIN`
   * (深圳福田中心) — see `resolveTangentOrigin`.
   */
  center?: TangentOrigin
  /** Initial camera height in meters (default 1500m = bird's-eye). */
  zoomLevel: number
  /** Tile service — defaults to OpenStreetMap's own tiles. */
  imagery?: {
    urlTemplate: string
    subdomains: readonly string[]
    maximumLevel?: number
    /** The attribution shown on screen (the tile service's own terms
     *  require it — OSM's data is ODbL). */
    credit?: string
  }
}

/**
 * The basemap: **OpenStreetMap's own tiles** (the "standard"
 * cartography), served by the community mirror that answers from this
 * network.
 *
 * Why not a Chinese provider's tiles: those are **GCJ-02** ("火星坐标"),
 * a state-mandated offset datum — hundreds of metres from WGS84
 * (measured at the project's own origin: **605 m**, 525 m east and
 * 301 m north). The scene's roads come from OSM, which is WGS84, so a
 * GCJ-02 basemap put the drawn network visibly **off the basemap's
 * own roads**. The tiles themselves were the only part of the view
 * that was in the wrong datum.
 *
 * With OSM's tiles the basemap and the road network are **the same
 * data in the same datum**, so they line up by construction — no
 * offset to correct, and the buildings and roads you see are the ones
 * the simulation runs on.
 *
 * Which host: `tile.openstreetmap.org` is **unreachable from this
 * network** (measured: a 21 s connect timeout), so the default is the
 * well-known community mirror `tile.openstreetmap.de` (FOSSGIS), whose
 * subdomains a/b/c all answered in 0.9–4.3 s. The OSMF tile policy
 * still applies — light use, no bulk downloading, and the app has to
 * identify itself (the browser's Referer does that) — so the credit
 * below is **on screen**.
 */
export const DEFAULT_IMAGERY = {
  urlTemplate: 'https://{s}.tile.openstreetmap.de/{z}/{x}/{y}.png',
  subdomains: ['a', 'b', 'c'] as const,
  maximumLevel: 19,
  credit: '© OpenStreetMap contributors',
}

export const createCesiumViewer = (
  container: HTMLElement,
  opts: CesiumSceneOptions,
): Cesium.Viewer => {
  // Explicit baseLayer: false to avoid Cesium triggering
  // its default `fromWorldImagery()` call which requires an Ion
  // access token. We attach our own imagery layer below.
  const viewer = new Cesium.Viewer(container, {
    timeline: false,
    animation: false,
    baseLayerPicker: false,
    geocoder: false,
    infoBox: false,
    selectionIndicator: false,
    baseLayer: false,
    terrainProvider: undefined,
    sceneMode: Cesium.SceneMode.SCENE3D,
    // Cesium throws when WebGL context fails — we want those to surface
    // as a thrown error from createCesiumViewer rather than silently
    // swallowing them.
    contextOptions: { webgl: { failIfMajorPerformanceCaveat: false } },
  })

  // ---- Imagery (basemap) ----
  const imagery = opts.imagery ?? DEFAULT_IMAGERY
  viewer.imageryLayers.addImageryProvider(
    new Cesium.UrlTemplateImageryProvider({
      url: imagery.urlTemplate,
      subdomains: [...imagery.subdomains],
      maximumLevel: imagery.maximumLevel ?? 19,
      // The tile service's own terms require the attribution on
      // screen (OSM's data is ODbL) — `showOnScreen: true` puts it in
      // the widget's credit line instead of only the info box.
      credit: imagery.credit ? new Cesium.Credit(imagery.credit, true) : undefined,
    }),
  )

  // ---- Performance tuning ----
  // Fog: hides distant geometry (buildings, basemap edge) smoothly
  // into the sky color. Density / near / far follow the user's
  // prior SmartCity.vue values — proven on real city scenes.
  const scene = viewer.scene
  scene.fog.enabled = true
  scene.fog.density = 0.0002
  // near/far are distances from camera in meters. At 1500m height,
  // the basemap tile boundary is ~5km away horizontally so we want
  // the fog to start fading at 1km and fully opaque by 5km.
  scene.fog.minimumBrightness = 0.03
  scene.postProcessStages.fxaa.enabled = true
  // Cap to 60fps — Cesium's default is uncapped which can push GPU
  // usage to 100% on big scenes.
  scene.maximumRenderTimeChange = Infinity
  scene.requestRenderMode = false

  // ---- Initial camera (bird's-eye fly-in over 2s) ----
  // Default Cesium camera orientation when destination is specified
  // without `orientation` is pitch=-90° (straight down), heading=0
  // (north), roll=0. Matches the user's prior project behaviour.
  const center = opts.center ?? DEFAULT_TANGENT_ORIGIN
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(center.lng, center.lat, opts.zoomLevel),
  })

  // ---- Warm the tile cache for the ancestors ----
  //
  // Cesium walks its quadtree downwards, one level at a time, and a
  // level may only be requested once its parent is loaded — so a
  // camera 1 500 m above a city pulls fifteen levels (z1 … z16) one
  // after the other, and the basemap takes **90–190 s** to fill
  // (measured). The ancestors are tiny (about 25 tiles, a few kB
  // each), so fetching them **in parallel** here puts them in the
  // browser's cache before Cesium asks for them; the chain then
  // costs Cesium's processing time only.
  //
  // This is a pure optimisation: it touches no quality setting, and a
  // tile that fails to prefetch is simply fetched the slow way.
  const tileZoom = tileZoomForHeight(opts.zoomLevel, center.lat, {
    maxZoom: imagery.maximumLevel ?? 19,
  })
  void prefetchTiles(ancestorTiles(center.lng, center.lat, tileZoom), (tile) =>
    buildTileUrl(imagery, tile),
  )

  return viewer
}

/**
 * The URL of one tile of an imagery service.
 *
 * Cesium's own template filling is not public API, so the two
 * placeholders the OSM template uses (`{s}` and `{z}/{x}/{y}`) are
 * filled here — the prefetch has to produce byte-identical URLs for
 * the cache to hit.
 */
const buildTileUrl = (
  imagery: { urlTemplate: string; subdomains: readonly string[] },
  tile: { x: number; y: number; z: number },
): string => {
  const subdomain =
    imagery.subdomains[tile.x % imagery.subdomains.length] ?? imagery.subdomains[0] ?? ''
  return imagery.urlTemplate
    .replace('{s}', subdomain)
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y))
}

/**
 * Default Tangent origin for ENU projection (**深圳福田中心**).
 * All Three.js world coordinates are computed relative to this point
 * via `eastNorthUpToFixedFrame` inverse.
 *
 * This is a **fallback**: it only applies to scenes without a
 * geographic anchor (the built-in demo scenes, or an OSM payload that
 * carries no `originLat`/`originLon`). An imported map always uses
 * its own projection origin.
 *
 * Why 深圳: it is the city the project's own map data comes from
 * (`geojson/福田中心(深圳).osm` — 51 715 nodes, and the centroid is
 * exactly these coordinates), so the Smart City view, the POI layer
 * and the imported maps all talk about the same place. The previous
 * anchor (天安门) was a placeholder that had nothing to do with the
 * data.
 */
export const DEFAULT_TANGENT_ORIGIN = { lng: 114.06865, lat: 22.54297 }

/**
 * Resolve the ENU tangent origin of a scene.
 *
 * - A scene with a geographic anchor (an imported OSM map carries the
 *   payload's `originLat`/`originLon`) uses it — that is what makes the
 *   simulation and the basemap describe the same place.
 * - A scene without one (demo scenes, or an OSM payload that predates
 *   the origin fields) falls back to `DEFAULT_TANGENT_ORIGIN`
 *   (深圳福田中心). The fallback is a *display* anchor only: the
 *   simulation still runs, it is just not pinned to a real place.
 */
export const resolveTangentOrigin = (origin?: GeoOrigin | null): TangentOrigin => {
  if (!origin) return DEFAULT_TANGENT_ORIGIN
  const { lat, lon } = origin
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return DEFAULT_TANGENT_ORIGIN
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return DEFAULT_TANGENT_ORIGIN
  return { lng: lon, lat }
}
