import type { RoadNetwork } from '@domain/entities/RoadNetwork';
import type { Vehicle } from '@domain/entities/Vehicle';
import type { TrafficLight } from '@domain/entities/TrafficLight';
import type { Intersection } from '@domain/entities/Intersection';
import type { Road } from '@domain/entities/Road';
import { LightPhase } from '@domain/value-objects/Phase';
import { createRoadNetwork } from '@domain/entities/RoadNetwork';

// Bumped to v3 in M1.5: Vehicle gained `enteredIntersectionAt`
// (simulation-time when the car first crossed into an intersection box;
// used by the cross-road emergency-brake logic for right-of-way).
// Bumped to v4 in M2-B (plan 007): LightPhase enum gained 7 new values
// (GreenLeft, YellowLeft, RedLeft, FlashingYellow, FlashingRed, AllRed, Dark).
// hydrateNetwork must accept v3 + v4 scenes; v3 scenes with unknown
// phase values fall back to Red (per plan 007 R1).
export const SCENE_SCHEMA_VERSION = 4;

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

const KNOWN_PHASES = new Set<string>([
  'green',
  'yellow',
  'red',
  'greenLeft',
  'yellowLeft',
  'redLeft',
  'flashingYellow',
  'flashingRed',
  'allRed',
  'dark',
]);

const isLightPhase = (v: unknown): v is TrafficLight['phase'] =>
  typeof v === 'string' && KNOWN_PHASES.has(v);

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

/**
 * M1.5 (v3) → M2-B (v4) migration: v3 has no light phases outside
 * green/yellow/red, so no per-light rewrites needed. Future migrations
 * (e.g. vehicle type change) plug in here.
 */
const migrateScene = (d: any): any => {
  if (d.schemaVersion === 3) {
    return { ...d, schemaVersion: 4 };
  }
  return d;
};

export const hydrateNetwork = (data: unknown): HydrationResult => {
  if (typeof data !== 'object' || data === null) return { ok: false, reason: 'not an object' };
  const migrated = migrateScene(data as any);
  const d = migrated as Partial<SerializedScene>;
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
