import type { Intersection } from './Intersection';
import type { Road } from './Road';
import type { Vehicle } from './Vehicle';

export interface RoadNetwork {
  roads: Record<string, Road>;
  intersections: Record<string, Intersection>;
  vehicles: Record<string, Vehicle>;
  /** Find road by id; returns undefined if missing. */
  road(id: string): Road | undefined;
  intersection(id: string): Intersection | undefined;
  vehicle(id: string): Vehicle | undefined;
}

export const createRoadNetwork = (): RoadNetwork => {
  const roads: Record<string, Road> = {};
  const intersections: Record<string, Intersection> = {};
  const vehicles: Record<string, Vehicle> = {};
  return {
    roads,
    intersections,
    vehicles,
    road: (id) => roads[id],
    intersection: (id) => intersections[id],
    vehicle: (id) => vehicles[id],
  };
};
