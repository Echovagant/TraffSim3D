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
import { vehicleLodScale } from './vehicleLod'
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
  /** The lean (the road's slope), in radians. */
  pitch: number
  /** The LOD factor this slot's matrix was composed with. */
  scale: number
}

export interface VehicleInstances {
  meshes: Record<VehicleType, THREE.InstancedMesh>
  trails: Map<string, VehicleTrail>
  allocate: (v: Vehicle) => void
  remove: (entityId: string) => void
  update: (v: Vehicle) => void
  /**
   * Re-derive every drawn body's far-camera legibility factor (see
   * `vehicleLod.ts`) from the camera's CURRENT position, per vehicle:
   * below the minimum-readable size a body scales up so it reads as a
   * small mark instead of a vanishing dot. Display-only — physics never
   * sees it. The per-vehicle distance matters: a street-level camera is
   * kilometres from the city ORIGIN while the vehicles in view are only
   * a few hundred metres away — a single origin-based factor scaled
   * those bodies 4-5× past the horizon line and they read as cars
   * flying above the skyline. Changed factors re-compose immediately,
   * so the marks also land while the simulation is paused.
   */
  updateLod: (cameraPos: THREE.Vector3, viewportHeightPx: number, fovRad: number) => void
  /** Stop drawing a vehicle without releasing its slot. */
  hide: (entityId: string) => void
  /** Draw a hidden vehicle again. */
  show: (entityId: string) => void
  /** Is this vehicle currently hidden? */
  isHidden: (entityId: string) => boolean
  getPosition: (entityId: string) => THREE.Vector3 | null
  /** Map an InstancedMesh hit back to the vehicle entity ID. */
  pickByInstance: (mesh: THREE.InstancedMesh, instanceId: number) => string | null
  dispose: () => void
}

