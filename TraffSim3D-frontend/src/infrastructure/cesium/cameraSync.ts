// src/infrastructure/cesium/cameraSync.ts
//
// Plan 055: Cesium → Three.js camera sync (one-way, MVP).
//
// Cesium works in ECEF (Earth-Centered, Earth-Fixed) world coords;
// Three.js works in a local tangent plane anchored at a chosen
// origin (here: 天安门广场中央). The conversion is the standard
// `eastNorthUpToFixedFrame` (ENU) frame used in robotics / GIS.
//
// The Tangent origin's lat/lon gets baked into a Cesium 4×4
// transformation matrix; we then invert it to project a Cesium
// camera position (ECEF) into local ENU (X=east, Y=north, Z=up).
//
// Mapping ENU → Three.js world (we use the "Z = up, Y = forward"
// Three.js convention):
//   three.x = ENU.x (east)
//   three.y = ENU.z (up)        ← Three.js Y is "up" (default camera up)
//   three.z = -ENU.y (north)    ← -Y so that north faces "into the screen"
//
// Why flip north: in our Three.js scenes, the default camera looks
// down the -Z axis. Mapping north → -Z keeps "north at top" in the
// bird's-eye view, matching the user's mental model of a map.

import * as Cesium from 'cesium'
import * as THREE from 'three'

export interface TangentOrigin {
  /** Longitude in degrees (WGS84). */
  lng: number
  /** Latitude in degrees (WGS84). */
  lat: number
}

export interface CameraSyncDeps {
  cesiumViewer: Cesium.Viewer
  threeCamera: THREE.PerspectiveCamera
  /** Tangent origin (ENU frame origin). All Three.js world coords
   *  are computed relative to this point. Default: 天安门广场中央. */
  tangent: TangentOrigin
}

/** Cache the ENU frame matrix at the tangent origin. Recomputed
 *  on the rare tangent change; the per-frame work just multiplies. */
export const makeTangentFrame = (tangent: TangentOrigin): Cesium.Matrix4 => {
  return Cesium.Transforms.eastNorthUpToFixedFrame(
    Cesium.Cartesian3.fromDegrees(tangent.lng, tangent.lat, 0),
  )
}

/** Apply the inverse ENU transform to a Cesium ECEF point. Result
 *  is `(east, north, up)` metres relative to the tangent origin. */
const toLocalENU = (
  ecef: Cesium.Cartesian3,
  enuFrame: Cesium.Matrix4,
): { x: number; y: number; z: number } => {
  const inverse = Cesium.Matrix4.inverseTransformation(enuFrame, new Cesium.Matrix4())
  const local = Cesium.Matrix4.multiplyByPoint(inverse, ecef, new Cesium.Cartesian3())
  return { x: local.x, y: local.y, z: local.z }
}

/** Per-frame: copy Cesium camera state → Three.js camera.
 *  Returns the same `threeCamera` for chaining. */
export const syncThreeCameraToCesium = (deps: CameraSyncDeps): THREE.PerspectiveCamera => {
  const { cesiumViewer, threeCamera, tangent } = deps
  const enuFrame = makeTangentFrame(tangent)

  // 1) Position
  const local = toLocalENU(cesiumViewer.camera.position, enuFrame)
  threeCamera.position.set(local.x, local.z, -local.y)

  // 2) Orientation
  //    Cesium exposes heading (yaw, 0=north, CW positive) and pitch
  //    (radians, 0=horizon, -π/2=down). We map to Three.js:
  //      - heading → Y-axis rotation (yaw), but sign-flipped because
  //        Cesium's positive heading is CW from north while Three.js
  //        positive Y rotation is CCW from north.
  //      - pitch   → X-axis rotation (also sign-flipped so that
  //        Cesium's -π/2 (looking down) maps to Three.js +π/2
  //        which is "looking from above, normal Three.js convention
  //        for OrbitControls).
  const heading = cesiumViewer.camera.heading
  const pitch = cesiumViewer.camera.pitch
  threeCamera.rotation.set(-pitch, 0, -heading, 'YXZ')
  threeCamera.updateMatrixWorld()

  return threeCamera
}

/** Reusable sync context — created once, used per frame. */
export const createCameraSync = (
  deps: CameraSyncDeps,
): {
  tick: () => void
  setTangent: (t: TangentOrigin) => void
} => {
  let enuFrame = makeTangentFrame(deps.tangent)
  return {
    tick: () => syncThreeCameraToCesium({ ...deps, tangent: enuFrame as unknown as TangentOrigin }),
    setTangent: (t: TangentOrigin) => {
      enuFrame = makeTangentFrame(t)
    },
  }
}
