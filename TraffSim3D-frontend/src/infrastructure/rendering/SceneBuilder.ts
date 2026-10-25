import * as THREE from 'three'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { TrafficLight } from '@domain/entities/TrafficLight'
import { createGroundMesh, GROUND_DEFAULT_SIZE, GROUND_PADDING } from './GroundMesh'

/** Rendering mode. `flat` (default) renders the ground
 *  + road meshes as Three.js geometry — used by /scene-editor for
 *  the standalone simulator view. `smart-city` skips ground + roads
 *  because Cesium provides the basemap underneath; Three.js only
 *  draws dynamic entities (vehicles, lights, LiDAR). */
export type RenderMode = 'flat' | 'smart-city'

import { createRoadMesh } from './RoadMesh'
import { createRoadMarkings } from './RoadMarkingsMesh'
import {
  createTrafficLightLayer,
  type TrafficLightLayer,
  type TrafficLightNode,
} from './TrafficLightNode'
import { createSelectionRing } from './SelectionRingMesh'
import { createVehicleInstances, type VehicleInstances } from './VehicleInstances'

const Y_SELECTION_RING_BASE = 0.05

export interface BuiltScene {
  root: THREE.Group
  /** Instanced vehicle rendering (3 InstancedMesh, one per type). */
  vehicles: VehicleInstances
  lightNodes: Map<string, TrafficLightNode>
  /** The signal heads of the whole network, in three draw calls. */
  lightLayer: TrafficLightLayer
  /**
   * The network's road surface — every road merged into ONE mesh, so the
   * carriageway costs one draw call instead of one per road.
   */
  roadSurface: THREE.Mesh | null
  /**
   * The network's painted markings — every centre line, dash, stop line
   * and arrow merged into ONE line mesh.
   */
  roadMarkings: THREE.Group | null
  /** Single ring, reparented/repositioned per selection. Hidden when nothing is selected. */
  selectionRing: THREE.Mesh
}

/** Every traffic light of the network, in the order the junctions list them. */
const collectLights = (network: RoadNetwork): TrafficLight[] => {
  const lights: TrafficLight[] = []
  for (const inter of Object.values(network.intersections)) {
    for (const light of inter.trafficLights) lights.push(light)
  }
  return lights
}

export const buildScene = (network: RoadNetwork, mode: RenderMode = 'flat'): BuiltScene => {
  const root = new THREE.Group()
  // Ground size scales with the network bbox so a 5km
  // OSM district doesn't show a visible 200m gray square when the
  // camera zooms out. For small synthetic scenes (cross, t, loop,
  // corridor) we use 2× the diagonal so the road never sits on the
  // very edge of the ground (the visible gray "background" the user
  // reported earlier). Fog hides the ground edge for both small and
  // large scenes.
  let groundSize = GROUND_DEFAULT_SIZE
  let halfExtent = GROUND_DEFAULT_SIZE / 2
  const xs: number[] = []
  const zs: number[] = []
  for (const r of Object.values(network.roads)) {
    xs.push(r.startNode.x, r.endNode.x)
    zs.push(r.startNode.z, r.endNode.z)
  }
  for (const i of Object.values(network.intersections)) {
    xs.push(i.position.x)
    zs.push(i.position.z)
  }
  if (xs.length > 0) {
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minZ = Math.min(...zs)
    const maxZ = Math.max(...zs)
    const diag = Math.hypot(maxX - minX, maxZ - minZ)
    if (diag > 1) {
      halfExtent = Math.max(diag / 2, 50)
      groundSize = Math.max(GROUND_DEFAULT_SIZE, Math.ceil(diag * 2 + GROUND_PADDING))
    }
  }
  if (mode === 'flat') {
    root.add(createGroundMesh(groundSize))
  } else {
    // Invisible ground at y=0 to receive Three.js raycasts
    // (vehicle pick, hover). The Cesium basemap provides the visible
    // ground; this is purely a pick surface.
    const pickPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(groundSize, groundSize),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pickPlane.rotation.x = -Math.PI / 2
    pickPlane.name = 'pick-plane'
    root.add(pickPlane)
  }

  let roadSurface: THREE.Mesh | null = null
  let roadMarkings: THREE.Group | null = null
  // Smart-city mode skips Three.js road meshes because
  // Cesium draws roads from real OSM data (GeoJsonDataSource).
  if (mode === 'flat') {
    const roads = Object.values(network.roads)
    const intersections = Object.values(network.intersections)
    // The whole carriageway is one mesh and the whole paint is one line
    // mesh: the geometry is the same as when every road had a mesh of
    // its own, but the scene spends two draw calls on it instead of
    // hundreds.
    if (roads.length > 0) {
      roadSurface = createRoadMesh(roads)
      root.add(roadSurface)
    }
    // The intersections go along so the painted stop lines land where the
    // traffic logic stops a vehicle (same projection, same source).
    roadMarkings = createRoadMarkings(roads, { intersections })
    root.add(roadMarkings)
  }

  // Instanced vehicle rendering.
  const vehicles = createVehicleInstances()
  for (const type of ['car', 'truck', 'bus'] as const) {
    root.add(vehicles.meshes[type])
  }
  for (const v of Object.values(network.vehicles)) {
    vehicles.allocate(v)
    const trail = vehicles.trails.get(v.id)
    if (trail) root.add(trail.line)
  }

  const lightLayer = createTrafficLightLayer()
  lightLayer.setLights(collectLights(network))
  root.add(lightLayer.root)
  const lightNodes = lightLayer.nodes

  const selectionRing = createSelectionRing()
  root.add(selectionRing)

  return { root, vehicles, lightNodes, lightLayer, roadSurface, roadMarkings, selectionRing }
}

