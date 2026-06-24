// src/__fixtures__/testNetwork.ts
//
// Hand-rolled minimal RoadNetwork fixtures for unit tests. Avoids
// depending on `buildDefaultNetwork()` (whose shape evolves with
// M1.5/M2 churn) — instead defines just the structure the tests
// need: 2 perpendicular roads, 1 intersection, 1 light.

import type { RoadNetwork } from '@domain/entities/RoadNetwork';
import type { Vehicle } from '@domain/entities/Vehicle';
import type { TrafficLight } from '@domain/entities/TrafficLight';
import type { Intersection } from '@domain/entities/Intersection';
import type { Road } from '@domain/entities/Road';
import { LightPhase } from '@domain/value-objects/Phase';
import { createRoadNetwork } from '@domain/entities/RoadNetwork';
import { LaneId } from '@domain/value-objects/LaneId';

export const makeTestRoad = (id: string, axis: 'ns' | 'ew', laneCount = 2): Road => {
  const isNS = axis === 'ns';
  return {
    id,
    startNode: isNS ? { x: 0, y: 0, z: -30 } : { x: -30, y: 0, z: 0 },
    endNode: isNS ? { x: 0, y: 0, z: 30 } : { x: 30, y: 0, z: 0 },
    laneCount,
    speedLimit: 20,
  };
};

export const makeTestIntersection = (id: string, light: TrafficLight): Intersection => ({
  id,
  position: { x: 0, y: 0, z: 0 },
  connectedRoads: ['r-ns', 'r-ew'],
  trafficLights: [light],
});

export const makeTestLight = (overrides: Partial<TrafficLight> = {}): TrafficLight => ({
  id: 'tl-1',
  position: { x: 0, y: 0, z: 0 },
  phase: LightPhase.Green,
  phaseRemaining: 30,
  cycleSeconds: 63,
  axis: 'ns',
  ...overrides,
});

export const makeTestVehicle = (overrides: Partial<Vehicle> = {}): Vehicle => ({
  id: 'v-1',
  type: 'car',
  color: '#3a86ff',
  position: { x: 0, y: 0, z: -20 },
  heading: 0,
  speed: 0,
  targetSpeed: 20,
  roadId: 'r-ns',
  laneIndex: 0,
  s: 10,
  lane: LaneId.make('r-ns', 0),
  status: 'driving',
  enteredIntersectionAt: null,
  desiredLaneIndex: null,
  laneChangeStartedAt: null,
  ...overrides,
});

export const buildTestNetwork = (
  vehicleCount = 0,
  lightOverrides: Partial<TrafficLight> = {},
): RoadNetwork => {
  const net = createRoadNetwork();
  net.roads['r-ns'] = makeTestRoad('r-ns', 'ns', 2);
  net.roads['r-ew'] = makeTestRoad('r-ew', 'ew', 2);
  net.intersections['i-1'] = makeTestIntersection('i-1', makeTestLight(lightOverrides));
  for (let k = 0; k < vehicleCount; k++) {
    net.vehicles[`v-${k + 1}`] = makeTestVehicle({
      id: `v-${k + 1}`,
      s: 5 + k * 8,  // spread out so they don't overlap
    });
  }
  return net;
};
