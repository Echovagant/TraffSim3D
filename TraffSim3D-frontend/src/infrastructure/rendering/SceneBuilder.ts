import * as THREE from 'three';
import type { RoadNetwork } from '@domain/entities/RoadNetwork';
import type { Vehicle } from '@domain/entities/Vehicle';
import type { TrafficLight } from '@domain/entities/TrafficLight';
import type { Road } from '@domain/entities/Road';
import { createGroundMesh, GROUND_DEFAULT_SIZE, GROUND_PADDING } from './GroundMesh';
import { createRoadMesh } from './RoadMesh';
import { createRoadMarkings } from './RoadMarkingsMesh';
import { createVehicleMesh, getVehicleBodyMesh } from './VehicleMesh';
import { createVehicleTrail, type VehicleTrail } from './VehicleTrailMesh';
import { createTrafficLightNode, updateTrafficLightNode, type TrafficLightNode } from './TrafficLightNode';
import { createSelectionRing } from './SelectionRingMesh';
import { TRAIL_LENGTH } from '@shared/constants/simulation';

const WRAP_THRESHOLD = 20;     // |Δpos| greater than this on a tick is treated as a wrap-reset
const Y_SELECTION_RING_BASE = 0.05;

export interface VehicleNode {
  /** Group anchored at the vehicle position; the renderer repositions + rotates this per frame. */
  group: THREE.Group;
  /**
   * The pickable body mesh (lower hull). With distinct car/truck/bus
   * models, the body is a child of `group` along with the cabin/cargo
   * decorations. The picker uses `getVehicleBodyMesh(group)` to pull
   * it out for raycasting.
   */
  body: THREE.Mesh;
  /**
   * Trail line; positions updated in place each frame. The line itself is
   * attached directly to `built.root` (NOT the group) so its world-space
   * coordinates aren't re-transformed by the group's rotation. The renderer
   * adds/removes the line when nodes are added/removed.
   */
  trail: VehicleTrail;
}

export interface RoadNode {
  /** Group containing the road plane + lane markings. */
  group: THREE.Group;
}

export interface BuiltScene {
  root: THREE.Group;
  vehicleNodes: Map<string, VehicleNode>;
  lightNodes: Map<string, TrafficLightNode>;
  roadNodes: Map<string, RoadNode>;
  /** Single ring, reparented/repositioned per selection. Hidden when nothing is selected. */
  selectionRing: THREE.Mesh;
}

/** Per-frame update for a vehicle: move group, recolor body, advance trail. */
const updateVehicleNode = (v: Vehicle, node: VehicleNode): void => {
  node.group.position.set(v.position.x, 0, v.position.z);
  node.group.rotation.y = -v.heading;
  // Recolor the primary body mesh. Decorations (cabin, cargo) follow
  // the body's color for car; for truck and bus, the cargo/roof have
  // their own color and are *not* recolored. This matches the user
  // intent of "change the car's color" without painting over freight
  // cargo or the bus's roof.
  const mat = node.body.material as THREE.MeshStandardMaterial;
  mat.color.set(v.color);
  if (v.type === 'car') {
    // Cars are one-color: also recolor the cabin mesh.
    for (const child of node.group.children) {
      if (child instanceof THREE.Mesh && child !== node.body) {
        const m = child.material;
        if (m instanceof THREE.MeshStandardMaterial) m.color.set(v.color);
      }
    }
  }
  // Keep the trail color in sync if the body color was changed via the inspector.
  (node.trail.line.material as THREE.LineBasicMaterial).color.set(v.color);

  // Advance trail history; if the new position is suspiciously far from the
  // last (wrap-around at the world boundary), reset the history so the line
  // doesn't draw a streak across the whole map.
  const last = node.trail.history[node.trail.history.length - 1];
  if (last) {
    const dx = v.position.x - last.x;
    const dz = v.position.z - last.z;
    if (dx * dx + dz * dz > WRAP_THRESHOLD * WRAP_THRESHOLD) {
      for (let i = 0; i < node.trail.history.length; i++) {
        node.trail.history[i] = { x: v.position.x, z: v.position.z };
      }
    }
  }
  node.trail.history.push({ x: v.position.x, z: v.position.z });
  if (node.trail.history.length > TRAIL_LENGTH) node.trail.history.shift();

  // Re-upload the history into the BufferAttribute in place.
  for (let i = 0; i < TRAIL_LENGTH; i++) {
    const h = node.trail.history[i] ?? v.position;
    node.trail.positions[i * 3 + 0] = h.x;
    node.trail.positions[i * 3 + 1] = 0.1;
    node.trail.positions[i * 3 + 2] = h.z;
  }
  node.trail.attribute.needsUpdate = true;
};

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

