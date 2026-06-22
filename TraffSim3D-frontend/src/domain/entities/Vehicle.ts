import type { LaneId } from '../value-objects/LaneId';
import type { Position } from '../value-objects/Position';
import type { Speed } from '../value-objects/Speed';

export type VehicleType = 'car' | 'truck' | 'bus';
export type VehicleStatus = 'driving' | 'waiting' | 'crashed';

export interface Vehicle {
  readonly id: string;
  type: VehicleType;
  position: Position;
  speed: Speed;
  /** Heading in radians; 0 = +x, increasing counter-clockwise in the xz plane. */
  heading: number;
  lane: LaneId;
  color: string;  // hex string, e.g. '#3a86ff'
  status: VehicleStatus;
}
