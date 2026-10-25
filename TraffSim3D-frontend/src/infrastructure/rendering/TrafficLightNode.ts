import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { TrafficLight } from '@domain/entities/TrafficLight'
import { LightPhase } from '@domain/value-objects/Phase'
import { PHASE_DURATIONS } from '@shared/constants/simulation'

// Extended color map covers all 10 phase values.
// Per 007 §1.1 rendering enforcement — exhaustive (no `default: gray`).
// `Dark` = nearly black; renderer keeps emissiveIntensity low for it.
export const PHASE_COLOR: Record<TrafficLight['phase'], number> = {
  [LightPhase.Green]: 0x22c55e, // (0.13, 0.77, 0.37)
  [LightPhase.Yellow]: 0xfbbf24, // (0.98, 0.75, 0.14)
  [LightPhase.Red]: 0xef4444, // (0.94, 0.27, 0.27)
  [LightPhase.GreenLeft]: 0x22c55e, // same hue, different shape (left arrow)
  [LightPhase.YellowLeft]: 0xfbbf24,
  [LightPhase.RedLeft]: 0xef4444,
  [LightPhase.FlashingYellow]: 0xfbbf24, // 1Hz blink (see update)
  [LightPhase.FlashingRed]: 0xef4444, // 0.5Hz blink
  [LightPhase.AllRed]: 0xef4444, // all 4 bulbs red
  [LightPhase.Dark]: 0x1a1a1a, // near-black, no emissive
}

/** Per-phase emissive intensity baseline. Flashing phases modulated
 *  by `update` based on `simTime % period`. */
export const PHASE_EMISSIVE_INTENSITY: Record<TrafficLight['phase'], number> = {
  [LightPhase.Green]: 0.7,
  [LightPhase.Yellow]: 0.7,
  [LightPhase.Red]: 0.7,
  [LightPhase.GreenLeft]: 0.7,
  [LightPhase.YellowLeft]: 0.7,
  [LightPhase.RedLeft]: 0.7,
  [LightPhase.FlashingYellow]: 0.5,
  [LightPhase.FlashingRed]: 0.5,
  [LightPhase.AllRed]: 0.7,
  [LightPhase.Dark]: 0.0,
}

/** The signal head's parts, in world units. */
const POLE_RADIUS = 0.15
const POLE_HEIGHT = 3
const POLE_SEGMENTS = 8
const BULB_RADIUS = 0.6
const BULB_SEGMENTS = 16
const BULB_HEIGHT = 3
const BAR_WIDTH = 1.5
const BAR_THICKNESS = 0.15
const BAR_HEIGHT = 3.7
/** The bar runs at 60% of the bulb's emissive so the bulb dominates. */
const BAR_EMISSIVE_FACTOR = 0.6

export interface TrafficLightNode {
  /** The light's world position — the selection ring follows it. */
  position: THREE.Vector3
  /** Index of this light in the shared instanced meshes. */
  index: number
}

export interface TrafficLightLayer {
  /** The group to add to the scene. */
  root: THREE.Group
  /** light id -> node */
  nodes: Map<string, TrafficLightNode>
  /** The bulbs, one instance per light — the pick target. */
  bulbs: THREE.InstancedMesh
  /** The phase-countdown bars, one instance per light. */
  bars: THREE.InstancedMesh
  /** The poles of every light, merged into one mesh. */
  poles: THREE.Mesh | null
  /** Rebuild the shared meshes for the given lights. */
  setLights: (lights: readonly TrafficLight[]) => void
  /** Per-frame update of one light. */
  update: (node: TrafficLightNode, light: TrafficLight, simTime: number) => void
  /** The light behind an instance id (from a raycast). */
  lightIdAt: (instanceId: number) => string | undefined
  /** Release the GPU resources of the layer. */
  dispose: () => void
}

const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _scale = new THREE.Vector3(1, 1, 1)
const _matrix = new THREE.Matrix4()
const _color = new THREE.Color()