const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _scale = new THREE.Vector3(1, 1, 1)
const _euler = new THREE.Euler()
const _lodPos = new THREE.Vector3()
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
        pitch: 0,
        scale: 1,
      })
    }
  }

  const trails = new Map<string, VehicleTrail>()

  /** Vehicles that are allocated but not drawn (the followed car). */
  const hiddenIds = new Set<string>()

  /**
   * The camera the LOD factors are derived from — `null` until the
   * first `updateLod`, so bodies allocated before the first frame read
   * at true size rather than at a distance from a guessed origin.
   */
  let lodCamera: THREE.Vector3 | null = null
  let lodViewportH = 0
  let lodFov = 0

  /** The legibility factor one slot needs right now (1 = true size). */
  const lodScaleFor = (slot: SlotData): number => {
    if (!lodCamera) return 1
    const d = lodCamera.distanceTo(_lodPos.set(slot.px, slot.py, slot.pz))
    return vehicleLodScale(d, lodViewportH, lodFov)
  }

  /** Compose a slot's matrix from its cached pose at its cached scale. */
  const recomposeSlot = (type: VehicleType, slot: SlotData): void => {
    const cfg = TYPE_CONFIG[type]
    _pos.set(slot.px, slot.py + cfg.yCenter, slot.pz)
    _euler.set(0, -slot.heading, slot.pitch)
    _quat.setFromEuler(_euler)
    _scale.set(slot.scale, slot.scale, slot.scale)
    slot.matrix.compose(_pos, _quat, _scale)
  }

  const updateLod = (cameraPos: THREE.Vector3, viewportHeightPx: number, fovRad: number): void => {
    if (!lodCamera) lodCamera = new THREE.Vector3()
    lodCamera.copy(cameraPos)
    lodViewportH = viewportHeightPx
    lodFov = fovRad
    for (const type of types) {
      const mesh = meshes[type]
      let dirty = false
      for (const [entityId, slotIdx] of entityToSlot[type]) {
        // A hidden vehicle's matrix must stay zeroed; its scale catches
        // up on the next `update` after `show` (the cached slot scale
        // no longer matches, which flags the matrix dirty).
        if (hiddenIds.has(entityId)) continue
        const slot = slots[type][slotIdx]
        const next = lodScaleFor(slot)
        if (next === slot.scale) continue
        slot.scale = next
        recomposeSlot(type, slot)
        mesh.setMatrixAt(slotIdx, slot.matrix)
        dirty = true
      }
      if (dirty) mesh.instanceMatrix.needsUpdate = true
    }
  }

  const allocate = (v: Vehicle): void => {
    const type = v.type
    const free = freeSlots[type]
    if (free.length === 0) return
    const slotIdx = free.pop()!

    const cfg = TYPE_CONFIG[type]
    const pitch = v.pitch ?? 0
    _pos.set(v.position.x, v.position.y + cfg.yCenter, v.position.z)
    _euler.set(0, -v.heading, pitch)
    _quat.setFromEuler(_euler)
    const scale = lodScaleFor(slots[type][slotIdx])
    _scale.set(scale, scale, scale)
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
    slots[type][slotIdx].pitch = pitch

    slotToEntity[type].set(slotIdx, v.id)
    entityToSlot[type].set(v.id, slotIdx)
    slots[type][slotIdx].scale = scale

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

  /**
   * Stop drawing a vehicle without releasing its slot.
   *
   * The first-person camera sits inside the car it rides in, so the
   * car's own body would fill the frame. Hiding it keeps the slot (and
   * its trail) intact, so switching the camera back restores the car
   * exactly where it was.
   */
  const hide = (entityId: string): void => {
    if (hiddenIds.has(entityId)) return
    const type = typeOf(entityId)
    if (!type) return
    const slotIdx = entityToSlot[type].get(entityId)
    if (slotIdx === undefined) return
    meshes[type].setMatrixAt(slotIdx, _zeroMatrix)
    meshes[type].instanceMatrix.needsUpdate = true
    hiddenIds.add(entityId)
  }

  /** Draw a hidden vehicle again, at its last known pose. */
  const show = (entityId: string): void => {
    if (!hiddenIds.delete(entityId)) return
    const type = typeOf(entityId)
    if (!type) return
    const slotIdx = entityToSlot[type].get(entityId)
    if (slotIdx === undefined) return
    const slot = slots[type][slotIdx]
    meshes[type].setMatrixAt(slotIdx, slot.matrix)
    meshes[type].instanceMatrix.needsUpdate = true
  }

  const isHidden = (entityId: string): boolean => hiddenIds.has(entityId)

  /** The vehicle type an entity id was allocated under. */
  const typeOf = (entityId: string): VehicleType | null => {
    for (const type of types) {
      if (entityToSlot[type].has(entityId)) return type
    }
    return null
  }

  const update = (v: Vehicle): void => {
    const type = v.type
    const slotIdx = entityToSlot[type].get(v.id)
    if (slotIdx === undefined) return
    // A hidden vehicle keeps its slot but is not drawn: the first-person
    // camera sits inside the car it rides in, and the car's own body
    // would fill the frame.
    if (hiddenIds.has(v.id)) return

    const mesh = meshes[type]
    const slot = slots[type][slotIdx]
    const pitch = v.pitch ?? 0

    // Dirty-check: skip matrix re-upload if position, heading AND the
    // factor this slot needs are all unchanged. The factor is derived
    // here as well (not only in `updateLod`) so a body that `show`
    // resurrects — hidden slots are skipped by `updateLod`, their scale
    // cached stale — picks the fresh factor up on this very update.
    const scale = lodScaleFor(slot)
    const moved =
      slot.px !== v.position.x ||
      slot.py !== v.position.y ||
      slot.pz !== v.position.z ||
      slot.heading !== v.heading ||
      slot.pitch !== pitch ||
      slot.scale !== scale
    if (moved) {
      const cfg = TYPE_CONFIG[type]
      _pos.set(v.position.x, v.position.y + cfg.yCenter, v.position.z)
      // The lean: the road's slope under the vehicle. Without it a car
      // on a ramp follows the ramp's HEIGHT but stays level — it
      // slides up the slope sideways instead of driving up it.
      //
      // The lean is about the car's LATERAL axis (z), not about its
      // length axis (x): a car on a slope pitches NOSE UP, and a
      // rotation about x would roll it sideways. The euler's order is
      // XYZ, so the z rotation is applied in the car's own frame —
      // first the lean, then the yaw — which is what a car on a ramp
      // does.
      _euler.set(0, -v.heading, pitch)
      _quat.setFromEuler(_euler)
      _scale.set(scale, scale, scale)
      slot.matrix.compose(_pos, _quat, _scale)
      mesh.setMatrixAt(slotIdx, slot.matrix)
      mesh.instanceMatrix.needsUpdate = true
      slot.px = v.position.x
      slot.py = v.position.y
      slot.pz = v.position.z
      slot.heading = v.heading
      slot.pitch = pitch
      slot.scale = scale
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

  return {
    meshes,
    trails,
    allocate,
    remove,
    update,
    updateLod,
    hide,
    show,
    isHidden,
    getPosition,
    pickByInstance,
    dispose,
  }
}

const WRAP_THRESHOLD = 20
