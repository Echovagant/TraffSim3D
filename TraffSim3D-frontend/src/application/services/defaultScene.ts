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
const at = (road: Road, laneIndex: number, s: number, speed: number, v: Omit<Vehicle, 'position' | 'heading' | 'lane' | 's' | 'speed' | 'targetSpeed' | 'roadId' | 'laneIndex' | 'enteredIntersectionAt' | 'desiredLaneIndex' | 'laneChangeStartedAt'>): Vehicle => {
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
  };
};

export const buildDefaultNetwork = (): RoadNetwork => {
  const net = createRoadNetwork();

  // Roads: one NS, one EW, both 60u long, 6 lanes (3 each direction).
  // M1.5 — closer to a Chinese city arterial: 3 lanes forward
  // (right-turn, straight, left-turn from the curb) and 3 lanes
  // backward (left-turn, straight, right-turn from the median). The
  // 6-lane layout also stresses the spawn / collision code paths
  // (more lanes = more chances for two cars to be on perpendicular
  // inner lanes at the intersection — the case that was clipping in
  // the 4-lane version).
  const roadNS: Road = {
    id: 'r-ns',
    startNode: { x: 0, y: 0, z: -30 },
    endNode: { x: 0, y: 0, z: 30 },
    laneCount: 6,
    speedLimit: 16.67,  // 60 km/h
  };
  const roadEW: Road = {
    id: 'r-ew',
    startNode: { x: -30, y: 0, z: 0 },
    endNode: { x: 30, y: 0, z: 0 },
    laneCount: 6,
    speedLimit: 16.67,
  };
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
  };
  net.intersections[intersection.id] = intersection;

  // 6 default vehicles: one per OUTER lane of each direction (the
  // outermost = right turn lane for the forward direction, the
  // outermost = right turn lane for the backward direction). This
  // gives the demo a sensible "rush of traffic from all four sides"
  // look without immediately piling cars onto the inner (left-turn)
  // lanes that would clip at the intersection in the absence of the
  // collision check. Lanes 0, 1, 2 are forward (north for NS, east
  // for EW); lanes 3, 4, 5 are backward.
  //
  // Previously these had headings perpendicular to the road — a
  // literal M1 bug; the new lane-based geometry fixes it.
  const nsLen = roadLength(roadNS);
  const ewLen = roadLength(roadEW);
  const defaults: Vehicle[] = [
    // NS road — forward (northbound) on outer (right) lane 0.
    at(roadNS, 0, nsLen * 0.25, 8, { id: 'v-1', type: 'car', color: '#3a86ff', status: 'driving' }),
    // NS road — backward (southbound) on outer (right) lane 5.
    at(roadNS, 5, nsLen * 0.75, 8, { id: 'v-2', type: 'car', color: '#ef4444', status: 'driving' }),
    // EW road — forward (eastbound) on outer (right) lane 0.
    at(roadEW, 0, ewLen * 0.25, 8, { id: 'v-3', type: 'car', color: '#22c55e', status: 'driving' }),
    // EW road — backward (westbound) on outer (right) lane 5.
    at(roadEW, 5, ewLen * 0.75, 8, { id: 'v-4', type: 'car', color: '#fbbf24', status: 'driving' }),
    // NS road — middle (straight) lane 1, approaching from south.
    at(roadNS, 1, nsLen * 0.15, 6, { id: 'v-5', type: 'truck', color: '#f5f5f4', status: 'driving' }),
    // EW road — middle (straight) lane 1, approaching from west.
    at(roadEW, 1, ewLen * 0.15, 6, { id: 'v-6', type: 'bus', color: '#22c55e', status: 'driving' }),
  ];
  for (const v of defaults) net.vehicles[v.id] = v;
  return net;
};