/**
 * The material of a signal head.
 *
 * The colour and the glow of a head are per-light state, so they travel
 * as instance data: `instanceColor` carries the phase colour and
 * `instanceGlow` the phase's emissive intensity. The shader patch makes
 * the emissive term follow both — which is exactly what the per-head
 * materials did before the heads were instanced.
 */
const createSignalMaterial = (): THREE.MeshStandardMaterial => {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 1,
  })
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float instanceGlow;\nvarying float vInstanceGlow;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n\tvInstanceGlow = instanceGlow;',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vInstanceGlow;')
      .replace(
        'vec3 totalEmissiveRadiance = emissive;',
        'vec3 totalEmissiveRadiance = emissive * vColor * vInstanceGlow;',
      )
  }
  return material
}

/** An instanced mesh whose per-instance glow lives in `instanceGlow`. */
const createInstancedHeads = (
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  count: number,
): THREE.InstancedMesh => {
  const capacity = Math.max(count, 1)
  const mesh = new THREE.InstancedMesh(geometry, material, capacity)
  mesh.count = count
  mesh.frustumCulled = false
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3)
  geometry.setAttribute(
    'instanceGlow',
    new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1),
  )
  return mesh
}

/**
 * Every traffic light of the network, drawn in three draw calls.
 *
 * A signal head is a pole, a bulb and a countdown bar, and a 5x5 grid
 * has 50 of them: 150 meshes, 150 draw calls, 25 600 triangles of
 * bulbs — for a picture that is a handful of pixels across. The poles
 * are static, so they are merged into one mesh; the bulbs and the bars
 * change per light, so they are instanced, with the phase colour and
 * the phase glow riding along as instance data.
 */
