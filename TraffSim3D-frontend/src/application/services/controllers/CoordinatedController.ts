// src/application/services/controllers/CoordinatedController.ts
//
// The coordinated controller — the green wave.
//
// A green wave is a relation **between junctions**: the green of the
// next junction along a corridor starts a fixed number of seconds after
// the green of the previous one. So the offset is per **junction**, not
// per road pair: the junction's whole plan is shifted by its offset
// against the common reference, and the shift is what the wave is.
//
// The phase comes from the sim time (not from a countdown), so the
// clearance is exactly 6 s and the period exactly 72 s however the
// junctions are offset. The offsets are read from the world store,
// which owns them.
//
// The legacy key `r-ns|r-ew` is the **corridor-wide default**: a
// junction without an explicit offset inherits it. It is the key the
// editor has always written, so the existing UI keeps working.

import type { Intersection } from '@domain/entities/Intersection'
import { LightPhase } from '@domain/value-objects/Phase'
import {
  ALL_RED_CLEARANCE_SECS,
  DEFAULT_CYCLE_SECONDS,
  GREEN_PHASE_SECS,
  YELLOW_CLEAR_SECS,
} from '@shared/constants/simulation'
import type { SignalAxis } from '../signalController'
import { JunctionControllerBase, type JunctionPlanState } from './junctionPlan'

/**
 * The key the corridor-wide default offset lives under.
 *
 * It is the road pair of the built-in demo scene — the key the editor
 * has always written. A junction without an explicit offset inherits
 * it, so the old single-offset UI keeps working while the per-junction
 * offsets take precedence.
 */
export const COORDINATED_DEFAULT_OFFSET_KEY = 'r-ns|r-ew'

const CYCLE_SECS = DEFAULT_CYCLE_SECONDS
const GREEN_SECS = GREEN_PHASE_SECS
const YELLOW_SECS = YELLOW_CLEAR_SECS
const ALL_RED_SECS = ALL_RED_CLEARANCE_SECS

/** The boundaries of the junction's cycle, in seconds from its start. */
const SERVED_GREEN_END = GREEN_SECS
const SERVED_YELLOW_END = GREEN_SECS + YELLOW_SECS
const SERVED_ALL_RED_END = GREEN_SECS + YELLOW_SECS + ALL_RED_SECS
const OTHER_GREEN_END = SERVED_ALL_RED_END + GREEN_SECS
const OTHER_YELLOW_END = OTHER_GREEN_END + YELLOW_SECS

export interface CoordinatedControllerDeps {
  /** junction id → the offset (seconds) of that junction's green. */
  getOffsets: () => ReadonlyMap<string, number>
  isEnabled: () => boolean
}

/**
 * The phase a junction shows at `elapsed` seconds into its cycle.
 *
 * The served axis goes first, the other one second — the same order
 * the junction's plan uses.
 */
const phaseAt = (
  elapsed: number,
  servedAxis: SignalAxis,
): { phase: LightPhase; axis: SignalAxis; remaining: number } => {
  const other: SignalAxis = servedAxis === 'ns' ? 'ew' : 'ns'
  if (elapsed < SERVED_GREEN_END) {
    return { phase: LightPhase.Green, axis: servedAxis, remaining: SERVED_GREEN_END - elapsed }
  }
  if (elapsed < SERVED_YELLOW_END) {
    return { phase: LightPhase.Yellow, axis: servedAxis, remaining: SERVED_YELLOW_END - elapsed }
  }
  if (elapsed < SERVED_ALL_RED_END) {
    return { phase: LightPhase.AllRed, axis: servedAxis, remaining: SERVED_ALL_RED_END - elapsed }
  }
  if (elapsed < OTHER_GREEN_END) {
    return { phase: LightPhase.Green, axis: other, remaining: OTHER_GREEN_END - elapsed }
  }
  if (elapsed < OTHER_YELLOW_END) {
    return { phase: LightPhase.Yellow, axis: other, remaining: OTHER_YELLOW_END - elapsed }
  }
  return { phase: LightPhase.AllRed, axis: other, remaining: CYCLE_SECS - elapsed }
}

/**
 * The offset of a phase inside the cycle — how far into the cycle that
 * phase starts. Used to re-anchor the junction without a phase jump.
 */
const cycleOffsetOf = (phase: LightPhase, axis: SignalAxis, servedAxis: SignalAxis): number => {
  const served = axis === servedAxis
  if (phase === LightPhase.Green) return served ? 0 : SERVED_ALL_RED_END
  if (phase === LightPhase.Yellow) return served ? GREEN_SECS : OTHER_GREEN_END
  return served ? SERVED_YELLOW_END : OTHER_YELLOW_END
}

export class CoordinatedController extends JunctionControllerBase {
  /** The sim time the served axis' green started — the junction's anchor. */
  private anchor: number | null = null
  /** The axis the junction serves first in its cycle. */
  private servedAxis: SignalAxis = 'ns'
  /** The last sim time seen — a rewind rebuilds the anchor. */
  private lastSimTime = Number.NEGATIVE_INFINITY
  /** The offset the anchor was built with. */
  private usedOffset = 0

  constructor(private readonly deps: CoordinatedControllerDeps) {
    super()
  }

  /**
   * The junction's phase, read off the sim time.
   *
   * The plan is anchored when the controller first sees the junction (or
   * when the offset changes, or when the sim time rewinds) and the phase
   * follows from it. The anchor is rebuilt from the phase the junction is
   * in, so the change is seamless — the junction does not jump.
   */
  protected override advance(
    state: JunctionPlanState,
    junction: Intersection,
    _dt: number,
    simTime: number,
  ): void {
    // While the junction is held, its clock is frozen: the plan keeps
    // showing the all-red and the cycle carries on underneath.
    if (state.allRedUntil > Number.NEGATIVE_INFINITY) {
      this.lastSimTime = simTime
      return
    }
    if (this.anchor === null) this.servedAxis = state.axis
    const offset = this.offsetFor(junction)
    if (this.anchor === null || simTime < this.lastSimTime || offset !== this.usedOffset) {
      const phaseOffset = cycleOffsetOf(state.phase, state.axis, this.servedAxis)
      this.anchor = simTime - phaseOffset + offset
      this.usedOffset = offset
    }
    this.lastSimTime = simTime
    const elapsed = (((simTime - this.anchor) % CYCLE_SECS) + CYCLE_SECS) % CYCLE_SECS
    const { phase, axis, remaining } = phaseAt(elapsed, this.servedAxis)
    state.phase = phase
    state.axis = axis
    state.remaining = remaining
  }

  /**
   * The junction's offset: its own, or the corridor-wide default.
   *
   * The offsets are only honoured when the coordination is enabled — the
   * switch in the UI.
   */
  private offsetFor(junction: Intersection): number {
    if (!this.deps.isEnabled()) return 0
    const offsets = this.deps.getOffsets()
    const own = offsets.get(junction.id)
    if (typeof own === 'number') return own
    const fallback = offsets.get(COORDINATED_DEFAULT_OFFSET_KEY)
    return typeof fallback === 'number' ? fallback : 0
  }
}
