// src/infrastructure/rendering/PoiLayer.ts
//
// The points of interest, drawn on the map.
//
// A POI is a place, not a vehicle: it does not move, it is not picked
// by the editor's click handler, and there can be hundreds of them. So
// it gets its own layer — one InstancedMesh (ONE draw call for the
// whole set), a colour per category, and a marker that reads as a map
// pin rather than as a piece of traffic.
//
// The marker is a small glowing column: the scene's own language (the
// traffic lights glow, the road markings are thin lines) — a floating
// icon would need a sprite atlas and a hundred textures, and a flat
// decal would be invisible from the low angles the camera spends most
// of its time at.
//
// The label is NOT rendered per POI: hundreds of DOM nodes (or sprites)
// would cost more than the rest of the scene put together. The name
// appears in the panel, and the marker itself brightens when selected.

import * as THREE from 'three'

/** One point of interest, in the scene's local metres. */
export interface Poi {
  id: string
  name: string
  /** The plain-language category (the provider's group). */
  category: string
  address: string
  /** The scene position (x east, z south). */
  x: number
  z: number
}

/** The marker's radius (m). */
export const POI_MARKER_RADIUS_M = 1.6

/** The marker's height (m). */
export const POI_MARKER_HEIGHT_M = 7.0

/** How high above the road the marker floats (m). */
export const POI_MARKER_LIFT_M = 0.2

/**
 * The category colours — the same restrained palette the rest of the
 * scene uses (the signals are amber/green/red; the road is grey).
 */
const CATEGORY_COLORS: Record<string, number> = {
  餐饮: 0xfbbf24,
  购物: 0x60a5fa,
  生活服务: 0x94a3b8,
  医疗: 0x22c55e,
  教育: 0xa78bfa,
  交通设施: 0x38bdf8,
  汽车服务: 0xf97316,
  商务: 0x2dd4bf,
  公共设施: 0xf472b6,
}

const DEFAULT_COLOR = 0x94a3b8

/** The colour of a category. */
export const poiColor = (category: string): number => CATEGORY_COLORS[category] ?? DEFAULT_COLOR

/** The POI layer: one InstancedMesh plus the geometry around it. */
export interface PoiLayer {
  /** The mesh itself (added to the scene root). */
  mesh: THREE.InstancedMesh
  /** The POIs currently drawn, in the mesh's instance order. */
  pois: Poi[]
  /** Rebuild the mesh for a new set of POIs. */
  set: (pois: Poi[]) => void
  /** Brighten one POI (the selected one). */
  select: (id: string | null) => void
  /** Release the GPU resources. */
  dispose: () => void
}

const MAX_POIS = 512

/**
 * Build the layer.
 *
 * The mesh is allocated for the maximum number of POIs and its count is
 * set per update — the same pattern the vehicle instancing uses (a
 * fixed pool, a live count), so a scene with 400 POIs still costs one
 * draw call.
 */
export const createPoiLayer = (): PoiLayer => {
  const geometry = new THREE.CylinderGeometry(
    POI_MARKER_RADIUS_M,
    POI_MARKER_RADIUS_M * 0.55,
    POI_MARKER_HEIGHT_M,
    8,
  )
  // The marker stands ON the ground: its centre is half its height up.
  geometry.translate(0, POI_MARKER_HEIGHT_M / 2 + POI_MARKER_LIFT_M, 0)

  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  })

  const mesh = new THREE.InstancedMesh(geometry, material, MAX_POIS)
  mesh.name = 'poi-layer'
  mesh.count = 0
  // The POIs are information, not scenery: the editor's click handler
  // must not select them.
  mesh.raycast = () => undefined

  const pois: Poi[] = []
  const matrix = new THREE.Matrix4()
  const color = new THREE.Color()
  let selectedId: string | null = null

  const draw = (): void => {
    mesh.count = Math.min(pois.length, MAX_POIS)
    for (let index = 0; index < mesh.count; index += 1) {
      const poi = pois[index]!
      matrix.makeTranslation(poi.x, 0, poi.z)
      mesh.setMatrixAt(index, matrix)
      const isSelected = poi.id === selectedId
      color.setHex(poiColor(poi.category))
      // The selected marker is brighter and larger — the only per-POI
      // emphasis the layer has.
      if (isSelected) color.multiplyScalar(1.8)
      mesh.setColorAt(index, color)
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }

  const set = (next: Poi[]): void => {
    pois.length = 0
    pois.push(...next.slice(0, MAX_POIS))
    draw()
  }

  const select = (id: string | null): void => {
    if (id === selectedId) return
    selectedId = id
    draw()
  }

  const dispose = (): void => {
    geometry.dispose()
    material.dispose()
    mesh.dispose()
  }

  return { mesh, pois, set, select, dispose }
}
