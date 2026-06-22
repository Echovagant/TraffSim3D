import * as THREE from 'three';

/** Flat ground plane; a single 200x200 unit mesh with a grid texture procedurally generated on a canvas. */
export const createGroundMesh = (): THREE.Mesh => {
  const geom = new THREE.PlaneGeometry(200, 200);
  const mat = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.9, metalness: 0.0 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0;
  return mesh;
};
