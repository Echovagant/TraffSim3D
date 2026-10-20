// src/infrastructure/rendering/SceneBuilder.spec.ts
//
// buildScene assembles the whole render tree from a RoadNetwork; the
// three sync* functions keep it reconciled afterwards. The ground-size
// formula, the flat vs smart-city split, and the incremental
// add/remove diff are all pure decisions that assert without a GPU.

import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import {
  buildScene,
  syncMeshTransforms,
  syncSceneContents,
  syncSelection,
  type BuiltScene,
} from './SceneBuilder'
import {
  buildTestNetwork,
  makeTestRoad,
  makeTestVehicle,
  makeTestLight,
} from '@__fixtures__/testNetwork'
import { createRoadNetwork } from '@domain/entities/RoadNetwork'
import { GROUND_DEFAULT_SIZE, GROUND_PADDING } from './GroundMesh'
import { LightPhase } from '@domain/value-objects/Phase'

const groundOf = (built: BuiltScene): THREE.Mesh =>
  built.root.children.find(
    (c): c is THREE.Mesh =>
      c instanceof THREE.Mesh && c.geometry.type === 'PlaneGeometry' && c.name !== 'pick-plane',
  )!

/** The lit ground and the smart-city pick plane are both PlaneGeometry —
 *  `parameters` is declared on the concrete class, not on BufferGeometry. */
const planeWidth = (mesh: THREE.Mesh): number =>
  (mesh.geometry as THREE.PlaneGeometry).parameters.width

describe('buildScene — ground sizing (Plan 054)', () => {
  it('scales the ground to max(200, ceil(diag * 2 + 1000)) for the 60x60 cross network', () => {
    const built = buildScene(buildTestNetwork(0))
    // xs span -30..30, zs span -30..30 -> diag = hypot(60, 60)
    const diag = Math.hypot(60, 60)
    const expected = Math.max(GROUND_DEFAULT_SIZE, Math.ceil(diag * 2 + GROUND_PADDING))
    expect(expected).toBe(1170)
    expect(planeWidth(groundOf(built))).toBe(expected)
  })

  it('keeps the 200u default for a scene smaller than 1u across', () => {
    const net = createRoadNetwork()
    net.roads['r-tiny'] = {
      ...makeTestRoad('r-tiny', 'ns', 2),
      startNode: { x: 0, y: 0, z: 0 },
      endNode: { x: 0, y: 0, z: 0.5 },
    }
    const built = buildScene(net)
    expect(planeWidth(groundOf(built))).toBe(GROUND_DEFAULT_SIZE)
  })

  it('scales up for an OSM-scale district (5 km across)', () => {
    const net = createRoadNetwork()
    net.roads['r-a'] = {
      ...makeTestRoad('r-a', 'ns', 2),
      startNode: { x: 0, y: 0, z: 0 },
      endNode: { x: 0, y: 0, z: 2500 },
    }
    net.roads['r-b'] = {
      ...makeTestRoad('r-b', 'ew', 2),
      startNode: { x: 0, y: 0, z: 0 },
      endNode: { x: 2500, y: 0, z: 0 },
    }
    const built = buildScene(net)
    const diag = Math.hypot(2500, 2500)
    expect(planeWidth(groundOf(built))).toBe(Math.ceil(diag * 2 + GROUND_PADDING))
  })

  it('falls back to the default ground for an empty network', () => {
    const built = buildScene(createRoadNetwork())
    expect(planeWidth(groundOf(built))).toBe(GROUND_DEFAULT_SIZE)
    expect(built.roadNodes.size).toBe(0)
    expect(built.lightNodes.size).toBe(0)
  })
})

describe('buildScene — flat mode (default)', () => {
  const net = buildTestNetwork(2)
  const built = buildScene(net)

  it('adds ground + one group per road + 3 instance meshes + trails + lights + ring', () => {
    // 1 ground + 2 road groups + 3 vehicle meshes + 2 trails + 1 light + 1 ring
    expect(built.root.children).toHaveLength(10)
  })

  it('indexes road nodes by road id, each holding the mesh + its markings group', () => {
    expect([...built.roadNodes.keys()].sort()).toEqual(['r-ew', 'r-ns'])
    for (const node of built.roadNodes.values()) {
      expect(node.group.children).toHaveLength(2)
      expect((node.group.children[0] as THREE.Mesh).isMesh).toBe(true)
      expect((node.group.children[1] as THREE.Group).isGroup).toBe(true)
    }
  })

  it('indexes light nodes by light id and parents each group into the root', () => {
    expect([...built.lightNodes.keys()]).toEqual(['tl-1'])
    const node = built.lightNodes.get('tl-1')!
    expect(built.root.children).toContain(node.group)
    expect(node.group.children).toHaveLength(3)
  })

  it('allocates every network vehicle into the instanced pool and parents its trail', () => {
    expect(built.vehicles.trails.size).toBe(2)
    expect(built.vehicles.meshes.car.count).toBe(2)
    for (const v of Object.values(net.vehicles)) {
      const trail = built.vehicles.trails.get(v.id)!
      expect(trail).toBeDefined()
      expect(built.root.children).toContain(trail.line)
    }
  })

  it('adds all three type meshes even when a type is unused', () => {
    for (const t of ['car', 'truck', 'bus'] as const) {
      expect(built.root.children).toContain(built.vehicles.meshes[t])
    }
  })

  it('adds a hidden selection ring last', () => {
    expect(built.root.children.at(-1)).toBe(built.selectionRing)
    expect(built.selectionRing.visible).toBe(false)
  })
})

