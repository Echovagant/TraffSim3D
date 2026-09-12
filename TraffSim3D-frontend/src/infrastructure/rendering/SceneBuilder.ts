import * as THREE from 'three';
import type { RoadNetwork } from '@domain/entities/RoadNetwork';
import type { TrafficLight } from '@domain/entities/TrafficLight';
import type { Road } from '@domain/entities/Road';
import { createGroundMesh, GROUND_DEFAULT_SIZE, GROUND_PADDING } from './GroundMesh';

/** Plan 055: rendering mode. `flat` (default) renders the ground
 *  + road meshes as Three.js geometry — used by /scene-editor for
 *  the standalone simulator view. `smart-city` skips ground + roads
 *  because Cesium provides the basemap underneath; Three.js only
 *  draws dynamic entities (vehicles, lights, LiDAR). */
export type RenderMode = 'flat' | 'smart-city';

import { createRoadMesh } from './RoadMesh';
import { createRoadMarkings } from './RoadMarkingsMesh';
import { createTrafficLightNode, updateTrafficLightNode, type TrafficLightNode } from './TrafficLightNode';
import { createSelectionRing } from './SelectionRingMesh';
import { createVehicleInstances, type VehicleInstances } from './VehicleInstances';

const Y_SELECTION_RING_BASE = 0.05;

export interface RoadNode {
  /** Group containing the road plane + lane markings. */
  group: THREE.Group;
}

export interface BuiltScene {
  root: THREE.Group;
  /** Plan 062: instanced vehicle rendering (3 InstancedMesh, one per type). */
  vehicles: VehicleInstances;
  lightNodes: Map<string, TrafficLightNode>;
  roadNodes: Map<string, RoadNode>;
  /** Single ring, reparented/repositioned per selection. Hidden when nothing is selected. */
  selectionRing: THREE.Mesh;
}

/** Per-frame update for a traffic light: delegated to TrafficLightNode
 *  which now owns all phase-specific logic (color, emissive, flashing,
 *  countdown bar). */
const updateLightNode = (
  light: TrafficLight,
  node: TrafficLightNode,
  simTime: number,
): void => {
  updateTrafficLightNode(node, light, simTime);
};

const disposeLightNode = (node: TrafficLightNode): void => {
  node.sphere.geometry.dispose();
  node.sphereMaterial.dispose();
  node.bar.geometry.dispose();
  node.barMaterial.dispose();
  // First child is the pole.
  const pole = node.group.children[0];
  if (pole instanceof THREE.Mesh) {
    pole.geometry.dispose();
    (pole.material as THREE.Material).dispose();
  }
};

const disposeRoadNode = (node: RoadNode): void => {
  for (const child of node.group.children) {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    } else if (child instanceof THREE.Line || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
  }
};

const buildRoadNode = (road: Road): RoadNode => {
  const group = new THREE.Group();
  group.add(createRoadMesh(road));
  group.add(createRoadMarkings(road));
  return { group };
};

const buildLightNode = (light: TrafficLight): TrafficLightNode => createTrafficLightNode(light);

export const buildScene = (
  network: RoadNetwork,
  mode: RenderMode = 'flat',
): BuiltScene => {
  const root = new THREE.Group();
  // Plan 054: ground size scales with the network bbox so a 5km
  // OSM district doesn't show a visible 200m gray square when the
  // camera zooms out. For small synthetic scenes (cross, t, loop,
  // corridor) we use 2× the diagonal so the road never sits on the
  // very edge of the ground (the visible gray "background" the user
  // reported in 054b). Fog hides the ground edge for both small and
  // large scenes.
  let groundSize = GROUND_DEFAULT_SIZE;
  let halfExtent = GROUND_DEFAULT_SIZE / 2;
  const xs: number[] = [];
  const zs: number[] = [];
  for (const r of Object.values(network.roads)) {
    xs.push(r.startNode.x, r.endNode.x);
    zs.push(r.startNode.z, r.endNode.z);
  }
  for (const i of Object.values(network.intersections)) {
    xs.push(i.position.x);
    zs.push(i.position.z);
  }
  if (xs.length > 0) {
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const diag = Math.hypot(maxX - minX, maxZ - minZ);
    if (diag > 1) {
      halfExtent = Math.max(diag / 2, 50);
      groundSize = Math.max(
        GROUND_DEFAULT_SIZE,
        Math.ceil(diag * 2 + GROUND_PADDING),
      );
    }
  }
  if (mode === 'flat') {
    root.add(createGroundMesh(groundSize));
  } else {
    // Plan 055: invisible ground at y=0 to receive Three.js raycasts
    // (vehicle pick, hover). The Cesium basemap provides the visible
    // ground; this is purely a pick surface.
    const pickPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(groundSize, groundSize),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    pickPlane.rotation.x = -Math.PI / 2;
    pickPlane.name = 'pick-plane';
    root.add(pickPlane);
  }

  const roadNodes = new Map<string, RoadNode>();
  // Plan 055: smart-city mode skips Three.js road meshes because
  // Cesium draws roads from real OSM data (GeoJsonDataSource).
  if (mode === 'flat') {
    for (const road of Object.values(network.roads)) {
      const node = buildRoadNode(road);
      root.add(node.group);
      roadNodes.set(road.id, node);
    }
  }

  // Plan 062: instanced vehicle rendering.
  const vehicles = createVehicleInstances();
  for (const type of ['car', 'truck', 'bus'] as const) {
    root.add(vehicles.meshes[type]);
  }
  for (const v of Object.values(network.vehicles)) {
    vehicles.allocate(v);
    const trail = vehicles.trails.get(v.id);
    if (trail) root.add(trail.line);
  }

  const lightNodes = new Map<string, TrafficLightNode>();
  for (const inter of Object.values(network.intersections)) {
    for (const light of inter.trafficLights) {
      const node = buildLightNode(light);
      root.add(node.group);
      lightNodes.set(light.id, node);
    }
  }

  const selectionRing = createSelectionRing();
  root.add(selectionRing);

  return { root, vehicles, lightNodes, roadNodes, selectionRing };
};

