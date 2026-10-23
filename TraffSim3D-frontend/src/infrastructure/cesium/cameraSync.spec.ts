// src/infrastructure/cesium/cameraSync.spec.ts
//
// Alignment evidence for the Cesium ↔ Three.js camera mapping.
//
// The claim under test: a simulation coordinate and the Cesium
// geographic coordinate describe the SAME place on the globe, so the
// imported OSM network lines up with the basemap.
//
// Frame (app convention): X = east, Y = up, Z = -north.
// Frame (backend payload):  X = east, Y = up, Z = +north — the adapter
// negates Z once, at the boundary (see `osmNetworkAdapter.ts`).

import { describe, it, expect, vi } from 'vitest'
import * as Cesium from 'cesium'
import * as THREE from 'three'
import {
  createCameraSync,
  makeTangentFrame,
  syncCesiumCameraToThree,
  syncThreeCameraToCesium,
  worldToLngLat,
  type TangentOrigin,
} from './cameraSync'

const ORIGIN: TangentOrigin = { lat: 39.9055, lng: 116.3976 }

/** A camera 1 km east, 2 km north and 1.5 km up of the origin. */
const cameraEcef = (origin: TangentOrigin, east: number, north: number, up: number) =>
  Cesium.Matrix4.multiplyByPoint(
    makeTangentFrame(origin),
    new Cesium.Cartesian3(east, north, up),
    new Cesium.Cartesian3(),
  )

/** ECEF → local ENU metres relative to the origin (east, north, up). */
const toLocalENU = (ecef: Cesium.Cartesian3, origin: TangentOrigin) => {
  const inverse = Cesium.Matrix4.inverseTransformation(
    makeTangentFrame(origin),
    new Cesium.Matrix4(),
  )
  const local = Cesium.Matrix4.multiplyByPoint(inverse, ecef, new Cesium.Cartesian3())
  return { x: local.x, y: local.y, z: local.z }
}

describe('worldToLngLat — simulation coordinate → geographic coordinate', () => {
  it('places a world position at the matching Cesium lat/lon', () => {
    // 500 m east, 500 m north of the origin (north is -Z in the app frame).
    const geo = worldToLngLat({ x: 500, y: 0, z: -500 }, ORIGIN)

    // Same point, computed with Cesium's own ENU math: the geographic
    // coordinate must land 500 m east / 500 m north of the origin.
    const ecef = Cesium.Cartesian3.fromDegrees(geo.lng, geo.lat, 0)
    const enu = toLocalENU(ecef, ORIGIN)
    expect(enu.x).toBeCloseTo(500, 1) // east
    expect(enu.y).toBeCloseTo(500, 1) // north
    expect(enu.z).toBeCloseTo(0, 1) // up
  })

  it('moves north when the world z decreases (north = -Z)', () => {
    const north = worldToLngLat({ x: 0, y: 0, z: -1000 }, ORIGIN)
    const south = worldToLngLat({ x: 0, y: 0, z: 1000 }, ORIGIN)
    expect(north.lat).toBeGreaterThan(ORIGIN.lat)
    expect(south.lat).toBeLessThan(ORIGIN.lat)
    // ~1000 m ≈ 0.009° of latitude.
    expect(north.lat - ORIGIN.lat).toBeCloseTo(0.009, 3)
  })

  it('round-trips a camera position through the geographic frame', () => {
    const ecef = cameraEcef(ORIGIN, 1200, -800, 400)
    const carto = Cesium.Cartographic.fromCartesian(ecef)
    const back = worldToLngLat({ x: 1200, y: 400, z: 800 }, ORIGIN)
    expect(back.lng).toBeCloseTo(Cesium.Math.toDegrees(carto.longitude), 6)
    expect(back.lat).toBeCloseTo(Cesium.Math.toDegrees(carto.latitude), 6)
    expect(back.height).toBeCloseTo(carto.height, 3)
  })
})