describe('buildScene — smart-city mode (Plan 055)', () => {
  const built = buildScene(buildTestNetwork(2), 'smart-city')

  it('replaces the lit ground with an invisible pick plane', () => {
    const plane = built.root.children.find((c) => c.name === 'pick-plane') as THREE.Mesh
    expect(plane).toBeDefined()
    expect((plane.material as THREE.MeshBasicMaterial).visible).toBe(false)
    expect(plane.rotation.x).toBeCloseTo(-Math.PI / 2, 12)
    expect(planeWidth(plane)).toBe(1170)
  })

  it('skips the Three.js road meshes — Cesium draws the basemap', () => {
    expect(built.roadNodes.size).toBe(0)
    // pick plane + 3 meshes + 2 trails + 1 light + 1 ring
    expect(built.root.children).toHaveLength(8)
  })
})

describe('syncMeshTransforms', () => {
  it('moves the instance matrix for a vehicle that moved', () => {
    const net = buildTestNetwork(1)
    const built = buildScene(net)
    net.vehicles['v-1']!.position.x = 40
    net.vehicles['v-1']!.heading = Math.PI / 2
    syncMeshTransforms(net, built, 0)
    const p = built.vehicles.getPosition('v-1')!
    expect(p.x).toBeCloseTo(40, 6)
  })

  it('drives the traffic-light countdown bar from phaseRemaining', () => {
    const net = buildTestNetwork(0)
    const built = buildScene(net)
    const node = built.lightNodes.get('tl-1')!
    net.intersections['i-1']!.trafficLights[0]!.phaseRemaining = 15
    syncMeshTransforms(net, built, 0)
    expect(node.bar.scale.x).toBeCloseTo(0.5, 6)
  })

  it('blinks a flashing light off mid-cycle', () => {
    const net = buildTestNetwork(0, { phase: LightPhase.FlashingYellow })
    const built = buildScene(net)
    const node = built.lightNodes.get('tl-1')!
    syncMeshTransforms(net, built, 0.25)
    expect(node.sphereMaterial.emissiveIntensity).toBe(0.5)
    syncMeshTransforms(net, built, 0.75)
    expect(node.sphereMaterial.emissiveIntensity).toBe(0)
  })

  it('is a no-op for a light the scene does not know about', () => {
    const net = buildTestNetwork(0)
    const built = buildScene(net)
    net.intersections['i-1']!.trafficLights.push(makeTestLight({ id: 'tl-ghost' }))
    expect(() => syncMeshTransforms(net, built, 0)).not.toThrow()
    expect(built.lightNodes.has('tl-ghost')).toBe(false)
  })
})

describe('syncSceneContents — vehicles', () => {
  it('frees a vehicle that left the network, unparenting its trail', () => {
    const net = buildTestNetwork(2)
    const built = buildScene(net)
    const trail = built.vehicles.trails.get('v-1')!
    delete net.vehicles['v-1']

    syncSceneContents(net, built)

    expect(built.vehicles.trails.has('v-1')).toBe(false)
    expect(built.vehicles.getPosition('v-1')).toBeNull()
    expect(built.root.children).not.toContain(trail.line)
  })

  it('allocates a vehicle that was added to the network', () => {
    const net = buildTestNetwork(1)
    const built = buildScene(net)
    net.vehicles['v-9'] = makeTestVehicle({ id: 'v-9', position: { x: 12, y: 0, z: 3 } })

    syncSceneContents(net, built)

    expect(built.vehicles.trails.has('v-9')).toBe(true)
    expect(built.root.children).toContain(built.vehicles.trails.get('v-9')!.line)
    expect(built.vehicles.getPosition('v-9')!.x).toBeCloseTo(12, 6)
  })

  it('is a no-op when the network is unchanged', () => {
    const net = buildTestNetwork(2)
    const built = buildScene(net)
    const before = built.root.children.length
    syncSceneContents(net, built)
    expect(built.root.children).toHaveLength(before)
    expect(built.vehicles.trails.size).toBe(2)
  })
})

