import * as THREE from 'three';
import type { Vehicle, VehicleType } from '@domain/entities/Vehicle';

/**
 * Build the 3D body of a vehicle. Each type has a distinct silhouette
 * so a scene with mixed traffic is readable at a glance:
 *
 *   car   → low body + smaller cabin on top (sedan profile)
 *   truck → tall cab (front) + taller cargo box (rear)
 *   bus   → long body with a horizontal window band
 *
 * The caller is expected to add the returned `body` mesh to a Group
 * anchored at the vehicle's world position. The pickable `body` mesh
 * stays a single Mesh so the raycaster hit-test still matches by
 * identity. The decorative children (cabin, cargo, windows) are added
 * to the body so the whole assembly moves/rotates as one unit.
 *
 * `Y_BODY` is the height at which the bottom of the body sits above
 * the road plane. Wheels are *not* rendered — the box base is wide
 * enough that the car reads as sitting on the road from above.
 */
export const Y_BODY = 0.55;

const makeBodyMaterial = (color: string): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.6, metalness: 0.1 });

const WINDOW_COLOR = 0x1e293b;  // dark slate — reads as tinted glass

const buildCar = (color: string): THREE.Group => {
  // Lower body — main hull, full size.
  const lowerGeom = new THREE.BoxGeometry(4.2, 0.9, 1.8);
  const body = new THREE.Mesh(lowerGeom, makeBodyMaterial(color));
  body.position.set(0, Y_BODY + 0.45, 0);  // bottom at Y_BODY

  // Cabin (shorter, narrower) sits on the rear half of the lower body.
  const cabinGeom = new THREE.BoxGeometry(2.4, 0.7, 1.6);
  const cabin = new THREE.Mesh(cabinGeom, makeBodyMaterial(color));
  cabin.position.set(-0.2, Y_BODY + 0.9 + 0.35, 0);

  // Windshield + rear window (thin tinted strips on the cabin front/back).
  const wsGeom = new THREE.BoxGeometry(0.05, 0.55, 1.45);
  const wsMat = new THREE.MeshStandardMaterial({ color: WINDOW_COLOR, roughness: 0.2, metalness: 0.4 });
  const wsFront = new THREE.Mesh(wsGeom, wsMat);
  wsFront.position.set(0.95, Y_BODY + 0.9 + 0.35, 0);
  const wsRear = new THREE.Mesh(wsGeom, wsMat);
  wsRear.position.set(-1.35, Y_BODY + 0.9 + 0.35, 0);

  // Side windows (long thin strips on the cabin sides).
  const sideGeom = new THREE.BoxGeometry(2.0, 0.5, 0.05);
  const sideMat = new THREE.MeshStandardMaterial({ color: WINDOW_COLOR, roughness: 0.2, metalness: 0.4 });
  const sideL = new THREE.Mesh(sideGeom, sideMat);
  sideL.position.set(-0.2, Y_BODY + 0.9 + 0.35, 0.82);
  const sideR = new THREE.Mesh(sideGeom, sideMat);
  sideR.position.set(-0.2, Y_BODY + 0.9 + 0.35, -0.82);

  const group = new THREE.Group();
  group.add(body);
  group.add(cabin);
  group.add(wsFront, wsRear);
  group.add(sideL, sideR);
  group.userData['pickable'] = body;
  return group;
};