describe('syncThreeCameraToCesium — Cesium drives (the one-way direction)', () => {
  it('mirrors position and keeps the camera looking down', () => {
    const ecef = cameraEcef(ORIGIN, 1000, 2000, 1500)
    const viewer = {
      camera: { position: ecef, heading: 0, pitch: -Math.PI / 2 },
    }
    const threeCamera = new THREE.PerspectiveCamera()
    syncThreeCameraToCesium({
      cesiumViewer: viewer as unknown as Cesium.Viewer,
      threeCamera,
      tangent: ORIGIN,
    })

    expect(threeCamera.position.x).toBeCloseTo(1000, 1) // east
    expect(threeCamera.position.y).toBeCloseTo(1500, 1) // up
    expect(threeCamera.position.z).toBeCloseTo(-2000, 1) // north → -Z

    // A bird's-eye Cesium camera (pitch -90°) must look DOWN in Three.
    // (rotation.x = +π/2 would point it at the sky — the old bug.)
    const forward = new THREE.Vector3()
    threeCamera.getWorldDirection(forward)
    expect(forward.y).toBeCloseTo(-1, 6)
    expect(forward.x).toBeCloseTo(0, 6)
    expect(forward.z).toBeCloseTo(0, 6)
  })

  it('maps the Cesium heading onto the Three yaw (0 = north = -Z)', () => {
    const ecef = cameraEcef(ORIGIN, 0, 0, 1000)
    const viewer = {
      camera: { position: ecef, heading: Math.PI / 2, pitch: 0 },
    }
    const threeCamera = new THREE.PerspectiveCamera()
    syncThreeCameraToCesium({
      cesiumViewer: viewer as unknown as Cesium.Viewer,
      threeCamera,
      tangent: ORIGIN,
    })
    const forward = new THREE.Vector3()
    threeCamera.getWorldDirection(forward)
    // Cesium heading 90° = east = +X in the app frame.
    expect(forward.x).toBeCloseTo(1, 6)
    expect(forward.y).toBeCloseTo(0, 6)
    expect(forward.z).toBeCloseTo(0, 6)
  })
})

describe('syncCesiumCameraToThree — Three drives (the reverse direction)', () => {
  it('mirrors a Three camera position/orientation onto the Cesium camera', () => {
    const threeCamera = new THREE.PerspectiveCamera()
    threeCamera.position.set(500, 1500, -1000) // 500 m east, 1 km north
    threeCamera.rotation.set(-Math.PI / 2, 0, 0, 'YXZ') // straight down
    threeCamera.updateMatrixWorld()

    const setView = vi.fn()
    const viewer = { camera: { setView } }
    syncCesiumCameraToThree({
      cesiumViewer: viewer as unknown as Cesium.Viewer,
      threeCamera,
      tangent: ORIGIN,
    })

    expect(setView).toHaveBeenCalledTimes(1)
    const arg = setView.mock.calls[0]![0] as {
      destination: Cesium.Cartesian3
      orientation: { heading: number; pitch: number; roll: number }
    }
    const enu = toLocalENU(arg.destination, ORIGIN)
    expect(enu.x).toBeCloseTo(500, 1) // east
    expect(enu.y).toBeCloseTo(1000, 1) // north
    expect(enu.z).toBeCloseTo(1500, 1) // up
    expect(arg.orientation.pitch).toBeCloseTo(-Math.PI / 2, 6)
    expect(arg.orientation.heading).toBeCloseTo(0, 6)
  })
})

describe('createCameraSync — ownership (no feedback loop)', () => {
  it("applies only the owner's direction in a tick", () => {
    const ecef = cameraEcef(ORIGIN, 1000, 0, 500)
    const setView = vi.fn()
    const viewer = {
      camera: { position: ecef, heading: 0, pitch: -Math.PI / 2, setView },
    }
    const threeCamera = new THREE.PerspectiveCamera()
    const sync = createCameraSync({
      cesiumViewer: viewer as unknown as Cesium.Viewer,
      threeCamera,
      tangent: ORIGIN,
      owner: 'cesium',
    })

    sync.tick()
    expect(setView).not.toHaveBeenCalled()
    expect(threeCamera.position.x).toBeCloseTo(1000, 1)

    sync.setOwner('three')
    sync.tick()
    expect(setView).toHaveBeenCalledTimes(1)
  })

  it('moves the ENU frame when the tangent changes', () => {
    const ecef = cameraEcef(ORIGIN, 1000, 0, 500)
    const viewer = {
      camera: { position: ecef, heading: 0, pitch: -Math.PI / 2 },
    }
    const threeCamera = new THREE.PerspectiveCamera()
    const sync = createCameraSync({
      cesiumViewer: viewer as unknown as Cesium.Viewer,
      threeCamera,
      tangent: ORIGIN,
    })
    sync.setTangent({ lat: 22.545, lng: 114.06 })
    sync.tick()
    // Same ECEF point, different origin → different local coordinates.
    expect(threeCamera.position.x).not.toBeCloseTo(1000, 1)
  })
})
