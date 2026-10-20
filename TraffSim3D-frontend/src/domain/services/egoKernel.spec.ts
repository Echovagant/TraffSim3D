// src/domain/services/egoKernel.spec.ts
//
// Plan 071: the L1 kernel — a 1:1 port of the Python ego kinematics.
//
// The expected numbers below are **measured from the Python sim**
// (`app/apps/rl/sim_core.py`), not derived by hand. They are bit-exact
// values, so the assertions use `toBe` (not a tolerance): the whole
// point of the contract is that both sides execute the same
// floating-point operation sequence.

import { describe, it, expect } from 'vitest'
import { pythonSpeedStep, pythonSteer, integrateEgo } from './egoKernel'
import { PYTHON_SIM } from '@shared/constants/simulation'

describe('egoKernel — pythonSpeedStep', () => {
  it('matches the measured Python speed sequence bit-for-bit', () => {
    // Python (sim_core.py, cross scene, action[0] = 1.0):
    //   speed_k = 0.30000000000000004, 0.6000000000000001, 0.9000000000000001, ...
    const seen: number[] = []
    let s = 0
    for (let i = 0; i < 6; i++) {
      s = pythonSpeedStep(s, 1.0, PYTHON_SIM.DT)
      seen.push(s)
    }
    expect(seen).toEqual([
      0.30000000000000004, 0.6000000000000001, 0.9000000000000001, 1.2000000000000002,
      1.5000000000000002, 1.8000000000000003,
    ])
  })

  it('clips the action into [-1, 1] before scaling (Python clips, TS used not to)', () => {
    expect(pythonSpeedStep(0, 2.0, PYTHON_SIM.DT)).toBe(pythonSpeedStep(0, 1.0, PYTHON_SIM.DT))
    expect(pythonSpeedStep(0, -5.0, PYTHON_SIM.DT)).toBe(pythonSpeedStep(0, -1.0, PYTHON_SIM.DT))
  })

  it('never leaves [0, SPEED_LIMIT]', () => {
    expect(pythonSpeedStep(0, -1.0, PYTHON_SIM.DT)).toBe(0)
    expect(pythonSpeedStep(PYTHON_SIM.SPEED_LIMIT, 1.0, PYTHON_SIM.DT)).toBe(PYTHON_SIM.SPEED_LIMIT)
  })

  it('reproduces the measured Python trajectory over 58 steps', () => {
    // Python cross scene: ego starts at (0, -25) heading pi/2, target (0, 0).
    let ego = { x: 0, z: -25, heading: Math.PI / 2, speed: 0 }
    const target: readonly [number, number] = [0, 0]
    for (let i = 0; i < 58; i++) {
      ego = integrateEgo(ego, 1.0, PYTHON_SIM.DT, target)
    }
    expect(ego.speed).toBe(16.67)
    expect(ego.z).toBe(26.20100000000003)
    expect(ego.x).toBe(1.467525924532092e-14)
  })
})

describe('egoKernel — pythonSteer', () => {
  it('is exactly zero when the heading points at the target', () => {
    const ego = { x: 0, z: -25, heading: Math.PI / 2, speed: 0 }
    expect(pythonSteer(ego, [0, 0])).toBe(0)
  })

  it('clamps to MAX_STEER when the misalignment is large', () => {
    const ego = { x: 0, z: -25, heading: 0, speed: 0 } // target is due north
    expect(pythonSteer(ego, [0, 0])).toBe(-PYTHON_SIM.MAX_STEER)
  })

  it('never exceeds MAX_STEER in magnitude', () => {
    for (const heading of [0, 0.5, 1, 2, 3, 4, 5, 6]) {
      const steer = pythonSteer({ x: 3, z: -25, heading, speed: 0 }, [0, 0])
      expect(Math.abs(steer)).toBeLessThanOrEqual(PYTHON_SIM.MAX_STEER)
    }
  })
})
