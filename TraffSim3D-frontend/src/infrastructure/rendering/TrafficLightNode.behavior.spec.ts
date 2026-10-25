// src/infrastructure/rendering/TrafficLightNode.behavior.spec.ts
//
// The sibling TrafficLightNode.spec.ts pins the two lookup tables; this
// file covers the signal-head layer and the per-frame update — the
// geometry layout, the blink modulation and the phase-countdown bar.
//
// The heads of a whole network share three draw calls: the poles are
// merged into one mesh, the bulbs and the countdown bars are instanced.
// The per-head state (phase colour, emissive intensity, bar width) rides
// along as instance data, so the assertions read THAT instead of a
// material.

import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  createTrafficLightLayer,
  PHASE_COLOR,
  PHASE_EMISSIVE_INTENSITY,
  type TrafficLightLayer,
  type TrafficLightNode,
} from './TrafficLightNode'
import { makeTestLight } from '@__fixtures__/testNetwork'
import { LightPhase } from '@domain/value-objects/Phase'
import { PHASE_DURATIONS } from '@shared/constants/simulation'

/** A layer holding one light, and that light's node. */
const layerWith = (light = makeTestLight({ id: 'tl-1', position: { x: 7, y: 0, z: -3 } })) => {
  const layer = createTrafficLightLayer()
  layer.setLights([light])
  return { layer, light, node: layer.nodes.get(light.id)! }
}

/** The colour the bulb of instance `index` is painted with. */
const bulbColor = (layer: TrafficLightLayer, index: number): THREE.Color =>
  new THREE.Color().fromArray(layer.bulbs.instanceColor!.array as Float32Array, index * 3)

/** The emissive intensity of the bulb of instance `index`. */
const bulbGlow = (layer: TrafficLightLayer, index: number): number =>
  (layer.bulbs.geometry.getAttribute('instanceGlow') as THREE.InstancedBufferAttribute).getX(index)

/** The emissive intensity of the bar of instance `index`. */
const barGlow = (layer: TrafficLightLayer, index: number): number =>
  (layer.bars.geometry.getAttribute('instanceGlow') as THREE.InstancedBufferAttribute).getX(index)

/** The width the countdown bar of instance `index` is scaled to. */
const barWidth = (layer: TrafficLightLayer, index: number): number => {
  const matrix = new THREE.Matrix4().fromArray(
    layer.bars.instanceMatrix.array as Float32Array,
    index * 16,
  )
  return matrix.elements[0]!
}

/** The world position of the bulb of instance `index`. */
const bulbPosition = (layer: TrafficLightLayer, index: number): THREE.Vector3 =>
  new THREE.Vector3().setFromMatrixPosition(
    new THREE.Matrix4().fromArray(layer.bulbs.instanceMatrix.array as Float32Array, index * 16),
  )

