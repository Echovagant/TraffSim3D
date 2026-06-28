import * as THREE from 'three';

/**
 * Plan 054: ground plane now accepts a configurable size. M1-M3 used
 * a hard-coded 200×200 plane that became a visible "gray square" once
 * the user zoomed out to frame a 5km OSM district. The scene builder
 * now sizes the ground to `max(200, bboxDiagonal * 3) + 1000` so
 * the edge stays well outside the camera's view in any scene.
 *
 * The default of 200u is kept for the synthetic demo scenes (cross,
 * t, loop) so they don't look "lost in space".
 */
export const GROUND_PADDING = 1000;  // extra margin beyond bbox diagonal
export const GROUND_DEFAULT_SIZE = 200;

export const createGroundMesh = (size: number = GROUND_DEFAULT_SIZE): THREE.Mesh => {
  const geom = new THREE.PlaneGeometry(size, size);
  const mat = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.9, metalness: 0.0 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0;
  return mesh;
};
