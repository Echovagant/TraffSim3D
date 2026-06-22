import type { Position } from '../value-objects/Position';

export interface Road {
  readonly id: string;
  startNode: Position;
  endNode: Position;
  laneCount: number;
  /** Speed limit in m/s. */
  speedLimit: number;
}
