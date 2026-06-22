import * as THREE from 'three';
import type { Vehicle } from '@domain/entities/Vehicle';

/** Car body: a box ~4.5 x 1.5 x 2u (length x height x width). */
export const createVehicleMesh = (vehicle: Vehicle): THREE.Mesh => {
  const geom = new THREE.BoxGeometry(4.5, 1.5, 2.0);
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(vehicle.color) });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(vehicle.position.x, 0.75, vehicle.position.z);
  mesh.rotation.y = -vehicle.heading;
  return mesh;
};
