// src/infrastructure/cesium/cameraSync.ts
//
// Cesium ↔ Three.js camera sync.
//
// ## Frames
//
// Cesium works in ECEF (Earth-Centered, Earth-Fixed) world coords;
// Three.js works in a local tangent plane anchored at a chosen origin
// (the standard `eastNorthUpToFixedFrame` ENU frame used in robotics /
// GIS). The tangent origin's lat/lon gets baked into a Cesium 4×4
// transformation matrix; we then invert it to project a Cesium camera
// position (ECEF) into local ENU (X=east, Y=north, Z=up).
//
// Mapping ENU → Three.js world (app convention: north = -Z):
//   three.x = ENU.x (east)
//   three.y = ENU.z (up)        ← Three.js Y is "up" (default camera up)
//   three.z = -ENU.y (north)    ← -Y so that north faces "into the screen"
//
// Why flip north: in our Three.js scenes, the default camera looks
// down the -Z axis. Mapping north → -Z keeps "north at top" in the
// bird's-eye view, matching the user's mental model of a map.
//
// The tangent origin is the *payload's* projection origin for an
// imported OSM map (`originLat`/`originLon`), so the simulation and the
// basemap describe the same place — see `resolveTangentOrigin` in
// `viewer.ts`.
//
// ## Ownership — why there is no feedback loop
//
// The two directions are never composed. `createCameraSync` holds a
// single `owner` and applies exactly ONE direction per tick:
//
//   owner = 'cesium' → Cesium drives, Three mirrors   (Cesium → Three)
//   owner = 'three'  → Three drives, Cesium mirrors   (Three → Cesium)
//
// Because the direction is *selected* (never chained), a two-way loop
// is structurally impossible: the Three→Cesium copy is never executed
// in the same tick as the Cesium→Three copy. The owner is switched
// explicitly (view mode), and the handover copies the current camera
// state once before the new owner takes over.

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
   *  are computed relative to this point. */
  tangent: TangentOrigin
}

/**
 * Which side currently owns the camera.
 *
 * - `'cesium'` — the user drives the basemap; Three.js mirrors it.
 * - `'three'`  — the user drives the simulation camera; Cesium mirrors
 *   it so the basemap stays under the simulation.
 */
export type CameraOwner = 'cesium' | 'three'

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
  //      - pitch   → X-axis rotation. Three.js cameras look down their
  //        local -Z, so a camera tilted down by θ needs rotation.x = -θ:
  //        at rotation.x = -π/2 the world forward vector is (0, -1, 0)
  //        (straight down), at +π/2 it is (0, +1, 0) (straight up).
  //        Cesium's pitch is -π/2 when looking down, so the mapping is
  //        `rotation.x = pitch` — NOT `-pitch`, which pointed the
  //        camera at the sky and left the simulation overlay invisible.
  const heading = cesiumViewer.camera.heading
  const pitch = cesiumViewer.camera.pitch
  threeCamera.rotation.set(pitch, -heading, 0, 'YXZ')
  threeCamera.updateMatrixWorld()

  return threeCamera
}

/**
 * Per-frame: copy Three.js camera state → Cesium camera (the reverse
 * direction).
 *
 * Only ever called while the owner is `'three'` — see the ownership
 * note at the top of this file.
 *
 * Position: the Three world position is projected into the ENU frame
 * (x = east, -z = north, y = up) and then into ECEF.
 * Orientation: the Three camera's world forward vector gives Cesium's
 * heading (0 = north, CW positive) and pitch (negative = looking down).
 */
export const syncCesiumCameraToThree = (deps: CameraSyncDeps): Cesium.Camera => {
  const { cesiumViewer, threeCamera, tangent } = deps
  const enuFrame = makeTangentFrame(tangent)

  // Three world → ENU: x = east, -z = north, y = up.
  const enu = new Cesium.Cartesian3(
    threeCamera.position.x,
    -threeCamera.position.z,
    threeCamera.position.y,
  )
  const ecef = Cesium.Matrix4.multiplyByPoint(enuFrame, enu, new Cesium.Cartesian3())

  const forward = new THREE.Vector3()
  threeCamera.getWorldDirection(forward)
  // Heading: 0 = north, positive = clockwise (east). North is -Z in the
  // app frame, so the northward component is -forward.z.
  const heading = Math.atan2(forward.x, -forward.z)
  // Pitch: negative when looking down (Cesium convention).
  const pitch = Math.asin(Math.max(-1, Math.min(1, forward.y)))

  const camera = cesiumViewer.camera
  camera.setView({
    destination: ecef,
    orientation: { heading, pitch, roll: 0 },
  })
  return camera
}

/**
 * Three.js world position → WGS84 lat/lon/height.
 *
 * The inverse of the camera sync's position mapping: it answers "where
 * on the globe does this simulation coordinate sit?" — which is what
 * makes an imported OSM network verifiable against the basemap.
 */
export const worldToLngLat = (
  position: { x: number; y: number; z: number },
  tangent: TangentOrigin,
): { lng: number; lat: number; height: number } => {
  const enuFrame = makeTangentFrame(tangent)
  const enu = new Cesium.Cartesian3(position.x, -position.z, position.y)
  const ecef = Cesium.Matrix4.multiplyByPoint(enuFrame, enu, new Cesium.Cartesian3())
  const carto = Cesium.Cartographic.fromCartesian(ecef)
  return {
    lng: Cesium.Math.toDegrees(carto.longitude),
    lat: Cesium.Math.toDegrees(carto.latitude),
    height: carto.height,
  }
}

export interface CameraSyncContext {
  /** Apply the current owner's direction once. */
  tick: () => void
  /** Move the ENU frame to a new origin (e.g. a newly imported map). */
  setTangent: (t: TangentOrigin) => void
  /** Hand the camera over to the other side. */
  setOwner: (owner: CameraOwner) => void
  /** Current owner. */
  owner: () => CameraOwner
}

/** Reusable sync context — created once, used per frame.
 *
 *  `owner` decides which direction a tick applies; see the ownership
 *  note at the top of this file. */
export const createCameraSync = (
  deps: CameraSyncDeps & { owner?: CameraOwner },
): CameraSyncContext => {
  let tangent = deps.tangent
  let owner: CameraOwner = deps.owner ?? 'cesium'
  return {
    tick: () => {
      if (owner === 'cesium') {
        syncThreeCameraToCesium({ ...deps, tangent })
      } else {
        syncCesiumCameraToThree({ ...deps, tangent })
      }
    },
    setTangent: (t: TangentOrigin) => {
      tangent = t
    },
    setOwner: (next: CameraOwner) => {
      owner = next
    },
    owner: () => owner,
  }
}
