// src/infrastructure/rendering/GroundMesh.spec.ts
//
// The ground is a pure PlaneGeometry + material factory — every number is
// observable without a GPU.

import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createGroundMesh, GROUND_DEFAULT_SIZE, GROUND_PADDING } from './GroundMesh'

describe('GroundMesh constants', () => {
  it('GROUND_DEFAULT_SIZE is 200 and GROUND_PADDING is 1000', () => {
    expect(GROUND_DEFAULT_SIZE).toBe(200)
    expect(GROUND_PADDING).toBe(1000)
  })
})

describe('createGroundMesh', () => {
  it('defaults to a 200x200 plane (the synthetic demo scenes keep their framing)', () => {
    const mesh = createGroundMesh()
    expect(mesh.geometry.type).toBe('PlaneGeometry')
    const params = (mesh.geometry as THREE.PlaneGeometry).parameters
    expect(params.width).toBe(200)
    expect(params.height).toBe(200)
  })

  it('honours an explicit size', () => {
    const params = (createGroundMesh(1170).geometry as THREE.PlaneGeometry).parameters
    expect(params.width).toBe(1170)
    expect(params.height).toBe(1170)
  })

  it('a size of 0 is passed through rather than silently replaced by the default', () => {
    const params = (createGroundMesh(0).geometry as THREE.PlaneGeometry).parameters
    expect(params.width).toBe(0)
  })

  it('lays the plane flat (rotation.x = -PI/2) at y = 0', () => {
    const mesh = createGroundMesh()
    expect(mesh.rotation.x).toBeCloseTo(-Math.PI / 2, 12)
    expect(mesh.rotation.y).toBe(0)
    expect(mesh.rotation.z).toBe(0)
    expect(mesh.position.y).toBe(0)
  })

  it('uses the dark slate material (0x1f2937, rough 0.9, non-metal)', () => {
    const mat = createGroundMesh().material as THREE.MeshStandardMaterial
    expect(mat.type).toBe('MeshStandardMaterial')
    expect(mat.color.getHex()).toBe(0x1f2937)
    expect(mat.roughness).toBe(0.9)
    expect(mat.metalness).toBe(0.0)
  })

  it('a 1-segment plane is 4 vertices / 2 triangles', () => {
    const geom = createGroundMesh().geometry
    expect(geom.attributes.position!.count).toBe(4)
    expect(geom.index!.count).toBe(6)
  })

  it('returns a fresh mesh each call (no shared geometry/material)', () => {
    const a = createGroundMesh()
    const b = createGroundMesh()
    expect(a).not.toBe(b)
    expect(a.geometry).not.toBe(b.geometry)
    expect(a.material).not.toBe(b.material)
  })
})