export const createTrafficLightLayer = (): TrafficLightLayer => {
  const root = new THREE.Group()
  const nodes = new Map<string, TrafficLightNode>()
  const ids: string[] = []
  const material = createSignalMaterial()
  const bulbGeometry = new THREE.SphereGeometry(BULB_RADIUS, BULB_SEGMENTS, BULB_SEGMENTS)
  const barGeometry = new THREE.BoxGeometry(BAR_WIDTH, BAR_THICKNESS, BAR_THICKNESS)
  const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.8 })

  let bulbs = createInstancedHeads(bulbGeometry, material, 0)
  let bars = createInstancedHeads(barGeometry, material, 0)
  let poles: THREE.Mesh | null = null

  // The layer hands out the CURRENT meshes: `setLights` rebuilds them,
  // and the layer's fields follow.
  const layer: TrafficLightLayer = {
    root,
    nodes,
    bulbs,
    bars,
    poles,
    setLights: (lights) => setLights(lights),
    update: (node, light, simTime) => update(node, light, simTime),
    lightIdAt: (instanceId) => lightIdAt(instanceId),
    dispose: () => dispose(),
  }

  const setLights = (lights: readonly TrafficLight[]): void => {
    root.remove(bulbs)
    root.remove(bars)
    if (poles) {
      root.remove(poles)
      poles.geometry.dispose()
      poles = null
    }
    bulbs.dispose()
    bars.dispose()

    nodes.clear()
    ids.length = 0

    const count = lights.length
    bulbs = createInstancedHeads(bulbGeometry, material, count)
    bars = createInstancedHeads(barGeometry, material, count)

    if (count > 0) {
      const poleGeometries = lights.map((light) => {
        const geometry = new THREE.CylinderGeometry(
          POLE_RADIUS,
          POLE_RADIUS,
          POLE_HEIGHT,
          POLE_SEGMENTS,
        )
        geometry.translate(light.position.x, light.position.y + POLE_HEIGHT / 2, light.position.z)
        return geometry
      })
      const merged = mergeGeometries(poleGeometries, false)
      if (!merged) throw new Error('createTrafficLightLayer: the poles could not be merged')
      poles = new THREE.Mesh(merged, poleMaterial)
      root.add(poles)
    }

    lights.forEach((light, index) => {
      ids.push(light.id)
      const node: TrafficLightNode = {
        position: new THREE.Vector3(light.position.x, light.position.y, light.position.z),
        index,
      }
      nodes.set(light.id, node)
      // The bulb sits on top of the pole...
      _pos.set(light.position.x, light.position.y + BULB_HEIGHT, light.position.z)
      _matrix.compose(_pos, _quat, _scale)
      bulbs.setMatrixAt(index, _matrix)
      // ... and the countdown bar above it. Its width is set per frame.
      _pos.set(light.position.x, light.position.y + BAR_HEIGHT, light.position.z)
      _matrix.compose(_pos, _quat, _scale)
      bars.setMatrixAt(index, _matrix)
      // The head starts in the light's own phase, not in white.
      update(node, light, 0)
    })
    bulbs.instanceMatrix.needsUpdate = true
    bars.instanceMatrix.needsUpdate = true

    root.add(bulbs)
    root.add(bars)

    layer.bulbs = bulbs
    layer.bars = bars
    layer.poles = poles
  }

  const update = (node: TrafficLightNode, light: TrafficLight, simTime: number): void => {
    let phase = light.phase
    let visible = true
    if (phase === LightPhase.FlashingYellow) {
      // 1Hz blink — on for 0.5s, off for 0.5s.
      const t = simTime % 1.0
      visible = t < 0.5
    } else if (phase === LightPhase.FlashingRed) {
      // 0.5Hz blink — on for 1s, off for 1s.
      const t = simTime % 2.0
      visible = t < 1.0
    }
    const color = PHASE_COLOR[phase]
    const intensity = visible ? PHASE_EMISSIVE_INTENSITY[phase] : 0

    _color.setHex(color)
    bulbs.setColorAt(node.index, _color)
    bars.setColorAt(node.index, _color)
    if (bulbs.instanceColor) bulbs.instanceColor.needsUpdate = true
    if (bars.instanceColor) bars.instanceColor.needsUpdate = true

    const bulbGlow = bulbGeometry.getAttribute('instanceGlow') as THREE.InstancedBufferAttribute
    const barGlow = barGeometry.getAttribute('instanceGlow') as THREE.InstancedBufferAttribute
    bulbGlow.setX(node.index, intensity)
    bulbGlow.needsUpdate = true
    barGlow.setX(node.index, intensity * BAR_EMISSIVE_FACTOR)
    barGlow.needsUpdate = true

    // Phase-countdown bar: width is the remaining time as a fraction of
    // the current phase's nominal duration. Falls back to red duration
    // for phases PHASE_DURATIONS doesn't list (e.g. GreenLeft) — fine for
    // now; per-phase durations are not defined yet.
    const phaseTotal =
      phase === LightPhase.Green || phase === LightPhase.GreenLeft
        ? PHASE_DURATIONS.green
        : phase === LightPhase.Yellow || phase === LightPhase.YellowLeft
          ? PHASE_DURATIONS.yellow
          : PHASE_DURATIONS.red
    // Clamp to a small positive value so the bar stays visible (not zero-width)
    // on a fresh phase.
    const ratio = Math.max(0.02, Math.min(1, light.phaseRemaining / phaseTotal))
    _scale.set(ratio, 1, 1)
    _pos.set(node.position.x, node.position.y + BAR_HEIGHT, node.position.z)
    _matrix.compose(_pos, _quat, _scale)
    bars.setMatrixAt(node.index, _matrix)
    bars.instanceMatrix.needsUpdate = true
  }

  const lightIdAt = (instanceId: number): string | undefined => ids[instanceId]

  const dispose = (): void => {
    root.remove(bulbs)
    root.remove(bars)
    if (poles) {
      root.remove(poles)
      poles.geometry.dispose()
      poles = null
    }
    bulbs.dispose()
    bars.dispose()
    bulbGeometry.dispose()
    barGeometry.dispose()
    material.dispose()
    poleMaterial.dispose()
    nodes.clear()
    ids.length = 0
    layer.bulbs = bulbs
    layer.bars = bars
    layer.poles = poles
  }

  return layer
}
