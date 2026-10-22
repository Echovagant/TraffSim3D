/**
 * Instanced vehicle rendering.
 *
 * Replaces per-vehicle THREE.Group (6+ meshes each) with three
 * THREE.InstancedMesh objects (one per vehicle type). Draw calls
 * drop from N×6 to 3 regardless of vehicle count.
 *
 * Each vehicle type gets its own InstancedMesh with a box geometry
 * sized to match the original silhouette proportions. Per-instance
 * color is driven by `instanceColor`; the material is a single shared
 * MeshStandardMaterial (white base, instance color overrides).
 *
 * Trail lines remain individual THREE.Line objects (one per vehicle)
 * because each trail has a continuous path that can't be trivially
 * merged into a single draw call without breaking line connectivity.
 */
import * as THREE from 'three'
import type { Vehicle, VehicleType } from '@domain/entities/Vehicle'
import type { VehicleTrail } from './VehicleTrailMesh'
import { createVehicleTrail } from './VehicleTrailMesh'
import { Y_BODY } from './VehicleMesh'
import { TRAIL_LENGTH } from '@shared/constants/simulation'

export const MAX_VEHICLES_PER_TYPE = 256

interface TypeConfig {
  width: number
  height: number
  depth: number
  /** Y offset so box center sits at the right height above ground. */
  yCenter: number
}

const TYPE_CONFIG: Record<VehicleType, TypeConfig> = {
  car: { width: 4.2, height: 0.9, depth: 1.8, yCenter: Y_BODY + 0.45 },
  truck: { width: 6.5, height: 1.8, depth: 2.2, yCenter: Y_BODY + 0.9 },
  bus: { width: 9.0, height: 2.0, depth: 2.4, yCenter: Y_BODY + 1.0 },
}

interface SlotData {
  entityId: string
  color: THREE.Color
  matrix: THREE.Matrix4
  /** Cached position.x for dirty-check (skip matrix re-upload if unchanged). */
  px: number
  py: number
  pz: number
  heading: number
}

export interface VehicleInstances {
  meshes: Record<VehicleType, THREE.InstancedMesh>
  trails: Map<string, VehicleTrail>
  allocate: (v: Vehicle) => void
  remove: (entityId: string) => void
  update: (v: Vehicle) => void
  getPosition: (entityId: string) => THREE.Vector3 | null
  /** Map an InstancedMesh hit back to the vehicle entity ID. */
  pickByInstance: (mesh: THREE.InstancedMesh, instanceId: number) => string | null
  dispose: () => void
}

const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _scale = new THREE.Vector3(1, 1, 1)
const _euler = new THREE.Euler()
const _zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0)
const _white = new THREE.Color(1, 1, 1)

