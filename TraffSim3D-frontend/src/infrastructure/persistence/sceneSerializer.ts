import type { RoadNetwork } from '@domain/entities/RoadNetwork';
import type { Vehicle } from '@domain/entities/Vehicle';
import type { TrafficLight } from '@domain/entities/TrafficLight';
import type { Intersection } from '@domain/entities/Intersection';
import type { Road } from '@domain/entities/Road';
import { LightPhase } from '@domain/value-objects/Phase';
import { createRoadNetwork } from '@domain/entities/RoadNetwork';

export const SCENE_SCHEMA_VERSION = 1;

export interface SerializedScene {
  schemaVersion: number;
  savedAtMs: number;
  network: {
    roads: Road[];
    intersections: SerializedIntersection[];
    vehicles: Vehicle[];
  };
}

interface SerializedIntersection extends Omit<Intersection, 'trafficLights'> {
  trafficLights: TrafficLight[];
}

const isLightPhase = (v: unknown): v is TrafficLight['phase'] =>
  v === LightPhase.Red || v === LightPhase.Yellow || v === LightPhase.Green;

export const serializeNetwork = (network: RoadNetwork): SerializedScene => ({
  schemaVersion: SCENE_SCHEMA_VERSION,
  savedAtMs: Date.now(),
  network: {
    roads: Object.values(network.roads),
    intersections: Object.values(network.intersections),
    vehicles: Object.values(network.vehicles),
  },
});

export interface HydrationResult {
  ok: boolean;
  reason?: string;
  network?: RoadNetwork;
}

export const hydrateNetwork = (data: unknown): HydrationResult => {
  if (typeof data !== 'object' || data === null) return { ok: false, reason: 'not an object' };
  const d = data as Partial<SerializedScene>;
  if (d.schemaVersion !== SCENE_SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported schemaVersion ${d.schemaVersion}` };
  }
  if (!d.network || !Array.isArray(d.network.roads) || !Array.isArray(d.network.intersections) || !Array.isArray(d.network.vehicles)) {
    return { ok: false, reason: 'network shape invalid' };
  }
  const net = createRoadNetwork();
  for (const r of d.network.roads) net.roads[r.id] = r;
  for (const i of d.network.intersections) {
    if (!i.trafficLights.every((l) => isLightPhase(l.phase))) {
      return { ok: false, reason: 'invalid light phase' };
    }
    net.intersections[i.id] = i;
  }
  for (const v of d.network.vehicles) net.vehicles[v.id] = v;
  return { ok: true, network: net };
};
