// src/infrastructure/cesium/cesiumFrame.spec.ts
//
// Frame-level guards for the Cesium ↔ Three.js mapping.
//
// These are the raw primitives the camera sync is built on: the ENU
// frame at a tangent origin, and the Three.js camera's forward vector
// for a given pitch. They are asserted separately so a regression in
// the frame maths is reported as a frame problem, not as a camera-sync
// problem.

import { describe, it, expect } from 'vitest'
import * as Cesium from 'cesium'
import * as THREE from 'three'
import { makeTangentFrame } from './cameraSync'

describe('makeTangentFrame', () => {
  it('maps local ENU metres onto the globe', () => {
    const origin = { lat: 39.9055, lng: 116.3976 }
    const frame = makeTangentFrame(origin)
    // 1 km east, 1 km north of the origin.
    const ecef = Cesium.Matrix4.multiplyByPoint(
      frame,
      new Cesium.Cartesian3(1000, 1000, 0),
      new Cesium.Cartesian3(),
    )
    const carto = Cesium.Cartographic.fromCartesian(ecef)
    expect(Cesium.Math.toDegrees(carto.latitude)).toBeGreaterThan(origin.lat)
    expect(Cesium.Math.toDegrees(carto.longitude)).toBeGreaterThan(origin.lng)
    // ~1 km north ≈ 0.009° of latitude.
    expect(Cesium.Math.toDegrees(carto.latitude) - origin.lat).toBeCloseTo(0.009, 2)
  })
})

describe('Three.js camera pitch sign', () => {
  it('rotation.x = -π/2 looks DOWN, +π/2 looks UP', () => {
    // The camera sync maps Cesium's pitch (-π/2 = looking down) onto
    // rotation.x. Getting the sign wrong points the simulation camera
    // at the sky, which is exactly what the old mapping did.
    const down = new THREE.PerspectiveCamera()
    down.rotation.set(-Math.PI / 2, 0, 0, 'YXZ')
    down.updateMatrixWorld()
    const downDir = new THREE.Vector3()
    down.getWorldDirection(downDir)
    expect(downDir.y).toBeCloseTo(-1, 6)

    const up = new THREE.PerspectiveCamera()
    up.rotation.set(Math.PI / 2, 0, 0, 'YXZ')
    up.updateMatrixWorld()
    const upDir = new THREE.Vector3()
    up.getWorldDirection(upDir)
    expect(upDir.y).toBeCloseTo(1, 6)
  })

  it('a top-down camera keeps north (-Z) at the top of the screen', () => {
    const camera = new THREE.PerspectiveCamera()
    camera.rotation.set(-Math.PI / 2, 0, 0, 'YXZ')
    camera.updateMatrixWorld()
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
    expect(up.z).toBeCloseTo(-1, 6) // north is -Z in the app frame
  })
})