export const createVehicleInstances = (): VehicleInstances => {
  const types: VehicleType[] = ['car', 'truck', 'bus']

  const meshes: Record<VehicleType, THREE.InstancedMesh> = {} as any
  const slotToEntity: Record<VehicleType, Map<number, string>> = {
    car: new Map(),
    truck: new Map(),
    bus: new Map(),
  }
  const entityToSlot: Record<VehicleType, Map<string, number>> = {
    car: new Map(),
    truck: new Map(),
    bus: new Map(),
  }
  const freeSlots: Record<VehicleType, number[]> = {
    car: [],
    truck: [],
    bus: [],
  }
  const slots: Record<VehicleType, SlotData[]> = {
    car: [],
    truck: [],
    bus: [],
  }

  for (const type of types) {
    const cfg = TYPE_CONFIG[type]
    const geom = new THREE.BoxGeometry(cfg.width, cfg.height, cfg.depth)
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.6,
      metalness: 0.1,
    })
    const mesh = new THREE.InstancedMesh(geom, mat, MAX_VEHICLES_PER_TYPE)
    mesh.count = 0
    mesh.frustumCulled = false
    mesh.name = `vehicles-${type}`

    const colors = new Float32Array(MAX_VEHICLES_PER_TYPE * 3)
    for (let i = 0; i < MAX_VEHICLES_PER_TYPE * 3; i++) colors[i] = 1
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3)

    meshes[type] = mesh
    for (let i = MAX_VEHICLES_PER_TYPE - 1; i >= 0; i--) freeSlots[type].push(i)
    for (let i = 0; i < MAX_VEHICLES_PER_TYPE; i++) {
      slots[type].push({
        entityId: '',
        color: new THREE.Color(1, 1, 1),
        matrix: new THREE.Matrix4(),
        px: 0,
        py: 0,
        pz: 0,
        heading: 0,
      })
    }
  }

  const trails = new Map<string, VehicleTrail>()

  const allocate = (v: Vehicle): void => {
    const type = v.type
    const free = freeSlots[type]
    if (free.length === 0) return
    const slotIdx = free.pop()!

    const cfg = TYPE_CONFIG[type]
    _pos.set(v.position.x, v.position.y + cfg.yCenter, v.position.z)
    _euler.set(0, -v.heading, 0)
    _quat.setFromEuler(_euler)
    _scale.set(1, 1, 1)
    const mat4 = new THREE.Matrix4()
    mat4.compose(_pos, _quat, _scale)

    meshes[type].setMatrixAt(slotIdx, mat4)
    const col = _white.set(v.color)
    meshes[type].setColorAt(slotIdx, col)

    slots[type][slotIdx].entityId = v.id
    slots[type][slotIdx].color.copy(col)
    slots[type][slotIdx].matrix.copy(mat4)
    slots[type][slotIdx].px = v.position.x
    slots[type][slotIdx].py = v.position.y
    slots[type][slotIdx].pz = v.position.z
    slots[type][slotIdx].heading = v.heading

    slotToEntity[type].set(slotIdx, v.id)
    entityToSlot[type].set(v.id, slotIdx)

    meshes[type].count = Math.max(meshes[type].count, slotIdx + 1)
    meshes[type].instanceMatrix.needsUpdate = true
    if (meshes[type].instanceColor) meshes[type].instanceColor.needsUpdate = true

    trails.set(v.id, createVehicleTrail(v))
  }

  const remove = (entityId: string): void => {
    for (const type of types) {
      const slotIdx = entityToSlot[type].get(entityId)
      if (slotIdx === undefined) continue

      meshes[type].setMatrixAt(slotIdx, _zeroMatrix)
      meshes[type].instanceMatrix.needsUpdate = true

      const lastSlot = slots[type][slotIdx]
      const wasLast = slotIdx === meshes[type].count - 1

      slotToEntity[type].delete(slotIdx)
      entityToSlot[type].delete(entityId)
      lastSlot.entityId = ''
      freeSlots[type].push(slotIdx)

      if (wasLast) {
        while (meshes[type].count > 0 && !slotToEntity[type].has(meshes[type].count - 1)) {
          meshes[type].count--
        }
      }

      const trail = trails.get(entityId)
      if (trail) {
        trail.line.geometry.dispose()
        ;(trail.line.material as THREE.Material).dispose()
        trails.delete(entityId)
      }
      break
    }
  }

  const update = (v: Vehicle): void => {
    const type = v.type
    const slotIdx = entityToSlot[type].get(v.id)
    if (slotIdx === undefined) return

    const mesh = meshes[type]
    const slot = slots[type][slotIdx]

    // Dirty-check: skip matrix re-upload if position + heading unchanged.
    const moved =
      slot.px !== v.position.x ||
      slot.py !== v.position.y ||
      slot.pz !== v.position.z ||
      slot.heading !== v.heading
    if (moved) {
      const cfg = TYPE_CONFIG[type]
      _pos.set(v.position.x, v.position.y + cfg.yCenter, v.position.z)
      _euler.set(0, -v.heading, 0)
      _quat.setFromEuler(_euler)
      slot.matrix.compose(_pos, _quat, _scale)
      mesh.setMatrixAt(slotIdx, slot.matrix)
      mesh.instanceMatrix.needsUpdate = true
      slot.px = v.position.x
      slot.py = v.position.y
      slot.pz = v.position.z
      slot.heading = v.heading
    }

    const newColor = _white.set(v.color)
    if (!slot.color.equals(newColor)) {
      slot.color.copy(newColor)
      mesh.setColorAt(slotIdx, slot.color)
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }

    // Only advance trail if the vehicle actually moved.
    const trail = trails.get(v.id)
    if (trail && moved) {
      const last = trail.history[trail.history.length - 1]
      if (last) {
        const dx = v.position.x - last.x
        const dz = v.position.z - last.z
        if (dx * dx + dz * dz > WRAP_THRESHOLD * WRAP_THRESHOLD) {
          for (let i = 0; i < trail.history.length; i++) {
            trail.history[i] = { x: v.position.x, y: v.position.y, z: v.position.z }
          }
        }
      }
      trail.history.push({ x: v.position.x, y: v.position.y, z: v.position.z })
      if (trail.history.length > TRAIL_LENGTH) trail.history.shift()

      for (let i = 0; i < TRAIL_LENGTH; i++) {
        const h = trail.history[i] ?? v.position
        trail.positions[i * 3 + 0] = h.x
        trail.positions[i * 3 + 1] = (h.y ?? 0) + 0.1
        trail.positions[i * 3 + 2] = h.z
      }
      trail.attribute.needsUpdate = true
      ;(trail.line.material as THREE.LineBasicMaterial).color.set(v.color)
    }
  }

  const getPosition = (entityId: string): THREE.Vector3 | null => {
    for (const type of types) {
      const slotIdx = entityToSlot[type].get(entityId)
      if (slotIdx === undefined) continue
      const slot = slots[type][slotIdx]
      const p = new THREE.Vector3()
      p.setFromMatrixPosition(slot.matrix)
      return p
    }
    return null
  }

  const pickByInstance = (mesh: THREE.InstancedMesh, instanceId: number): string | null => {
    for (const type of types) {
      if (meshes[type] === mesh) {
        return slotToEntity[type].get(instanceId) ?? null
      }
    }
    return null
  }

  const dispose = (): void => {
    for (const type of types) {
      meshes[type].geometry.dispose()
      ;(meshes[type].material as THREE.Material).dispose()
    }
    for (const trail of trails.values()) {
      trail.line.geometry.dispose()
      ;(trail.line.material as THREE.Material).dispose()
    }
    trails.clear()
  }

  return { meshes, trails, allocate, remove, update, getPosition, pickByInstance, dispose }
}

const WRAP_THRESHOLD = 20
