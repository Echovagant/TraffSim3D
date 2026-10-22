// CoordinatedController unit tests.
//
// Verify the 4 critical behaviors:
//   1. enabled=false / offset=0 — fixed-cycle compatible (错开 30s)
//   2. enabled + offset=0 — same as 1
//   3. enabled + offset=15 — EW green lags NS green by 15s
//   4. simTime rewinds → phaseTable entry rebuilt
import { describe, it, expect } from 'vitest'
import { CoordinatedController, type CoordinatedControllerDeps } from './CoordinatedController'
import type { TrafficLight } from '@domain/entities/TrafficLight'
import { LightPhase } from '@domain/value-objects/Phase'
import type { Position } from '@domain/value-objects/Position'

const makeLight = (
  axis: 'ns' | 'ew',
  phase: LightPhase = LightPhase.Green,
  phaseRemaining = 30,
): TrafficLight => ({
  id: `tl-${axis}`,
  axis,
  phase,
  phaseRemaining,
  position: { x: 0, y: 0, z: 0 } as Position,
  cycleSeconds: 63,
})

const makeDeps = (offsets: Map<string, number>, enabled: boolean): CoordinatedControllerDeps => ({
  getOffsets: () => offsets,
  isEnabled: () => enabled,
})

const EMPTY_NETWORK = { roads: {}, vehicles: {}, intersections: {} } as never

describe('CoordinatedController', () => {
  it('enabled=false → 退化为 FixedCycle 行为 (NS/EW 错开 30s)', () => {
    const c = new CoordinatedController(makeDeps(new Map(), false))
    const ns = makeLight('ns', LightPhase.Green)
    const ew = makeLight('ew', LightPhase.Red)
    expect(c.decide(ns, EMPTY_NETWORK, 0).phase).toBe(LightPhase.Green)
    // NS 在 t=0 是绿; EW 默认与 NS 错开 30s, 此时是 Red.
    // EW 的 decide 应该返回 Red (绿 30s 已过).
    expect(c.decide(ew, EMPTY_NETWORK, 0).phase).toBe(LightPhase.Red)
  })

  it('enabled + offset=0 → 与 enabled=false 行为一致', () => {
    const c = new CoordinatedController(makeDeps(new Map([['r-ns|r-ew', 0]]), true))
    const ns = makeLight('ns', LightPhase.Green)
    const ew = makeLight('ew', LightPhase.Red)
    expect(c.decide(ns, EMPTY_NETWORK, 0).phase).toBe(LightPhase.Green)
    expect(c.decide(ew, EMPTY_NETWORK, 0).phase).toBe(LightPhase.Red)
  })

  it('enabled + offset=15 → EW green 滞后 NS green 15s', () => {
    // NS 当前是 Red (默认 phase=Red in network). 模拟 NS 在 t=10 时刚变红 (红段 30s).
    // 我们关心的是 EW 在 t=10 时的 phase: 它应该已经处于绿段 (因为 greenStart = 10 + 15 = 25, elapsed = 25-15 = 10 → 在 0-30 段 → Green).
    const c = new CoordinatedController(makeDeps(new Map([['r-ns|r-ew', 15]]), true))
    const ew = makeLight('ew', LightPhase.Red) // phase=Red 不影响, computeOffsetForPhase 把 greenStart 校到 Red 段
    // EW 在 t=10: greenStart = 10 - (30+3) + 15 = -8; elapsed = ((10 - (-8)) % 63 + 63) % 63 = 18; Green.
    const d = c.decide(ew, EMPTY_NETWORK, 10)
    expect(d.phase).toBe(LightPhase.Green)
    expect(d.duration).toBeCloseTo(30 - 18, 1)
  })

  it('simTime 回退 → phaseTable entry 重建 (新 greenStart)', () => {
    const c = new CoordinatedController(makeDeps(new Map(), false))
    const light = makeLight('ns', LightPhase.Green)
    // 第一次: t=100
    const d1 = c.decide(light, EMPTY_NETWORK, 100)
    // 回退: t=50. 应当重建 phaseTable. light 仍在 Green.
    const d2 = c.decide(light, EMPTY_NETWORK, 50)
    expect(d2.phase).toBe(LightPhase.Green)
    // 跟 d1 的 duration 应当一致 (因为两次 greenStart 都校准到 Green 段起点)
    expect(d2.duration).toBeCloseTo(d1.duration, 1)
    // 再调一次 t=50 (前进), phase 应当仍为 Green 但 duration 略小 (过了一些时间).
    const d3 = c.decide(light, EMPTY_NETWORK, 55)
    expect(d3.phase).toBe(LightPhase.Green)
    expect(d3.duration).toBeLessThan(d2.duration)
  })
})
