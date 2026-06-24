// M2 (plan 029): domain actions for lane change.
//
// `requestLaneChange` is a *pure* decision function: it returns whether
// the change is safe given the current network snapshot. The caller
// (worldStore) is responsible for mutating the vehicle to record
// `desiredLaneIndex` + `laneChangeStartedAt` on success.
//
// `steerLateralVelocity` + `perpendicularOffsetAlongRoad` are pure
// geometry helpers used by `tick.ts` to advance the lane-change.
import type { Vehicle } from '@domain/entities/Vehicle';
import type { RoadNetwork } from '@domain/entities/RoadNetwork';
import { MIN_GAP } from '@shared/constants/simulation';

export type LaneChangeDirection = 'left' | 'right';

export type LaneChangeResult =
  | { ok: true }
  | { ok: false; reason: LaneChangeRejectReason };

export type LaneChangeRejectReason =
  | 'not-found'
  | 'already-changing'
  | 'in-intersection'
  | 'crashed'
  | 'too-slow'
  | 'no-target-lane'
  | 'gap-too-small';

/** m/s. Below this the merge is unsafe (rear-end risk). */
export const MIN_LANE_CHANGE_SPEED = 5.0;

/** Find the closest vehicle ahead and behind `selfS` in the same
 *  target-lane set. Returns the gaps in metres (ahead > 0, behind < 0). */
const findGapsOnLane = (selfS: number, candidates: ReadonlyArray<Vehicle>): { ahead: number; behind: number } => {
  let ahead = Infinity;
  let behind = -Infinity;
  for (const v of candidates) {
    const ds = v.s - selfS;
    if (ds > 0 && ds < ahead) ahead = ds;
    if (ds < 0 && ds > behind) behind = ds;
  }
  return { ahead, behind };
};

export const requestLaneChange = (
  v: Vehicle,
  direction: LaneChangeDirection,
  network: RoadNetwork,
  _simTime: number,
): LaneChangeResult => {
  if (v.status === 'crashed') return { ok: false, reason: 'crashed' };
  if (v.desiredLaneIndex !== null) return { ok: false, reason: 'already-changing' };
  if (v.enteredIntersectionAt !== null) return { ok: false, reason: 'in-intersection' };
  if (v.speed < MIN_LANE_CHANGE_SPEED) return { ok: false, reason: 'too-slow' };
  const road = network.roads[v.roadId];
  if (!road) return { ok: false, reason: 'not-found' };
  const targetLane = v.laneIndex + (direction === 'left' ? 1 : -1);
  if (targetLane < 0 || targetLane >= road.laneCount) {
    return { ok: false, reason: 'no-target-lane' };
  }
  // Gap check: any non-self vehicle in the target lane on the same
  // road must be at least MIN_GAP ahead AND behind. (O(N) over
  // vehicles on this road; fine at M2 scale.)
  const targetVehicles = Object.values(network.vehicles).filter(
    (o) => o.id !== v.id && o.roadId === road.id && o.laneIndex === targetLane && o.status !== 'crashed',
  );
  const { ahead, behind } = findGapsOnLane(v.s, targetVehicles);
  if (ahead < MIN_GAP || -behind < MIN_GAP) {
    return { ok: false, reason: 'gap-too-small' };
  }
  return { ok: true };
};

/** P-controller: given current and target lateral offset, return the
 *  lateral linvel to apply this tick (signed m/s, clamped). */
export const steerLateralVelocity = (
  currentLateral: number,
  targetLateral: number,
  steerGain: number,
  maxLateralMs: number,
): number => {
  const diff = targetLateral - currentLateral;
  return Math.max(-maxLateralMs, Math.min(maxLateralMs, diff * steerGain));
};

/** Convergence threshold (metres). */
export const LANE_CHANGE_CONVERGED_M = 0.3;

/** Perpendicular offset (metres, signed) of `position` relative to
 *  the road's centerline in the XZ plane. Positive = "right" side
 *  (lane 0 in the M2 convention). */
export const perpendicularOffsetAlongRoad = (
  road: { startNode: { x: number; z: number }; endNode: { x: number; z: number } },
  position: { x: number; z: number },
): number => {
  const dx = road.endNode.x - road.startNode.x;
  const dz = road.endNode.z - road.startNode.z;
  const len = Math.hypot(dx, dz);
  if (len === 0) return 0;
  // Perpendicular in XZ (rotate (dx,dz) 90° CCW): (-dz, dx) / len
  const rx = (position.x - road.startNode.x) / len;
  const rz = (position.z - road.startNode.z) / len;
  return rx * (-dz) + rz * dx;
};