describe('createTrafficLightLayer — the head of one light', () => {
  const { layer, node } = layerWith()

  it('anchors the light at its world position', () => {
    expect(node.position.x).toBe(7)
    expect(node.position.y).toBe(0)
    expect(node.position.z).toBe(-3)
  })

  it('draws the whole network in three meshes: poles, bulbs, bars', () => {
    expect(layer.root.children).toHaveLength(3)
    expect(layer.poles).not.toBeNull()
    expect(layer.bulbs.count).toBe(1)
    expect(layer.bars.count).toBe(1)
  })

  it('builds the pole as a 0.15r x 3u cylinder with 8 radial segments', () => {
    const poles = layer.poles!
    const reference = new THREE.CylinderGeometry(0.15, 0.15, 3, 8)
    expect(poles.geometry.attributes.position!.count).toBe(reference.attributes.position!.count)
    poles.geometry.computeBoundingBox()
    const box = poles.geometry.boundingBox!
    expect(box.min.x).toBeCloseTo(7 - 0.15, 6)
    expect(box.max.x).toBeCloseTo(7 + 0.15, 6)
    expect(box.min.y).toBeCloseTo(0, 6)
    expect(box.max.y).toBeCloseTo(3, 6)
    expect(box.min.z).toBeCloseTo(-3 - 0.15, 6)
    expect(box.max.z).toBeCloseTo(-3 + 0.15, 6)
    expect((poles.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x475569)
  })

  it('hangs a 0.6r sphere at y = 3 and a 1.5-wide bar at y = 3.7', () => {
    const sph = (layer.bulbs.geometry as THREE.SphereGeometry).parameters
    expect(sph.radius).toBe(0.6)
    expect(sph.widthSegments).toBe(16)
    expect(sph.heightSegments).toBe(16)
    expect(bulbPosition(layer, 0).y).toBeCloseTo(3, 6)
    expect((layer.bars.geometry as THREE.BoxGeometry).parameters).toMatchObject({
      width: 1.5,
      height: 0.15,
      depth: 0.15,
    })
    const bar = new THREE.Vector3().setFromMatrixPosition(
      new THREE.Matrix4().fromArray(layer.bars.instanceMatrix.array as Float32Array, 0),
    )
    expect(bar.y).toBeCloseTo(3.7, 6)
  })

  it('paints bulb + bar with the initial phase colour and emissive', () => {
    expect(bulbColor(layer, 0).getHex()).toBe(PHASE_COLOR[LightPhase.Green])
    expect(bulbGlow(layer, 0)).toBeCloseTo(0.7, 6)
    // The bar runs at 60% of the bulb's emissive so the bulb dominates.
    expect(barGlow(layer, 0)).toBeCloseTo(0.42, 6)
  })

  it('a Dark light starts unlit', () => {
    const dark = layerWith(makeTestLight({ phase: LightPhase.Dark }))
    expect(bulbColor(dark.layer, 0).getHex()).toBe(0x1a1a1a)
    expect(bulbGlow(dark.layer, 0)).toBe(0)
    expect(barGlow(dark.layer, 0)).toBe(0)
  })

  it('maps an instance id back to its light', () => {
    expect(layer.lightIdAt(0)).toBe('tl-1')
    expect(layer.lightIdAt(7)).toBeUndefined()
  })
})

describe('createTrafficLightLayer — many lights', () => {
  it('gives every light its own instance and keeps the ids in order', () => {
    const layer = createTrafficLightLayer()
    const lights = [
      makeTestLight({ id: 'tl-a', position: { x: 1, y: 0, z: 0 } }),
      makeTestLight({ id: 'tl-b', position: { x: 2, y: 0, z: 0 } }),
      makeTestLight({ id: 'tl-c', position: { x: 3, y: 0, z: 0 } }),
    ]
    layer.setLights(lights)
    expect(layer.bulbs.count).toBe(3)
    expect(layer.bars.count).toBe(3)
    expect(layer.nodes.get('tl-b')!.index).toBe(1)
    expect(layer.lightIdAt(2)).toBe('tl-c')
    // Every light gets its own bulb position.
    expect(bulbPosition(layer, 0).x).toBeCloseTo(1, 6)
    expect(bulbPosition(layer, 2).x).toBeCloseTo(3, 6)
  })

  it('rebuilds the instances when the set of lights changes', () => {
    const layer = createTrafficLightLayer()
    layer.setLights([makeTestLight({ id: 'tl-a' })])
    expect(layer.bulbs.count).toBe(1)
    layer.setLights([makeTestLight({ id: 'tl-a' }), makeTestLight({ id: 'tl-b' })])
    expect(layer.bulbs.count).toBe(2)
    expect(layer.nodes.has('tl-b')).toBe(true)
  })
})

describe('update — phase colour', () => {
  it('switches the bulb to the new phase colour and emissive', () => {
    const { layer, node } = layerWith(makeTestLight({ phase: LightPhase.Green }))
    layer.update(node, makeTestLight({ phase: LightPhase.Red }), 0)
    expect(bulbColor(layer, 0).getHex()).toBe(0xef4444)
    expect(bulbGlow(layer, 0)).toBeCloseTo(0.7, 6)
    expect(barGlow(layer, 0)).toBeCloseTo(0.42, 6)
  })

  it('keeps Dark unlit whatever the sim clock says', () => {
    const { layer, node } = layerWith(makeTestLight({ phase: LightPhase.Green }))
    layer.update(node, makeTestLight({ phase: LightPhase.Dark, phaseRemaining: 10 }), 0.25)
    expect(bulbGlow(layer, 0)).toBe(0)
  })
})

describe('update — blink modulation', () => {
  it('FlashingYellow blinks at 1 Hz (on for 0.5 s, off for 0.5 s)', () => {
    const { layer, node } = layerWith()
    const fy = makeTestLight({ phase: LightPhase.FlashingYellow, phaseRemaining: 0.5 })
    layer.update(node, fy, 0.0)
    expect(bulbGlow(layer, 0)).toBeCloseTo(0.5, 6) // on
    layer.update(node, fy, 0.49)
    expect(bulbGlow(layer, 0)).toBeCloseTo(0.5, 6) // still on
    layer.update(node, fy, 0.5)
    expect(bulbGlow(layer, 0)).toBe(0) // off
    layer.update(node, fy, 0.75)
    expect(bulbGlow(layer, 0)).toBe(0)
    // 1.49 % 1 = 0.49 -> back on; 1.5 % 1 = 0.5 exactly -> off again (the
    // on-window is the half-open [n, n+0.5)).
    layer.update(node, fy, 1.49)
    expect(bulbGlow(layer, 0)).toBeCloseTo(0.5, 6)
    layer.update(node, fy, 1.5)
    expect(bulbGlow(layer, 0)).toBe(0)
    layer.update(node, fy, 2.0)
    expect(bulbGlow(layer, 0)).toBeCloseTo(0.5, 6) // second cycle
  })

  it('FlashingRed blinks at 0.5 Hz (on for 1 s, off for 1 s)', () => {
    const { layer, node } = layerWith()
    const fr = makeTestLight({ phase: LightPhase.FlashingRed, phaseRemaining: 1 })
    layer.update(node, fr, 0.9)
    expect(bulbGlow(layer, 0)).toBeCloseTo(0.5, 6)
    layer.update(node, fr, 1.0)
    expect(bulbGlow(layer, 0)).toBe(0)
    layer.update(node, fr, 2.0)
    expect(bulbGlow(layer, 0)).toBeCloseTo(0.5, 6)
  })

  it('the bar mirrors the bulb blink at 60% intensity', () => {
    const { layer, node } = layerWith()
    layer.update(node, makeTestLight({ phase: LightPhase.FlashingYellow }), 0.2)
    expect(barGlow(layer, 0)).toBeCloseTo(0.3, 6)
    layer.update(node, makeTestLight({ phase: LightPhase.FlashingYellow }), 0.8)
    expect(barGlow(layer, 0)).toBe(0)
  })

  it('a steady phase ignores simTime entirely', () => {
    const { layer, node } = layerWith(makeTestLight({ phase: LightPhase.Red }))
    for (const t of [0, 0.5, 1, 1.9, 100]) {
      layer.update(node, makeTestLight({ phase: LightPhase.Red }), t)
      expect(bulbGlow(layer, 0)).toBeCloseTo(0.7, 6)
    }
  })
})

describe('update — phase countdown bar', () => {
  it('scales the bar to phaseRemaining / phaseTotal', () => {
    const { layer, node } = layerWith()
    expect(PHASE_DURATIONS.green).toBe(30)
    layer.update(node, makeTestLight({ phase: LightPhase.Green, phaseRemaining: 30 }), 0)
    expect(barWidth(layer, 0)).toBeCloseTo(1, 6)
    layer.update(node, makeTestLight({ phase: LightPhase.Green, phaseRemaining: 15 }), 0)
    expect(barWidth(layer, 0)).toBeCloseTo(0.5, 6)
  })

  it('never collapses below 0.02 so a fresh phase is still visible', () => {
    const { layer, node } = layerWith()
    layer.update(node, makeTestLight({ phase: LightPhase.Green, phaseRemaining: 0 }), 0)
    expect(barWidth(layer, 0)).toBeCloseTo(0.02, 6)
    layer.update(node, makeTestLight({ phase: LightPhase.Green, phaseRemaining: -5 }), 0)
    expect(barWidth(layer, 0)).toBeCloseTo(0.02, 6)
  })

  it('clamps an over-long remaining time to full width', () => {
    const { layer, node } = layerWith()
    layer.update(node, makeTestLight({ phase: LightPhase.Green, phaseRemaining: 999 }), 0)
    expect(barWidth(layer, 0)).toBeCloseTo(1, 6)
  })

  it('uses the 3 s yellow duration, not the 30 s green one', () => {
    const { layer, node } = layerWith()
    expect(PHASE_DURATIONS.yellow).toBe(3)
    layer.update(node, makeTestLight({ phase: LightPhase.Yellow, phaseRemaining: 1.5 }), 0)
    expect(barWidth(layer, 0)).toBeCloseTo(0.5, 6)
    layer.update(node, makeTestLight({ phase: LightPhase.Yellow, phaseRemaining: 9 }), 0)
    expect(barWidth(layer, 0)).toBeCloseTo(1, 6)
  })

  it('the left-arrow phases reuse the base green / yellow durations', () => {
    const { layer, node } = layerWith()
    layer.update(node, makeTestLight({ phase: LightPhase.GreenLeft, phaseRemaining: 10 }), 0)
    expect(barWidth(layer, 0)).toBeCloseTo(10 / 30, 6)
    layer.update(node, makeTestLight({ phase: LightPhase.YellowLeft, phaseRemaining: 1 }), 0)
    expect(barWidth(layer, 0)).toBeCloseTo(1 / 3, 6)
  })

  it('AllRed and the flashing phases fall back to the 36 s red duration', () => {
    const { layer, node } = layerWith()
    expect(PHASE_DURATIONS.red).toBe(36)
    for (const phase of [LightPhase.AllRed, LightPhase.RedLeft, LightPhase.FlashingRed]) {
      layer.update(node, makeTestLight({ phase, phaseRemaining: 6 }), 0)
      expect(barWidth(layer, 0)).toBeCloseTo(6 / 36, 6)
    }
  })

  it('a Dark phase still renders the countdown bar', () => {
    const { layer, node } = layerWith()
    layer.update(node, makeTestLight({ phase: LightPhase.Dark, phaseRemaining: 36 }), 0)
    expect(barWidth(layer, 0)).toBeCloseTo(1, 6)
    expect(barGlow(layer, 0)).toBe(0)
  })

  it('does not move the bulb', () => {
    const { layer, node } = layerWith(makeTestLight({ position: { x: 7, y: 0, z: -3 } }))
    const before = bulbPosition(layer, 0)
    layer.update(node, makeTestLight({ phase: LightPhase.Red, position: { x: 99, y: 9, z: 9 } }), 0)
    expect(bulbPosition(layer, 0)).toEqual(before)
  })

  it('every LightPhase has both a colour and an emissive intensity', () => {
    const phases = Object.values(LightPhase)
    expect(phases).toHaveLength(10)
    for (const phase of phases) {
      expect(PHASE_COLOR[phase]).toBeTypeOf('number')
      expect(PHASE_EMISSIVE_INTENSITY[phase]).toBeTypeOf('number')
      // Only Dark is unlit; every other phase glows.
      if (phase === LightPhase.Dark) expect(PHASE_EMISSIVE_INTENSITY[phase]).toBe(0)
      else expect(PHASE_EMISSIVE_INTENSITY[phase]).toBeGreaterThan(0)
    }
  })
})

describe('the signal head material', () => {
  it('carries the phase colour and the glow as instance data', () => {
    const { layer, node } = layerWith()
    const material = layer.bulbs.material as THREE.MeshStandardMaterial
    // The colour and the emissive are white in the material: the phase
    // colour arrives per instance, so one material serves every head.
    expect(material.color.getHex()).toBe(0xffffff)
    expect(material.emissive.getHex()).toBe(0xffffff)
    expect(layer.bulbs.instanceColor).not.toBeNull()
    expect(layer.bulbs.geometry.getAttribute('instanceGlow')).toBeDefined()
    layer.update(node, makeTestLight({ phase: LightPhase.Red }), 0)
    expect(bulbColor(layer, 0).getHex()).toBe(PHASE_COLOR[LightPhase.Red])
  })
})
