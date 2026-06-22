import type { LightPhase } from '../value-objects/Phase';
import type { Position } from '../value-objects/Position';

export interface TrafficLight {
  readonly id: string;
  position: Position;
  phase: LightPhase;
  /** Seconds remaining in the current phase. */
  phaseRemaining: number;
  /** Total cycle time in seconds (red+yellow+green). */
  cycleSeconds: number;
  /** Direction the light governs: N/S or E/W. */
  axis: 'ns' | 'ew';
}