/**
 * Sync mesh transforms (positions, colors, trail buffers, phase bars) from
 * a mutated network to an already-built scene. Cheaper than rebuilding —
 * called every frame after `onTick` has mutated the network in place.
 *
 * `simTime` is the world-store simulation time in seconds; used by
 * TrafficLightNode for FlashingYellow / FlashingRed blink modulation
 * (1Hz / 0.5Hz). Vehicles don't need it.
 */
export const syncMeshTransforms = (
  network: RoadNetwork,
  built: BuiltScene,
  simTime: number,
): void => {
  for (const v of Object.values(network.vehicles)) {
    built.vehicles.update(v)
  }
  for (const inter of Object.values(network.intersections)) {
    for (const light of inter.trafficLights) {
      const node = built.lightNodes.get(light.id)
      if (node) built.lightLayer.update(node, light, simTime)
    }
  }
}

/**
 * Diff the network against the built scene and add/remove nodes to match.
 * Required because `worldStore.addVehicle / removeVehicle / addTrafficLight /
 * removeTrafficLight` mutate the same network object in place — the
 * renderer's identity check (`network !== currentNetwork`) only fires on
 * reset/hydrate, so we need this incremental path for add/remove.
 */
export const syncSceneContents = (network: RoadNetwork, built: BuiltScene): void => {
  // Vehicles use instanced pool, not individual nodes.
  const liveVehicleIds = new Set(Object.keys(network.vehicles))
  const allocatedIds = new Set(built.vehicles.trails.keys())

  for (const id of allocatedIds) {
    if (!liveVehicleIds.has(id)) {
      const trail = built.vehicles.trails.get(id)
      if (trail) built.root.remove(trail.line)
      built.vehicles.remove(id)
    }
  }
  for (const id of liveVehicleIds) {
    if (!built.vehicles.trails.has(id)) {
      const v = network.vehicles[id]
      if (!v) continue
      built.vehicles.allocate(v)
      const trail = built.vehicles.trails.get(id)
      if (trail) built.root.add(trail.line)
    }
  }

  // Lights (lights live under intersections, not at the top level of the
  // network). The heads share three meshes, so a change in the set of
  // lights rebuilds them — the cheap path (no change) is the norm.
  const liveLights = collectLights(network)
  if (liveLights.length !== built.lightNodes.size) {
    built.lightLayer.setLights(liveLights)
  } else {
    for (const light of liveLights) {
      if (!built.lightNodes.has(light.id)) {
        built.lightLayer.setLights(liveLights)
        break
      }
    }
  }
}

/** Move the selection ring to the currently selected entity, or hide it. */
export const syncSelection = (
  built: BuiltScene,
  selected: { kind: 'vehicle' | 'light'; id: string } | null,
): void => {
  const ring = built.selectionRing
  if (!selected) {
    ring.visible = false
    return
  }
  let pos: THREE.Vector3 | null = null
  if (selected.kind === 'vehicle') {
    pos = built.vehicles.getPosition(selected.id)
  } else {
    const node = built.lightNodes.get(selected.id)
    if (node) pos = node.position
  }
  if (!pos) {
    ring.visible = false
    return
  }
  ring.visible = true
  ring.position.set(pos.x, pos.y + Y_SELECTION_RING_BASE, pos.z)
}
