import { createRoadNetwork, type RoadNetwork } from '@domain/entities/RoadNetwork';
import type { Vehicle } from '@domain/entities/Vehicle';
import type { TrafficLight } from '@domain/entities/TrafficLight';
import type { Intersection } from '@domain/entities/Intersection';
import type { Road } from '@domain/entities/Road';
import { LightPhase } from '@domain/value-objects/Phase';
import { DEFAULT_CYCLE_SECONDS } from '@shared/constants/simulation';

const NS_GREEN = DEFAULT_CYCLE_SECONDS * (30 / 63);  // ~30s
const EW_GREEN = NS_GREEN;

export const buildDefaultNetwork = (): RoadNetwork => {
  const net = createRoadNetwork();
  // Roads: one NS, one EW, both 60u long
  const roadNS: Road = {
    id: 'r-ns',
    startNode: { x: 0, y: 0, z: -30 },
    endNode: { x: 0, y: 0, z: 30 },
    laneCount: 4,
    speedLimit: 16.67,  // 60 km/h
  };
  const roadEW: Road = {
    id: 'r-ew',
    startNode: { x: -30, y: 0, z: 0 },
    endNode: { x: 30, y: 0, z: 0 },
    laneCount: 4,
    speedLimit: 16.67,
  };
  net.roads[roadNS.id] = roadNS;
  net.roads[roadEW.id] = roadEW;

  // Intersection
  const lightNS: TrafficLight = {
    id: 'tl-ns',
    position: { x: 0, y: 0, z: -4 },
    phase: LightPhase.Green,
    phaseRemaining: NS_GREEN,
    cycleSeconds: DEFAULT_CYCLE_SECONDS,
    axis: 'ns',
  };
  const lightEW: TrafficLight = {
    id: 'tl-ew',
    position: { x: -4, y: 0, z: 0 },
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

  // Vehicles: 4 cars driving in a closed loop around the intersection
  const loop: Vehicle[] = [
    { id: 'v-1', type: 'car', position: { x: 0, y: 0, z: -15 }, speed: 8, heading: 0, lane: 'r-ns#1', color: '#3a86ff', status: 'driving' },
    { id: 'v-2', type: 'car', position: { x: 0, y: 0, z: 15 },  speed: 8, heading: Math.PI, lane: 'r-ns#2', color: '#ef4444', status: 'driving' },
    { id: 'v-3', type: 'car', position: { x: -15, y: 0, z: 0 }, speed: 8, heading: Math.PI / 2, lane: 'r-ew#1', color: '#22c55e', status: 'driving' },
    { id: 'v-4', type: 'car', position: { x: 15, y: 0, z: 0 },  speed: 8, heading: -Math.PI / 2, lane: 'r-ew#2', color: '#fbbf24', status: 'driving' },
  ];
  for (const v of loop) net.vehicles[v.id] = v;
  return net;
};
