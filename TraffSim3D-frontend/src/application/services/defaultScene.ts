import { createRoadNetwork, type RoadNetwork } from '@domain/entities/RoadNetwork';
import type { Vehicle } from '@domain/entities/Vehicle';
import type { TrafficLight } from '@domain/entities/TrafficLight';
import type { Intersection } from '@domain/entities/Intersection';
import type { Road } from '@domain/entities/Road';
import { LightPhase } from '@domain/value-objects/Phase';
import { LaneId } from '@domain/value-objects/LaneId';
import { lanePoint, roadLength } from '@domain/services/laneGeometry';
import { DEFAULT_CYCLE_SECONDS } from '@shared/constants/simulation';

const NS_GREEN = DEFAULT_CYCLE_SECONDS * (30 / 63);  // ~30s
const EW_GREEN = NS_GREEN;

/**
 * Place a vehicle on (road, laneIndex) at distance `s` along the lane.
 * Pulls position + heading from the lane geometry so the rest of the
 * code can stay in world-space.
 */
const at = (road: Road, laneIndex: number, s: number, speed: number, v: Omit<Vehicle, 'position' | 'heading' | 'lane' | 's' | 'speed' | 'targetSpeed' | 'roadId' | 'laneIndex' | 'enteredIntersectionAt' | 'desiredLaneIndex' | 'laneChangeStartedAt' | 'spawnedAt'>): Vehicle => {
  const lp = lanePoint(road, laneIndex, s);
  return {
    ...v,
    roadId: road.id,
    laneIndex,
    s,
    speed,
    targetSpeed: road.speedLimit,
    position: lp.position,
    heading: lp.heading,
    lane: LaneId.make(road.id, laneIndex),
    enteredIntersectionAt: null,
    desiredLaneIndex: null,
    laneChangeStartedAt: null,
    spawnedAt: 0,
  };
};

/**
 * Plan 035: helper for the common case of a straight 2-point road. Saves
 * typing `startNode`, `endNode`, `laneCount`, `speedLimit` separately
 * when the road is just a single segment.
 */
const roadStraight = (id: string, start: { x: number; y?: number; z: number }, end: { x: number; y?: number; z: number }, laneCount: number, speedLimit: number): Road => ({
  id,
  startNode: { x: start.x, y: start.y ?? 0, z: start.z },
  endNode: { x: end.x, y: end.y ?? 0, z: end.z },
  laneCount,
  speedLimit,
});

/**
 * Build the default cross-intersection scene (renamed from
 * `buildDefaultNetwork` in plan 035). One NS + one EW road, both 60u
 * long, 6 lanes, 6 default vehicles spread across all 4 directions.
 */
export const buildCrossIntersectionNetwork = (): RoadNetwork => {
  const net = createRoadNetwork();

  // Roads: one NS, one EW, both 60u long, 6 lanes (3 each direction).
  // M1.5 — closer to a Chinese city arterial: 3 lanes forward
  // (right-turn, straight, left-turn from the curb) and 3 lanes
  // backward (left-turn, straight, right-turn from the median). The
  // 6-lane layout also stresses the spawn / collision code paths
  // (more lanes = more chances for two cars to be on perpendicular
  // inner lanes at the intersection — the case that was clipping in
  // the 4-lane version).
  const roadNS: Road = roadStraight('r-ns', { x: 0, z: -30 }, { x: 0, z: 30 }, 6, 16.67);
  const roadEW: Road = roadStraight('r-ew', { x: -30, z: 0 }, { x: 30, z: 0 }, 6, 16.67);
  net.roads[roadNS.id] = roadNS;
  net.roads[roadEW.id] = roadEW;

  // Traffic lights at the intersection. tl-ns governs the NS lanes
  // (forward = lane 0..2) and tl-ew governs the EW lanes.
  const lightNS: TrafficLight = {
    id: 'tl-ns',
    position: { x: -4, y: 0, z: 0 },
    phase: LightPhase.Green,
    phaseRemaining: NS_GREEN,
    cycleSeconds: DEFAULT_CYCLE_SECONDS,
    axis: 'ns',
  };
  const lightEW: TrafficLight = {
    id: 'tl-ew',
    position: { x: 0, y: 0, z: -4 },
    phase: LightPhase.Red,
    phaseRemaining: EW_GREEN + 3,  // yellow + red
    cycleSeconds: DEFAULT_CYCLE_SECONDS,
    axis: 'ew',
  };
  const intersection: Intersection = {
    id: 'i-center',
    position: { x: 0, y: 0, z: 0 },
    trafficLights: [lightNS, lightEW],
    connectedRoads: ['r-ns', 'r-ew'],
    intersectionRadius: 8,
  };
  net.intersections[intersection.id] = intersection;

  // 6 default vehicles: one per OUTER lane of each direction.
  const nsLen = roadLength(roadNS);
  const ewLen = roadLength(roadEW);
  const defaults: Vehicle[] = [
    at(roadNS, 0, nsLen * 0.25, 8, { id: 'v-1', type: 'car', color: '#3a86ff', status: 'driving' }),
    at(roadNS, 5, nsLen * 0.75, 8, { id: 'v-2', type: 'car', color: '#ef4444', status: 'driving' }),
    at(roadEW, 0, ewLen * 0.25, 8, { id: 'v-3', type: 'car', color: '#22c55e', status: 'driving' }),
    at(roadEW, 5, ewLen * 0.75, 8, { id: 'v-4', type: 'car', color: '#fbbf24', status: 'driving' }),
    at(roadNS, 1, nsLen * 0.15, 6, { id: 'v-5', type: 'truck', color: '#f5f5f4', status: 'driving' }),
    at(roadEW, 1, ewLen * 0.15, 6, { id: 'v-6', type: 'bus', color: '#22c55e', status: 'driving' }),
  ];
  for (const v of defaults) net.vehicles[v.id] = v;
  return net;
};

