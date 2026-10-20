import type { LightPhase } from '../value-objects/Phase'
import type { Position } from '../value-objects/Position'

export interface TrafficLight {
  readonly id: string
  position: Position
  phase: LightPhase
  /** Seconds remaining in the current phase. */
  phaseRemaining: number
  /** Total cycle time in seconds (red+yellow+green). */
  cycleSeconds: number
  /** Direction the light governs: N/S or E/W. */
  axis: 'ns' | 'ew'
  /**
   * Which lane index this light controls (used by ActuatedController
   * to count queue length). M1 default lights don't set this — the
   * controller falls back to "any lane on this axis" when undefined.
   * M2-B default scenes will set it explicitly (lane 0 for the
   * outermost right-turn lane).
   */
  controlledLane?: number
}
