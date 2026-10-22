// FixedStepScheduler unit tests.
//
// Verifies the four invariants the rest of the codebase relies on:
//   1. Boundary crossing: wallDt < fixedStepSec → false, then
//      accumulated wallDt ≥ fixedStepSec → true
//   2. Sim time advances by exactly fixedStepSec per true return
//   3. Accumulator stays in [0, fixedStepSec) across many calls
//   4. wallDt is clamped to maxAccumulator (browser pause survival)

import { describe, it, expect } from 'vitest'
import { FixedStepScheduler } from './fixedStepScheduler'

describe('FixedStepScheduler', () => {
  it('returns false while accumulator is below the fixed step', () => {
    const s = new FixedStepScheduler({ fixedStepSec: 0.1 })
    expect(s.advance(0.05)).toBe(false) // 0.05 < 0.1 → not yet
    expect(s.getAccumulator()).toBeCloseTo(0.05, 6)
    expect(s.getSimTime()).toBe(0)
  })

  it('returns true once accumulator reaches the fixed step', () => {
    const s = new FixedStepScheduler({ fixedStepSec: 0.1 })
    expect(s.advance(0.05)).toBe(false)
    expect(s.advance(0.06)).toBe(true) // 0.05 + 0.06 = 0.11 ≥ 0.1
    expect(s.getSimTime()).toBeCloseTo(0.1, 6)
    // accumulator reset to the remainder (0.11 - 0.1 = 0.01)
    expect(s.getAccumulator()).toBeCloseTo(0.01, 6)
  })

  it('clamps wallDt to maxAccumulator on long pauses (single call)', () => {
    // A 2-second browser-GC pause passed in ONE advance() call. The
    // clamp limits the *consumed* wallDt to maxAccumulator (0.5s), so
    // only 5 steps fire in this call. The "missing" 1.5s of wall time
    // is silently dropped — that's the trade-off vs. catching up at
    // 2× speed.
    const s = new FixedStepScheduler({ fixedStepSec: 0.1, maxAccumulator: 0.5 })
    // First call: clamps to 0.5, fires 1 step (simTime = 0.1, accumulator = 0.4).
    expect(s.advance(2.0)).toBe(true)
    expect(s.getSimTime()).toBeCloseTo(0.1, 6)
    expect(s.getAccumulator()).toBeCloseTo(0.4, 6)
  })

  it('clamps wallDt to maxAccumulator on long pauses (many small calls)', () => {
    // Realistic use site: render loop calls advance() every frame with
    // small wallDt. 60 calls × 1/60s = 1 second of sim time, expected
    // 10 steps at 10 Hz (±1 for floating-point + frame jitter).
    const s = new FixedStepScheduler({ fixedStepSec: 0.1, maxAccumulator: 0.5 })
    let steps = 0
    for (let i = 0; i < 60; i++) {
      if (s.advance(1 / 60)) steps += 1
    }
    expect(steps).toBeGreaterThanOrEqual(9)
    expect(steps).toBeLessThanOrEqual(11)
  })

  it('rejects invalid construction (fixedStepSec ≤ 0)', () => {
    expect(() => new FixedStepScheduler({ fixedStepSec: 0 })).toThrow()
    expect(() => new FixedStepScheduler({ fixedStepSec: -0.1 })).toThrow()
  })

  it('rejects maxAccumulator < fixedStepSec', () => {
    expect(() => new FixedStepScheduler({ fixedStepSec: 0.1, maxAccumulator: 0.05 })).toThrow()
  })

  it('reset() zeroes both accumulator and simTime', () => {
    const s = new FixedStepScheduler({ fixedStepSec: 0.1 })
    s.advance(0.2) // 1 step + 0.1 remainder
    expect(s.getSimTime()).toBeCloseTo(0.1, 6)
    s.reset()
    expect(s.getSimTime()).toBe(0)
    expect(s.getAccumulator()).toBe(0)
  })

  it('advance(wallDt=0) is a no-op', () => {
    const s = new FixedStepScheduler({ fixedStepSec: 0.1 })
    expect(s.advance(0)).toBe(false)
    expect(s.getSimTime()).toBe(0)
    expect(s.getAccumulator()).toBe(0)
  })

  it('many small advances produce evenly-spaced simTime', () => {
    const s = new FixedStepScheduler({ fixedStepSec: 0.1 })
    const simTimes: number[] = []
    // 60Hz render loop (dt = 1/60 = 0.01667), call 60 times = 1s
    // Expected: every 6th call fires a step → 10 steps total in 1s
    for (let i = 0; i < 60; i++) {
      if (s.advance(1 / 60)) simTimes.push(s.getSimTime())
    }
    expect(simTimes.length).toBeGreaterThanOrEqual(9)
    expect(simTimes.length).toBeLessThanOrEqual(11)
    // Each step advances by exactly 0.1s
    for (let i = 1; i < simTimes.length; i++) {
      expect(simTimes[i]! - simTimes[i - 1]!).toBeCloseTo(0.1, 6)
    }
  })
})
