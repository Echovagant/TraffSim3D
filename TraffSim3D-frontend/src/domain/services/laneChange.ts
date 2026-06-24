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
import type { Road } from '@domain/entities/Road';
import { roadForward, roadLength } from '@domain/services/laneGeometry';
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
 *  (lane 0 in the M2 convention).
 *
 *  Plan 035: polyline-aware. Pass the vehicle's current `s` so the
 *  perpendicular uses the LOCAL segment tangent at that arc-length —
 *  a vehicle halfway through a corner road gets the corner's tangent,
 *  not the average over the whole polyline. */
export const perpendicularOffsetAlongRoad = (
  road: Road,
  positionOrS: number | { x: number; z: number },
  positionParam?: { x: number; z: number },
): number => {
  // Overload: legacy callers pass (road, position). New callers pass
  // (road, s, position). Detect which shape by the second argument type.
  let s: number;
  let position: { x: number; z: number };
  if (typeof positionOrS === 'number') {
    s = positionOrS;
    position = positionParam ?? { x: 0, z: 0 };
  } else {
    // Legacy signature. Use the road's midpoint as the default s — the
    // pre-035 caller had no `s`, so the perpendicular was always the
    // straight-line perp from startNode to endNode. For 2-point roads
    // this is exact; for N-point polylines this is "the perp at the
    // middle segment", which is what the legacy tests expect (they use
    // midpoint of the (0,0)-(30,0) road).
    s = roadLength(road) / 2;
    position = positionOrS;
  }
  const fwd = roadForward(road, s);
  if (fwd.ux === 0 && fwd.uz === 0) return 0;
  // Lane reference point: forward = startNode, backward = endNode.
  // We use startNode here because "perpendicular offset from centerline"
  // is geometric, not motion-relative; the centerline runs startNode→endNode.
  const refX = road.startNode.x;
  const refZ = road.startNode.z;
  const dx = position.x - refX;
  const dz = position.z - refZ;
  // Right-perpendicular: rotate fwd -90° → (uz, -ux). Dot with (dx, dz)
  // gives signed distance from centerline (positive = right of geometric forward).
  return dx * fwd.uz + dz * (-fwd.ux);
};
