import * as THREE from 'three';
import type { RoadNetwork } from '@domain/entities/RoadNetwork';
import type { TrafficLight } from '@domain/entities/TrafficLight';
import { LightPhase } from '@domain/value-objects/Phase';
import { createGroundMesh } from './GroundMesh';
import { createRoadMesh } from './RoadMesh';
import { createVehicleMesh } from './VehicleMesh';
import { createTrafficLightMesh } from './TrafficLightMesh';

const PHASE_COLOR: Record<TrafficLight['phase'], number> = {
  [LightPhase.Red]: 0xef4444,
  [LightPhase.Yellow]: 0xfbbf24,
  [LightPhase.Green]: 0x22c55e,
};

export interface BuiltScene {
  root: THREE.Group;
  vehicleMeshes: Map<string, THREE.Mesh>;
  lightMeshes: Map<string, THREE.Mesh>;
}

export const buildScene = (network: RoadNetwork): BuiltScene => {
  const root = new THREE.Group();
  root.add(createGroundMesh());
  for (const road of Object.values(network.roads)) {
    root.add(createRoadMesh(road));
  }
  const vehicleMeshes = new Map<string, THREE.Mesh>();
  for (const v of Object.values(network.vehicles)) {
    const mesh = createVehicleMesh(v);
    root.add(mesh);
    vehicleMeshes.set(v.id, mesh);
  }
  const lightMeshes = new Map<string, THREE.Mesh>();
  for (const inter of Object.values(network.intersections)) {
    for (const light of inter.trafficLights) {
      const mesh = createTrafficLightMesh(light);
      root.add(mesh);
      lightMeshes.set(light.id, mesh);
    }
  }
  return { root, vehicleMeshes, lightMeshes };
};

/**
 * Sync mesh transforms (and color/emissive for lights) from a mutated network
 * to an already-built scene. Cheaper than rebuilding — called every frame
 * after onTick has mutated the network in place.
 */
export const syncMeshTransforms = (network: RoadNetwork, built: BuiltScene): void => {
  for (const v of Object.values(network.vehicles)) {
    const mesh = built.vehicleMeshes.get(v.id);
    if (!mesh) continue;
    mesh.position.set(v.position.x, 0.75, v.position.z);
    mesh.rotation.y = -v.heading;
    // Update color if it changed (e.g. via InspectorPanel in Plan 004)
    const mat = mesh.material as THREE.MeshStandardMaterial;
    mat.color.set(v.color);
  }
  for (const inter of Object.values(network.intersections)) {
    for (const light of inter.trafficLights) {
      const mesh = built.lightMeshes.get(light.id);
      if (!mesh) continue;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const phaseColor = PHASE_COLOR[light.phase];
      mat.color.setHex(phaseColor);
      mat.emissive.setHex(phaseColor);
    }
  }
};
