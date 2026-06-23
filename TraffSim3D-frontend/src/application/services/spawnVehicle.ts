import type { RoadNetwork } from '@domain/entities/RoadNetwork';
import type { Vehicle, VehicleType } from '@domain/entities/Vehicle';
import { LaneId } from '@domain/value-objects/LaneId';
import { lanePoint, roadLength } from '@domain/services/laneGeometry';

const DEFAULT_COLORS: Record<VehicleType, string> = {
  car: '#3a86ff',
  truck: '#f5f5f4',
  bus: '#22c55e',
};

const TYPE_PROBABILITIES: ReadonlyArray<readonly [VehicleType, number]> = [
  ['car', 0.7],
  ['truck', 0.18],
  ['bus', 0.12],
];

const rollType = (): VehicleType => {
  const r = Math.random();
  let acc = 0;
  for (const [t, p] of TYPE_PROBABILITIES) {
    acc += p;
    if (r < acc) return t;
  }
  return 'car';
};

/**
 * Bumper-to-bumper minimum spacing when scanning for a free spot.
 * Roughly one car length + a small safety margin.
 */
const MIN_FREE_GAP = 6;

/**
 * Per-type vehicle "footprint" used when computing the free-space scan.
 * Approximate: half the body length (longest dimension) + half the
 * body width. For collision-avoidance the tick uses slightly larger
 * radii; for the spawn scan we only need "no two vehicles sitting on
 * top of each other", so these are conservative.
 */
const vehicleFootprintRadius = (type: VehicleType): number => {
  if (type === 'bus') return 5.0;
  if (type === 'truck') return 3.5;
  return 2.5;  // car
};

interface SpawnCandidate {
  roadId: string;
  laneIndex: number;
  s: number;
}

export type SpawnResult =
  | { ok: true; vehicle: Vehicle }
  | { ok: false; reason: 'traffic density full' };

export interface SpawnOptions {
  type?: VehicleType;
  color?: string;
  speed?: number;
}

/**
 * True if no existing vehicle on (roadId, laneIndex) is within
 * `requiredGap` of `candidate.s` (along-lane distance, in lane-forward
 * terms — so a forward-lane car at s=20 doesn't count as "near" a
 * backward-lane car at the same s).
 */
const isSpotFree = (
  network: RoadNetwork,
  candidate: SpawnCandidate,
  requiredGap: number,
): boolean => {
  const roadLen = roadLength(network.roads[candidate.roadId]!);
  for (const other of Object.values(network.vehicles)) {
    if (other.roadId !== candidate.roadId) continue;
    if (other.laneIndex !== candidate.laneIndex) continue;
    // Along-lane distance, accounting for wraparound (a car at s=58
    // and a candidate at s=2 are 4u apart on a 60u road, not 56u).
    const ds = Math.abs(other.s - candidate.s);
    const wrapDs = Math.min(ds, roadLen - ds);
    if (wrapDs < requiredGap) return false;
  }
  return true;
};

/**
 * Enumerate all (road, lane) pairs on the network and return the ones
 * that have a free window of at least `minGap` along the lane. A lane
 * is "full" if every position is within `minGap` of an existing
 * vehicle.
 *
 * To avoid an O(N × M) scan per spawn call (N = existing vehicles,
 * M = candidate positions), we do a coarse scan: sample a handful
 * of candidate positions per lane and check if at least one is free.
 * For the M1 demo scale (<30 vehicles, <8 lanes) this is plenty.
 */
const findFreeLanes = (network: RoadNetwork, minGap: number): SpawnCandidate[] => {
  const candidates: SpawnCandidate[] = [];
  for (const road of Object.values(network.roads)) {
    if (road.laneCount === 0) continue;
    for (let laneIndex = 0; laneIndex < road.laneCount; laneIndex++) {
      const len = roadLength(road);
      if (len < minGap * 2) continue;  // road too short for the gap
      // Sample positions: avoid the intersection area (center of road).
      const stopZone = 5;  // matches STOP_LINE_DISTANCE
      const margin = 1;
      const minS = margin;
      const maxS = len - margin;
      // Try a few random positions in the lane; if ANY is free, the
      // lane is a candidate.
      const trials = 6;
      let foundInLane: SpawnCandidate | null = null;
      for (let t = 0; t < trials; t++) {
        const s = minS + Math.random() * (maxS - minS);
        // Avoid the intersection area (s ≈ len/2 ± stopZone).
        if (Math.abs(s - len / 2) < stopZone) continue;
        const c: SpawnCandidate = { roadId: road.id, laneIndex, s };
        if (isSpotFree(network, c, minGap)) {
          foundInLane = c;
          break;
        }
      }
      if (foundInLane) candidates.push(foundInLane);
    }
  }
  return candidates;
};

/**
 * Build a new Vehicle ready to be added to `network.vehicles`.
 *
 * Behaviour (M1.5):
 *   - Enumerate every (road, lane) pair on the network.
 *   - Filter to lanes that have at least one free window of `minGap`.
 *   - If at least one is free, pick one (weighted by lane count × road
 *     length, so longer busier roads spawn more) and place a vehicle
 *     of `type` there.
 *   - If NO lane has a free window, return `{ ok: false, reason:
 *     'traffic density full' }`. The caller surfaces this to the user
 *     (toolbar flash, etc.) — we never silently fall back to a
 *     collision-prone position.
 */
export const spawnVehicle = (
  network: RoadNetwork,
  nextId: string,
  options: SpawnOptions = {},
): SpawnResult => {
  const type = options.type ?? rollType();
  const color = options.color ?? DEFAULT_COLORS[type];
  const speed = options.speed ?? 0;
  const minGap = MIN_FREE_GAP + vehicleFootprintRadius(type);

  const candidates = findFreeLanes(network, minGap);
  if (candidates.length === 0) {
    return { ok: false, reason: 'traffic density full' };
  }

  // Pick uniformly from the candidate list. (Could weight by length
  // for a "longer roads get more traffic" feel, but uniform is fine
  // for M1 and matches user expectations when they click + Vehicle.)
  const spot = candidates[Math.floor(Math.random() * candidates.length)]!;
  const road = network.roads[spot.roadId]!;
  const lp = lanePoint(road, spot.laneIndex, spot.s);
  const vehicle: Vehicle = {
    id: nextId,
    type,
    color,
    position: lp.position,
    heading: lp.heading,
    speed,
    targetSpeed: road.speedLimit,
    roadId: spot.roadId,
    laneIndex: spot.laneIndex,
    s: spot.s,
    lane: LaneId.make(spot.roadId, spot.laneIndex),
    status: speed < 0.5 ? 'waiting' : 'driving',
    enteredIntersectionAt: null,
  };
  return { ok: true, vehicle };
};