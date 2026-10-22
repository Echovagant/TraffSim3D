// src/infrastructure/physics/WorldConfig.spec.ts
//
// The physics contract constants. `fixedDt` is load-bearing: 1 step/frame and
// simTime accumulates by exactly this value, so assert it as a number, not
// as "is defined".

import { describe, it, expect } from 'vitest'
import { DEFAULT_WORLD_CONFIG } from './WorldConfig'

describe('DEFAULT_WORLD_CONFIG', () => {
  it('seed is the fixed 0xDEFA17 determinism sentinel (14613015)', () => {
    expect(DEFAULT_WORLD_CONFIG.seed).toBe(0xdefa17)
    expect(DEFAULT_WORLD_CONFIG.seed).toBe(14613015)
  })

  it('fixedDt is exactly 1/60 s (I5 mandate) — 60 steps == 1 wall-clock second', () => {
    expect(DEFAULT_WORLD_CONFIG.fixedDt).toBe(1 / 60)
    expect(DEFAULT_WORLD_CONFIG.fixedDt * 60).toBeCloseTo(1, 12)
  })

  it('gravity is earth gravity straight down the -Y axis only', () => {
    expect(DEFAULT_WORLD_CONFIG.gravity).toEqual({ x: 0, y: -9.81, z: 0 })
  })

  it('groundThickness is 0.1 m', () => {
    expect(DEFAULT_WORLD_CONFIG.groundThickness).toBe(0.1)
  })

  it('has no extra keys beyond the 4 WorldConfig fields', () => {
    expect(Object.keys(DEFAULT_WORLD_CONFIG).sort()).toEqual([
      'fixedDt',
      'gravity',
      'groundThickness',
      'seed',
    ])
  })

  it('is a mutable plain object — a caller may clone-and-tune without affecting the default', () => {
    const tuned = { ...DEFAULT_WORLD_CONFIG, fixedDt: 1 / 120 }
    expect(tuned.fixedDt).toBe(1 / 120)
    expect(DEFAULT_WORLD_CONFIG.fixedDt).toBe(1 / 60)
    // gravity is shared by reference in a shallow copy; assert the value so a
    // future deep-clone refactor can't silently drop it.
    expect(tuned.gravity.y).toBe(-9.81)
  })
})