/**
 * Back-compat alias: `buildDefaultNetwork` is the original name and is
 * still imported by tests / persistence restore paths. Plan 035 just
 * renames the implementation; the alias keeps the legacy callers
 * compiling until they migrate.
 */
export const buildDefaultNetwork = buildCrossIntersectionNetwork;

/**
 * Plan 035: T-junction demo scene.
 *
 * Layout: EW road (full length) with one NS road attached at its midpoint,
 * and a separate S arm continuing south. Net effect: 3 roads meeting at
 * one intersection (the "T" shape) — 3-way, not 4-way. Two traffic lights
 * control NS vs EW independently. Radius = 6 (smaller than 4-way default
 * because 3-way box is naturally smaller).
 */
export const buildTJunctionNetwork = (): RoadNetwork => {
  const net = createRoadNetwork();
  const half = 50;

  const roadEW: Road = roadStraight('r-ew', { x: -half, z: 0 }, { x: half, z: 0 }, 4, 16.67);
  const roadN: Road = roadStraight('r-n', { x: 0, z: 0 }, { x: 0, z: -half }, 4, 16.67);
  const roadS: Road = roadStraight('r-s', { x: 0, z: 0 }, { x: 0, z: half }, 4, 16.67);
  net.roads[roadEW.id] = roadEW;
  net.roads[roadN.id] = roadN;
  net.roads[roadS.id] = roadS;

  const lightNS: TrafficLight = {
    id: 'tl-ns',
    position: { x: -3, y: 0, z: 0 },
    phase: LightPhase.Green,
    phaseRemaining: NS_GREEN,
    cycleSeconds: DEFAULT_CYCLE_SECONDS,
    axis: 'ns',
  };
  const lightEW: TrafficLight = {
    id: 'tl-ew',
    position: { x: 0, y: 0, z: 3 },
    phase: LightPhase.Red,
    phaseRemaining: EW_GREEN + 3,
    cycleSeconds: DEFAULT_CYCLE_SECONDS,
    axis: 'ew',
  };
  const intersectionT: Intersection = {
    id: 'i-t',
    position: { x: 0, y: 0, z: 0 },
    trafficLights: [lightNS, lightEW],
    connectedRoads: ['r-ew', 'r-n', 'r-s'],  // 3-way
    intersectionRadius: 6,
  };
  net.intersections[intersectionT.id] = intersectionT;

  const ewLen = roadLength(roadEW);
  const nsLen = roadLength(roadN);
  const defaults: Vehicle[] = [
    at(roadEW, 0, ewLen * 0.2, 8, { id: 'v-t1', type: 'car', color: '#3a86ff', status: 'driving' }),
    at(roadN, 0, nsLen * 0.7, 7, { id: 'v-t2', type: 'car', color: '#22c55e', status: 'driving' }),
    at(roadS, 1, nsLen * 0.3, 6, { id: 'v-t3', type: 'truck', color: '#f5f5f4', status: 'driving' }),
    at(roadEW, 1, ewLen * 0.7, 8, { id: 'v-t4', type: 'bus', color: '#fbbf24', status: 'driving' }),
  ];
  for (const v of defaults) net.vehicles[v.id] = v;
  return net;
};

/**
 * Plan 035: rectangular-loop demo scene.
 *
 * 4 straight roads forming a 60×60 square loop, joined at 4 corner
 * intersections (no traffic lights — corner is a smooth turn). Each
 * road is 2 lanes (1 forward, 1 backward). 8 default vehicles spread
 * around the loop so the user sees a circulating traffic pattern.
 *
 * Trade-off note (plan 035 maintenance): vehicles do NOT decelerate on
 * approach to corners. Rapier will let them take the chord at full
 * speed; if Rapier physics pushes them outside their lane, the OOB
 * cleanup (plan 034) catches and respawns them. 036 will add proper
 * cornering via lookahead steering.
 */
export const buildRectangularLoopNetwork = (): RoadNetwork => {
  const net = createRoadNetwork();
  const half = 60;

  const corners: ReadonlyArray<{ x: number; y: number; z: number }> = [
    { x: -half, y: 0, z: -half },  // SW
    { x:  half, y: 0, z: -half },  // SE
    { x:  half, y: 0, z:  half },  // NE
    { x: -half, y: 0, z:  half },  // NW
  ];

  for (let i = 0; i < 4; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    const id = `r-loop-${i}`;
    const road: Road = roadStraight(id, a, b, 2, 13.89);
    net.roads[id] = road;
  }

  for (let i = 0; i < 4; i++) {
    const a = corners[i]!;
    const id = `i-corner-${i}`;
    const inter: Intersection = {
      id,
      position: a,
      trafficLights: [],
      connectedRoads: [`r-loop-${i}`, `r-loop-${(i + 3) % 4}`],
      intersectionRadius: 4,
    };
    net.intersections[id] = inter;
  }

  // 8 vehicles, 2 per road, spread out.
  const defaults: Vehicle[] = [];
  for (let i = 0; i < 4; i++) {
    const road = net.roads[`r-loop-${i}`]!;
    const len = roadLength(road);
    defaults.push(
      at(road, 0, len * 0.20, 7, { id: `v-l1-${i}`, type: 'car', color: '#3a86ff', status: 'driving' }),
      at(road, 1, len * 0.65, 7, { id: `v-l2-${i}`, type: 'car', color: '#22c55e', status: 'driving' }),
    );
  }
  for (const v of defaults) net.vehicles[v.id] = v;
  return net;
};