const buildTruck = (color: string): THREE.Group => {
  // Lower body — full chassis, longer than a car.
  const lowerGeom = new THREE.BoxGeometry(6.5, 0.8, 2.2);
  const body = new THREE.Mesh(lowerGeom, makeBodyMaterial(color));
  body.position.set(0, Y_BODY + 0.4, 0);

  // Cab at the front (positive x): tall box, slightly narrower than chassis.
  const cabGeom = new THREE.BoxGeometry(1.8, 1.4, 2.0);
  const cab = new THREE.Mesh(cabGeom, makeBodyMaterial(color));
  cab.position.set(2.35, Y_BODY + 0.8 + 0.7, 0);

  // Cargo box (the back) — taller than the cab to read as a freight container.
  const cargoGeom = new THREE.BoxGeometry(4.0, 2.0, 2.0);
  const cargoMat = new THREE.MeshStandardMaterial({
    color: 0xf5f5f4,  // near-white cargo so the truck reads as commercial
    roughness: 0.7,
  });
  const cargo = new THREE.Mesh(cargoGeom, cargoMat);
  cargo.position.set(-0.95, Y_BODY + 0.8 + 1.0, 0);

  // Cab windshield.
  const wsGeom = new THREE.BoxGeometry(0.05, 0.9, 1.85);
  const wsMat = new THREE.MeshStandardMaterial({ color: WINDOW_COLOR, roughness: 0.2, metalness: 0.4 });
  const ws = new THREE.Mesh(wsGeom, wsMat);
  ws.position.set(3.25, Y_BODY + 0.8 + 0.7, 0);

  const group = new THREE.Group();
  group.add(body, cab, cargo, ws);
  group.userData['pickable'] = body;
  return group;
};

const buildBus = (color: string): THREE.Group => {
  // Long body.
  const bodyGeom = new THREE.BoxGeometry(9.0, 2.0, 2.4);
  const body = new THREE.Mesh(bodyGeom, makeBodyMaterial(color));
  body.position.set(0, Y_BODY + 1.0, 0);

  // Roof (slightly inset, darker — distinguishes top from sides).
  const roofGeom = new THREE.BoxGeometry(8.6, 0.1, 2.2);
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.6 });
  const roof = new THREE.Mesh(roofGeom, roofMat);
  roof.position.set(0, Y_BODY + 2.0 + 0.05, 0);

  // Window strip running along both sides (long, thin, dark).
  const winGeom = new THREE.BoxGeometry(7.6, 0.7, 0.05);
  const winMat = new THREE.MeshStandardMaterial({ color: WINDOW_COLOR, roughness: 0.2, metalness: 0.4 });
  const winL = new THREE.Mesh(winGeom, winMat);
  winL.position.set(0, Y_BODY + 1.4, 1.22);
  const winR = new THREE.Mesh(winGeom, winMat);
  winR.position.set(0, Y_BODY + 1.4, -1.22);

  // Front windshield (taller, at +x end).
  const wsGeom = new THREE.BoxGeometry(0.05, 1.3, 2.05);
  const ws = new THREE.Mesh(wsGeom, winMat);
  ws.position.set(4.5, Y_BODY + 1.3, 0);

  const group = new THREE.Group();
  group.add(body, roof, winL, winR, ws);
  group.userData['pickable'] = body;
  return group;
};

const builders: Record<VehicleType, (color: string) => THREE.Group> = {
  car: buildCar,
  truck: buildTruck,
  bus: buildBus,
};

/**
 * Build the visual body for a vehicle. Returns a `THREE.Group` whose
 * primary child is the `pickable` lower body (set as `userData.pickable`
 * AND accessible as the first child for legacy callers). The whole
 * group should be added to a parent `THREE.Group` whose position and
 * rotation are driven by `vehicle.position` and `vehicle.heading`.
 *
 * Backward-compat: the previous API returned a single `THREE.Mesh`.
 * The renderer's picker used to compare `node.body === hit.object`;
 * we keep a `body` mesh as the first child of the returned group and
 * the picker is updated to walk the parent group instead.
 */
export const createVehicleMesh = (vehicle: Vehicle): THREE.Group => {
  return builders[vehicle.type](vehicle.color);
};

/**
 * Pull the pickable body mesh out of a vehicle group created by
 * `createVehicleMesh`. Returns the lower body (the chassis / hull),
 * which is the largest child and what the raycaster should hit-test
 * against. The pickable mesh is also stored on `group.userData.pickable`
 * for explicit lookup.
 */
export const getVehicleBodyMesh = (group: THREE.Group): THREE.Mesh => {
  const explicit = group.userData['pickable'];
  if (explicit instanceof THREE.Mesh) return explicit;
  // Fallback: first child. Builders always add the body first.
  const first = group.children[0];
  if (first instanceof THREE.Mesh) return first;
  throw new Error('createVehicleMesh: group has no pickable body mesh');
};
