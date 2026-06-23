import * as THREE from 'three';

/** A flat ring drawn on the ground beneath the currently selected entity. */
export const createSelectionRing = (): THREE.Mesh => {
  // Inner radius 1.2, outer 1.6 → 0.4u wide ring. Sits at y=0.05 (above
  // the ground plane, below the road plane). Always faces up.
  const geom = new THREE.RingGeometry(1.2, 1.6, 32);
  const mat = new THREE.MeshBasicMaterial({ color: 0xfde047, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(0, 0.05, 0);
  mesh.visible = false;
  return mesh;
};
