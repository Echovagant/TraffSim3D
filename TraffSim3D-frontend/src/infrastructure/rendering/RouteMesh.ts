// src/infrastructure/rendering/RouteMesh.ts
//
// The planned route, drawn on the road.
//
// A ribbon rather than a line: WebGL ignores `linewidth` above 1, so a
// `THREE.Line` would be a hairline that disappears at any distance.
// The ribbon is a triangle strip of a fixed width, lifted a few
// centimetres above the road surface so it does not fight the road
// mesh for the same depth.
//
// The material is unlit (`MeshBasicMaterial`): a route is a piece of
// information, not a physical object, and it must read the same at
// night as at noon. It is drawn with `depthWrite: false` so it never
// occludes a vehicle that is driving on it.

import * as THREE from 'three'

/**
 * The route as the renderer needs it.
 *
 * Structural on purpose: the render layer must not depend on the
 * application layer's types, and the store's `PlannedRoute` satisfies
 * this shape without importing anything.
 */
export interface RouteRenderPath {
  /** The route's polyline, in world coordinates. */
  points: readonly { x: number; y: number; z: number }[]
}

/** How wide the ribbon is (m) — a bit wider than one lane. */
export const ROUTE_RIBBON_WIDTH_M = 2.4

/** How high above the road the ribbon floats (m). */
export const ROUTE_RIBBON_LIFT_M = 0.07

/** The ribbon's colour — the same amber the UI uses for the route. */
export const ROUTE_RIBBON_COLOR = 0xfbbf24

/**
 * Build the route ribbon, or `null` when there is nothing to draw.
 *
 * The polyline's points come from the network's own geometry, so
 * consecutive points may coincide (a junction where two legs meet at
 * the same node). Zero-length segments are dropped — a zero-length
 * segment has no direction, so its perpendicular is undefined.
 */
export const buildRouteMesh = (path: RouteRenderPath): THREE.Mesh | null => {
  const points = path.points.filter(
    (p, i) =>
      i === 0 || Math.hypot(p.x - path.points[i - 1]!.x, p.z - path.points[i - 1]!.z) > 1e-6,
  )
  if (points.length < 2) return null

  const positions: number[] = []
  const indices: number[] = []
  const half = ROUTE_RIBBON_WIDTH_M / 2

  for (let i = 0; i < points.length; i += 1) {
    const current = points[i]!
    const previous = points[i - 1] ?? current
    const next = points[i + 1] ?? current
    // The direction of the segment: forward where there is one, back
    // where the ribbon ends.
    const dx = next.x - previous.x
    const dz = next.z - previous.z
    const len = Math.hypot(dx, dz)
    const nx = len > 1e-6 ? -dz / len : 0
    const nz = len > 1e-6 ? dx / len : 0
    const y = current.y + ROUTE_RIBBON_LIFT_M

    positions.push(current.x + nx * half, y, current.z + nz * half)
    positions.push(current.x - nx * half, y, current.z - nz * half)

    if (i > 0) {
      const base = (i - 1) * 2
      indices.push(base, base + 1, base + 2)
      indices.push(base + 1, base + 3, base + 2)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()

  const material = new THREE.MeshBasicMaterial({
    color: ROUTE_RIBBON_COLOR,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    side: THREE.DoubleSide,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'route-ribbon'
  // The ribbon is information, not scenery: it must not be picked by
  // the editor's click handler.
  mesh.raycast = () => undefined
  return mesh
}
