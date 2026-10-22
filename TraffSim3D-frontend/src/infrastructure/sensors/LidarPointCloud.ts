// src/infrastructure/sensors/LidarPointCloud.ts
//
// THREE.Points wrapper that visualizes a LidarFrame.
// One LidarPointCloud per vehicle; worldStore keeps a Map<VehicleId,
// LidarPointCloud> and ThreeJSRenderer.addAuxiliary puts the mesh in
// the scene. updateFromFrame() re-uploads the position + color
// attributes every time the sensor re-scans.
//
// Color: HSL gradient where hue is mapped from intensity (0 = blue,
// 1 = red). Closer objects (higher intensity) read warmer; farther
// (low intensity) read cooler.

import * as THREE from 'three'
import type { LidarFrame } from './LidarSensor'

export class LidarPointCloud {
  readonly mesh: THREE.Points
  private positions: Float32Array
  private colors: Float32Array
  private geometry: THREE.BufferGeometry
  private material: THREE.PointsMaterial
  private frameCount = 0

  constructor(maxPoints: number) {
    this.positions = new Float32Array(maxPoints * 3)
    this.colors = new Float32Array(maxPoints * 3)
    this.geometry = new THREE.BufferGeometry()
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3))
    this.geometry.setDrawRange(0, 0)
    this.material = new THREE.PointsMaterial({
      size: 0.15,
      vertexColors: true,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    })
    this.mesh = new THREE.Points(this.geometry, this.material)
    // Point clouds are positioned at the host vehicle but extend far;
    // disable frustum culling so Three.js doesn't hide them based on
    // their mesh origin's bounding box.
    this.mesh.frustumCulled = false
  }

  /** Re-upload positions + colors from a fresh LidarFrame.
   *  Points with NaN coords (no hit) are skipped. */
  updateFromFrame(frame: LidarFrame): void {
    const n = frame.points.length / 3
    let writeIdx = 0
    const tmpColor = new THREE.Color()
    for (let k = 0; k < n; k++) {
      const x = frame.points[k * 3]
      const y = frame.points[k * 3 + 1]
      const z = frame.points[k * 3 + 2]
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
      this.positions[writeIdx * 3] = x
      this.positions[writeIdx * 3 + 1] = y
      this.positions[writeIdx * 3 + 2] = z
      const intensity = frame.intensities[k]!
      // HSL: (1-intensity) * 0.7 maps 1→0 (red), 0→0.7 (blue).
      tmpColor.setHSL((1 - intensity) * 0.7, 1, 0.5)
      this.colors[writeIdx * 3] = tmpColor.r
      this.colors[writeIdx * 3 + 1] = tmpColor.g
      this.colors[writeIdx * 3 + 2] = tmpColor.b
      writeIdx += 1
    }
    ;(this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(this.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true
    this.geometry.setDrawRange(0, writeIdx)
    this.frameCount += 1
  }

  /** LiDAR points are already in world coordinates (LidarSensor casts
   *  rays in world space), so the mesh stays at the origin. The
   *  position/heading params are accepted for API compatibility but
   *  are intentionally NOT applied to the mesh transform — doing so
   *  would double-offset the points (~2× vehicle position). */
  setPose(_position: { x: number; y: number; z: number }, _heading: number): void {
    // no-op: world-space points don't need a mesh transform
  }

  destroy(): void {
    this.geometry.dispose()
    this.material.dispose()
  }

  get frameCountValue(): number {
    return this.frameCount
  }
}
