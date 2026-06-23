import * as THREE from 'three';
import type { Road } from '@domain/entities/Road';
import { ROAD_LANE_WIDTH } from '@shared/constants/simulation';
import { roadLength } from '@domain/services/laneGeometry';

/** Build a road as a thin extruded strip from startNode to endNode. */
export const createRoadMesh = (road: Road): THREE.Mesh => {
  const dx = road.endNode.x - road.startNode.x;
  const dz = road.endNode.z - road.startNode.z;
  const length = roadLength(road);
  const totalWidth = ROAD_LANE_WIDTH * road.laneCount;
  const geom = new THREE.PlaneGeometry(length, totalWidth);
  const mat = new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.95 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(
    (road.startNode.x + road.endNode.x) / 2,
    0.01,  // sit just above ground
    (road.startNode.z + road.endNode.z) / 2,
  );
  mesh.rotation.z = -Math.atan2(dz, dx);
  return mesh;
};
