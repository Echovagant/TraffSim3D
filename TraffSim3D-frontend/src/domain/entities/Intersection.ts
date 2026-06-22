import type { Position } from '../value-objects/Position';
import type { TrafficLight } from './TrafficLight';

export interface Intersection {
  readonly id: string;
  position: Position;
  trafficLights: TrafficLight[];
  /** Road ids that terminate at this intersection. */
  connectedRoads: string[];
}
