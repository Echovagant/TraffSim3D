// src/infrastructure/cesium/viewer.ts
//
// Plan 055: Cesium viewer factory for the Smart City basemap.
//
// Reuses the same approach as the user's prior SmartCity.vue project:
//   - Zero Ion dependency (`baseLayer: false`, no access token)
//   - Gaode tile imagery (Chinese map service, no Ion, no API key)
//   - Scene-level fog for far-distance performance
//   - FXAA + frame-rate cap for stable 60fps on big cities
//
// The Cesium container is a sibling of the Three.js canvas; the
// latter is rendered transparent on top so it overlays the basemap
// without occlusion. Camera sync (Cesium → Three.js) lives in
// cameraSync.ts.

import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

export interface CesiumSceneOptions {
  /** World-space center (WGS84). Default: Tiananmen Square (116.3976, 39.9055). */
  center: { lng: number; lat: number };
  /** Initial camera height in meters (default 1500m = bird's-eye). */
  zoomLevel: number;
  /** Tile service — defaults to Gaode (国内访问稳定, 无 token). */
  imagery?: {
    urlTemplate: string;
    subdomains: readonly string[];
    maximumLevel?: number;
  };
}

export const DEFAULT_IMAGERY = {
  // Gaode Web Tile (高德地图瓦片 API) — 国内稳定, no API key.
  // Note: 高德 tiles require Chinese locale (`lang=zh_cn`) for label
  // rendering; we keep the official defaults.
  urlTemplate:
    'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
  subdomains: ['1', '2', '3', '4'] as const,
  maximumLevel: 18,
};

export const createCesiumViewer = (
  container: HTMLElement,
  opts: CesiumSceneOptions,
): Cesium.Viewer => {
  // Plan 055: explicit baseLayer: false to avoid Cesium triggering
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
  });

  // ---- Imagery (basemap) ----
  const imagery = opts.imagery ?? DEFAULT_IMAGERY;
  viewer.imageryLayers.addImageryProvider(
    new Cesium.UrlTemplateImageryProvider({
      url: imagery.urlTemplate,
      subdomains: [...imagery.subdomains],
      maximumLevel: imagery.maximumLevel ?? 18,
    }),
  );

  // ---- Performance tuning ----
  // Fog: hides distant geometry (buildings, basemap edge) smoothly
  // into the sky color. Density / near / far follow the user's
  // prior SmartCity.vue values — proven on real city scenes.
  const scene = viewer.scene;
  scene.fog.enabled = true;
  scene.fog.density = 0.0002;
  // near/far are distances from camera in meters. At 1500m height,
  // the basemap tile boundary is ~5km away horizontally so we want
  // the fog to start fading at 1km and fully opaque by 5km.
  scene.fog.minimumBrightness = 0.03;
  scene.postProcessStages.fxaa.enabled = true;
  // Cap to 60fps — Cesium's default is uncapped which can push GPU
  // usage to 100% on big scenes.
  scene.maximumRenderTimeChange = Infinity;
  scene.requestRenderMode = false;

  // ---- Initial camera (bird's-eye fly-in over 2s) ----
  // Default Cesium camera orientation when destination is specified
  // without `orientation` is pitch=-90° (straight down), heading=0
  // (north), roll=0. Matches the user's prior project behaviour.
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(opts.center.lng, opts.center.lat, opts.zoomLevel),
    duration: 2,
  });

  return viewer;
};

/** Default Tangent origin for ENU projection (天安门广场中央).
 *  All Three.js world coordinates are computed relative to this
 *  point via `eastNorthUpToFixedFrame` inverse. */
export const DEFAULT_TANGENT_ORIGIN = { lng: 116.3976, lat: 39.9055 };