const disposeVehicleNode = (node: VehicleNode): void => {
  node.body.geometry.dispose();
  (node.body.material as THREE.Material).dispose();
  node.trail.line.geometry.dispose();
  (node.trail.line.material as THREE.Material).dispose();
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

const buildVehicleNode = (v: Vehicle): VehicleNode => {
  const group = createVehicleMesh(v);
  // The mesh group is already positioned in its own local space (the
  // body sits at +Y_BODY above local origin so the chassis lifts off
  // the road). The outer group (`group`) is anchored at the vehicle's
  // world position by the renderer; its rotation is set per frame.
  const body = getVehicleBodyMesh(group);
  // Trail is NOT added to the group — see VehicleNode comment.
  const trail = createVehicleTrail(v);
  group.position.set(v.position.x, 0, v.position.z);
  return { group, body, trail };
};

const buildRoadNode = (road: Road): RoadNode => {
  const group = new THREE.Group();
  group.add(createRoadMesh(road));
  group.add(createRoadMarkings(road));
  return { group };
};

const buildLightNode = (light: TrafficLight): TrafficLightNode => createTrafficLightNode(light);

export const buildScene = (network: RoadNetwork): BuiltScene => {
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
      // Half-extent = max distance from bbox center to a road corner.
      // Use this to size fog (ThreeJSRenderer.setSceneScale) so the
      // fog starts at the road edge and fades the ground to the
      // background color well before the user can see the ground
      // boundary.
      halfExtent = Math.max(diag / 2, 50);
      // Ground = 2× diagonal + padding so the road is comfortably
      // inside, but the visible gray area beyond the road is fog'd
      // out. For a 5km OSM: ground = 11km; fog starts at 5km +
      // padding, fully opaque at 11km.
      groundSize = Math.max(
        GROUND_DEFAULT_SIZE,
        Math.ceil(diag * 2 + GROUND_PADDING),
      );
    }
  }
  root.add(createGroundMesh(groundSize));

  const roadNodes = new Map<string, RoadNode>();
  for (const road of Object.values(network.roads)) {
    const node = buildRoadNode(road);
    root.add(node.group);
    roadNodes.set(road.id, node);
  }

  const vehicleNodes = new Map<string, VehicleNode>();
  for (const v of Object.values(network.vehicles)) {
    const node = buildVehicleNode(v);
    root.add(node.group);
    root.add(node.trail.line);  // trail is a top-level child, not in the group
    vehicleNodes.set(v.id, node);
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

  return { root, vehicleNodes, lightNodes, roadNodes, selectionRing };
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
    const node = built.vehicleNodes.get(v.id);
    if (node) updateVehicleNode(v, node);
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
  // Vehicles
  const liveVehicleIds = new Set(Object.keys(network.vehicles));
  for (const [id, node] of built.vehicleNodes) {
    if (!liveVehicleIds.has(id)) {
      built.root.remove(node.group);
      built.root.remove(node.trail.line);
      disposeVehicleNode(node);
      built.vehicleNodes.delete(id);
    }
  }
  for (const id of liveVehicleIds) {
    if (!built.vehicleNodes.has(id)) {
      const v = network.vehicles[id];
      if (!v) continue;
      const node = buildVehicleNode(v);
      built.root.add(node.group);
      built.root.add(node.trail.line);
      built.vehicleNodes.set(id, node);
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
  let pos: { x: number; z: number } | null = null;
  if (selected.kind === 'vehicle') {
    const node = built.vehicleNodes.get(selected.id);
    if (node) pos = { x: node.group.position.x, z: node.group.position.z };
  } else {
    const node = built.lightNodes.get(selected.id);
    if (node) pos = { x: node.group.position.x, z: node.group.position.z };
  }
  if (!pos) {
    ring.visible = false;
    return;
  }
  ring.visible = true;
  ring.position.set(pos.x, Y_SELECTION_RING_BASE, pos.z);
};
