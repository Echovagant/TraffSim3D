// Coordinated signal controller — green-wave.
//
// Pairwise offset: r-ew 的绿相位起始时间比 r-ns 晚 `offset` 秒.
// Phase 长度严格 30/3/30, 不做延长/缩短 (与 FixedCycle 行为一致).
//
// 决定算法: 在内部维护 phaseTable, 第一次 decide 时按当前 simTime
// 锁定 greenStart, 之后用 (simTime - greenStart) mod 63 推出 phase.
import type { TrafficLight } from '@domain/entities/TrafficLight'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import { LightPhase } from '@domain/value-objects/Phase'
import type { SignalAction, SignalController, SignalDecision } from '../signalController'

const CYCLE_SECS = 63
const GREEN_SECS = 30
const YELLOW_SECS = 3
const RED_SECS = 30

/** Default pair key for the default scene. Multi-pair is
 *  handled by a future plan (030 corridor discovery). */
const DEFAULT_PAIR = 'r-ns|r-ew'

const greenOffsetForAxis = (
  axis: 'ns' | 'ew',
  pair: string,
  offsets: ReadonlyMap<string, number>,
  enabled: boolean,
): number => {
  if (!enabled) return 0
  if (axis === 'ns') return 0
  const v = offsets.get(pair)
  return typeof v === 'number' ? v : 0
}

interface PhaseTableEntry {
  /** Absolute simTime at which the light enters Green. */
  greenStart: number
  /** Last simTime we ran decide() for this light — used to detect
   *  simTime rewinds (scene reload, save/restore) and rebuild. */
  lastDecideSimTime: number
}

export interface CoordinatedControllerDeps {
  /** Same map worldStore exposes via coordinatedOffsets. */
  getOffsets: () => ReadonlyMap<string, number>
  isEnabled: () => boolean
}

export class CoordinatedController implements SignalController {
  private phaseTable = new Map<string, PhaseTableEntry>()
  constructor(private readonly deps: CoordinatedControllerDeps) {}

  decide(light: TrafficLight, _network: RoadNetwork, simTime: number): SignalDecision {
    // SimTime 回退 → 重建 phaseTable.
    let entry = this.phaseTable.get(light.id)
    if (!entry || simTime < entry.lastDecideSimTime) {
      const offsets = this.deps.getOffsets()
      const enabled = this.deps.isEnabled()
      const pairOffset = greenOffsetForAxis(light.axis, DEFAULT_PAIR, offsets, enabled)
      // 让 greenStart 与 light.phase 对齐 — 切 controller 时不闪相位.
      // Green → greenStart = simTime - 0 (刚刚开始, 整段绿 30s)
      // Yellow → greenStart = simTime - 30 (黄段开始 0s 之前, 即将进入 Red)
      // Red → greenStart = simTime - 33 (红段开始 0s 之前, 即将进入 Green 30s)
      const phaseOffset = computeOffsetForPhase(light.phase)
      const greenStart = simTime - phaseOffset + pairOffset
      entry = { greenStart, lastDecideSimTime: simTime }
      this.phaseTable.set(light.id, entry)
    }
    entry.lastDecideSimTime = simTime

    const elapsed = (((simTime - entry.greenStart) % CYCLE_SECS) + CYCLE_SECS) % CYCLE_SECS
    let phase: LightPhase
    let duration: number
    if (elapsed < GREEN_SECS) {
      phase = LightPhase.Green
      duration = GREEN_SECS - elapsed
    } else if (elapsed < GREEN_SECS + YELLOW_SECS) {
      phase = LightPhase.Yellow
      duration = GREEN_SECS + YELLOW_SECS - elapsed
    } else {
      phase = LightPhase.Red
      duration = CYCLE_SECS - elapsed
    }
    return {
      phase,
      duration,
      actions: [{ name: 'no_op', available: true }],
      decidedAt: simTime,
    }
  }

  applyAction(_light: TrafficLight, _action: SignalAction['name']): void {
    // No external action queue (RLController).
  }
}

/** Map a light's current phase to the greenStart offset such that the
 *  decision at simTime lands in the same phase. This way switching
 *  controllerKind does not flash the light. */
function computeOffsetForPhase(phase: LightPhase): number {
  if (phase === LightPhase.Green) return 0
  if (phase === LightPhase.Yellow) return GREEN_SECS
  return GREEN_SECS + YELLOW_SECS
}