describe('syncSceneContents — traffic lights', () => {
  it('builds a node for a light added under an existing intersection', () => {
    const net = buildTestNetwork(0)
    const built = buildScene(net)
    const before = built.root.children.length
    net.intersections['i-1']!.trafficLights.push(
      makeTestLight({ id: 'tl-2', position: { x: 9, y: 0, z: 1 } }),
    )

    syncSceneContents(net, built)

    expect(built.lightNodes.has('tl-2')).toBe(true)
    expect(built.root.children).toHaveLength(before + 1)
    expect(built.root.children).toContain(built.lightNodes.get('tl-2')!.group)
  })

  it('disposes and unparents a node whose light left the network', () => {
    const net = buildTestNetwork(0)
    const built = buildScene(net)
    const node = built.lightNodes.get('tl-1')!
    const pole = node.group.children[0] as THREE.Mesh
    const spies = [
      vi.spyOn(node.sphere.geometry, 'dispose'),
      vi.spyOn(node.sphereMaterial, 'dispose'),
      vi.spyOn(node.bar.geometry, 'dispose'),
      vi.spyOn(node.barMaterial, 'dispose'),
      vi.spyOn(pole.geometry, 'dispose'),
      vi.spyOn(pole.material as THREE.Material, 'dispose'),
    ]

    net.intersections['i-1']!.trafficLights = []
    syncSceneContents(net, built)

    expect(built.lightNodes.has('tl-1')).toBe(false)
    expect(built.root.children).not.toContain(node.group)
    for (const s of spies) expect(s).toHaveBeenCalledTimes(1)
  })

  it('removes a light that lost its intersection entirely', () => {
    const net = buildTestNetwork(0)
    const built = buildScene(net)
    delete net.intersections['i-1']
    syncSceneContents(net, built)
    expect(built.lightNodes.size).toBe(0)
  })
})

describe('syncSelection', () => {
  it('hides the ring when nothing is selected', () => {
    const built = buildScene(buildTestNetwork(1))
    syncSelection(built, null)
    expect(built.selectionRing.visible).toBe(false)
  })

  it('moves the ring onto a vehicle instance, lifted 0.05u', () => {
    const built = buildScene(buildTestNetwork(1))
    syncSelection(built, { kind: 'vehicle', id: 'v-1' })
    const ring = built.selectionRing
    const p = built.vehicles.getPosition('v-1')!
    expect(ring.visible).toBe(true)
    expect(ring.position.x).toBeCloseTo(p.x, 10)
    expect(ring.position.y).toBeCloseTo(p.y + 0.05, 10)
    expect(ring.position.z).toBeCloseTo(p.z, 10)
  })

  it('moves the ring onto a traffic-light group', () => {
    const net = buildTestNetwork(0)
    net.intersections['i-1']!.trafficLights[0]!.position = { x: 7, y: 1, z: -3 }
    const built = buildScene(net)
    syncSelection(built, { kind: 'light', id: 'tl-1' })
    expect(built.selectionRing.visible).toBe(true)
    expect(built.selectionRing.position.x).toBeCloseTo(7, 10)
    expect(built.selectionRing.position.y).toBeCloseTo(1.05, 10)
    expect(built.selectionRing.position.z).toBeCloseTo(-3, 10)
  })

  it('hides the ring for a stale selection of a departed entity', () => {
    const built = buildScene(buildTestNetwork(1))
    syncSelection(built, { kind: 'vehicle', id: 'v-1' })
    expect(built.selectionRing.visible).toBe(true)
    syncSelection(built, { kind: 'vehicle', id: 'gone' })
    expect(built.selectionRing.visible).toBe(false)
    syncSelection(built, { kind: 'light', id: 'gone' })
    expect(built.selectionRing.visible).toBe(false)
  })

  it('follows the vehicle as it moves', () => {
    const net = buildTestNetwork(1)
    const built = buildScene(net)
    syncSelection(built, { kind: 'vehicle', id: 'v-1' })
    const before = built.selectionRing.position.x
    net.vehicles['v-1']!.position.x = 25
    syncMeshTransforms(net, built, 0)
    syncSelection(built, { kind: 'vehicle', id: 'v-1' })
    expect(built.selectionRing.position.x).toBeGreaterThan(before)
    expect(built.selectionRing.position.x).toBeCloseTo(25, 6)
  })
})