/**
 * Sync mesh transforms (positions, colors, trail buffers, phase bars) from
 * a mutated network to an already-built scene. Cheaper than rebuilding —
 * called every frame after `onTick` has mutated the network in place.
 *
 * `simTime` is the world-store simulation time in seconds; used by
 * TrafficLightNode for FlashingYellow / FlashingRed blink modulation
 * (1Hz / 0.5Hz). Vehicles don't need it.
 */
export const syncMeshTransforms = (network: RoadNetwork, built: BuiltScene, simTime: number): void => {
  for (const v of Object.values(network.vehicles)) {
    built.vehicles.update(v);
  }
  for (const inter of Object.values(network.intersections)) {
    for (const light of inter.trafficLights) {
      const node = built.lightNodes.get(light.id);
      if (node) updateLightNode(light, node, simTime);
    }
  }
};

/**
 * Diff the network against the built scene and add/remove nodes to match.
 * Required because `worldStore.addVehicle / removeVehicle / addTrafficLight /
 * removeTrafficLight` mutate the same network object in place — the
 * renderer's identity check (`network !== currentNetwork`) only fires on
 * reset/hydrate, so we need this incremental path for add/remove.
 */
export const syncSceneContents = (network: RoadNetwork, built: BuiltScene): void => {
  // Plan 062: vehicles use instanced pool, not individual nodes.
  const liveVehicleIds = new Set(Object.keys(network.vehicles));
  const allocatedIds = new Set(built.vehicles.trails.keys());

  for (const id of allocatedIds) {
    if (!liveVehicleIds.has(id)) {
      const trail = built.vehicles.trails.get(id);
      if (trail) built.root.remove(trail.line);
      built.vehicles.remove(id);
    }
  }
  for (const id of liveVehicleIds) {
    if (!built.vehicles.trails.has(id)) {
      const v = network.vehicles[id];
      if (!v) continue;
      built.vehicles.allocate(v);
      const trail = built.vehicles.trails.get(id);
      if (trail) built.root.add(trail.line);
    }
  }

  // Lights (lights live under intersections, not at the top level of the network).
  const liveLightIds = new Set<string>();
  for (const inter of Object.values(network.intersections)) {
    for (const l of inter.trafficLights) liveLightIds.add(l.id);
  }
  for (const [id, node] of built.lightNodes) {
    if (!liveLightIds.has(id)) {
      built.root.remove(node.group);
      disposeLightNode(node);
      built.lightNodes.delete(id);
    }
  }
  for (const id of liveLightIds) {
    if (!built.lightNodes.has(id)) {
      // Find the light entity to build the node.
      let found: TrafficLight | undefined;
      for (const inter of Object.values(network.intersections)) {
        const l = inter.trafficLights.find((x) => x.id === id);
        if (l) {
          found = l;
          break;
        }
      }
      if (!found) continue;
      const node = buildLightNode(found);
      built.root.add(node.group);
      built.lightNodes.set(id, node);
    }
  }
};

/** Move the selection ring to the currently selected entity, or hide it. */
export const syncSelection = (
  built: BuiltScene,
  selected: { kind: 'vehicle' | 'light'; id: string } | null,
): void => {
  const ring = built.selectionRing;
  if (!selected) {
    ring.visible = false;
    return;
  }
  let pos: THREE.Vector3 | null = null;
  if (selected.kind === 'vehicle') {
    pos = built.vehicles.getPosition(selected.id);
  } else {
    const node = built.lightNodes.get(selected.id);
    if (node) pos = node.group.position;
  }
  if (!pos) {
    ring.visible = false;
    return;
  }
  ring.visible = true;
  ring.position.set(pos.x, pos.y + Y_SELECTION_RING_BASE, pos.z);
};
