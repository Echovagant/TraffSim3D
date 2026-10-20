// src/application/services/simCoreMirror.spec.ts
//
// Plan 071: the L3 contract mirror — a 1:1 port of the Python training
// sim (`app/apps/rl/sim_core.py`).
//
// The expected values are measured from the Python side. Exact equality,
// not tolerance: the contract's whole value is catching drift.

import { describe, it, expect } from 'vitest'
import { SimCoreMirror, runEpisode } from './simCoreMirror'
import { PYTHON_SIM } from '@shared/constants/simulation'

describe('simCoreMirror — cross scene', () => {
  it('reproduces the measured Python cross trajectory', () => {
    const ep = runEpisode('cross', new Array(100).fill(1.0), 10)
    expect(ep.terminated).toBe(true)
    expect(ep.reason).toBe('success')
    expect(ep.finalStep).toBe(58)
    expect(ep.finalZ).toBe(26.20100000000003)
    expect(ep.finalX).toBe(1.467525924532092e-14)
    expect(ep.finalSpeed).toBe(16.67)
  })

  it('reproduces the measured Python corridor trajectory', () => {
    const ep = runEpisode('corridor', new Array(150).fill(1.0), 10)
    expect(ep.terminated).toBe(true)
    expect(ep.reason).toBe('success_corridor')
    expect(ep.finalStep).toBe(58)
    expect(ep.finalZ).toBe(26.20100000000003)
  })

  it('samples at the same steps as the Python snapshot generator', () => {
    const ep = runEpisode('cross', new Array(100).fill(1.0), 10)
    // Python samples step 0, then every 10th step, plus the last action
    // index. The episode terminates at step 58, and 58 is neither a
    // multiple of 10 nor the last action index — so it is NOT sampled.
    // Measured on the Python side: [0, 10, 20, 30, 40, 50].
    expect(ep.samples.map((s) => s.step)).toEqual([0, 10, 20, 30, 40, 50])
    expect(ep.samples[0]).toEqual({
      step: 0,
      x: 0,
      z: -25,
      heading: Math.PI / 2,
      speed: 0,
      light: { nsGreen: true, ewGreen: false },
    })
  })
})

describe('simCoreMirror — traffic-light phase', () => {
  it('records the light bits in every sample', () => {
    const ep = runEpisode('cross', new Array(100).fill(1.0), 10)
    expect(ep.samples[0]?.light).toEqual({ nsGreen: true, ewGreen: false })
  })

  it('makes the phase observable — the samples follow the light cycle', () => {
    // A 1 s cycle flips the phase every 10 steps at 10 Hz. The flip lands
    // on step 11: the accumulated timer is 0.9999999999999999 after ten
    // `+= 0.1`, so it only reaches 1.0 on the eleventh step — and the next
    // flip likewise on step 22. Python accumulates the same bits, which is
    // what the contract compares.
    const core = new SimCoreMirror('cross', 40)
    core.reset()
    core.light.cycleDuration = 1.0
    const nsGreenPerStep: boolean[] = []
    for (let i = 0; i < 25; i++) {
      core.step(0)
      nsGreenPerStep.push(core.light.nsGreen)
    }
    expect(nsGreenPerStep.slice(0, 10).every((v) => v)).toBe(true)
    expect(nsGreenPerStep.slice(10, 21).every((v) => !v)).toBe(true)
    expect(nsGreenPerStep.slice(21).every((v) => v)).toBe(true)
  })
})

describe('simCoreMirror — episode limits', () => {
  it('truncates at the given maxSteps', () => {
    const ep = runEpisode('roundabout', new Array(400).fill(0), 10, 400)
    expect(ep.terminated).toBe(false)
    expect(ep.truncated).toBe(true)
    expect(ep.reason).toBe('')
    expect(ep.finalStep).toBe(400)
    expect(ep.samples).toHaveLength(41)
    expect(ep.samples[ep.samples.length - 1]?.step).toBe(400)
  })

  it('falls back to the Python default step limit', () => {
    const ep = runEpisode('roundabout', new Array(400).fill(0), 10)
    expect(ep.truncated).toBe(true)
    expect(ep.finalStep).toBe(PYTHON_SIM.MAX_STEPS_DEFAULT)
  })

  it('reports a collision when an NPC reaches the ego', () => {
    // How the `t_junction_lights` contract vector ends: the parked ego at
    // (0, -25) is reached by the northbound NPC after its respawn, well
    // before the step limit.
    const ep = runEpisode('t_junction', new Array(400).fill(0), 10, 400)
    expect(ep.terminated).toBe(true)
    expect(ep.truncated).toBe(false)
    expect(ep.reason).toBe('collision')
    expect(ep.finalStep).toBeLessThan(400)
  })
})

describe('simCoreMirror — termination rules', () => {
  it('truncates and freezes once maxSteps is reached (Plan 067 latch)', () => {
    const core = new SimCoreMirror('cross', 5)
    core.reset()
    for (let i = 0; i < 5; i++) core.step(1.0)
    expect(core.truncated).toBe(true)
    expect(core.terminated).toBe(false)
    const z = core.ego.z
    core.step(1.0)
    expect(core.ego.z).toBe(z)
  })

  it('reports red_light when the ego enters the intersection against a red', () => {
    const core = new SimCoreMirror('cross')
    core.reset()
    core.light.nsGreen = false
    core.light.ewGreen = true
    // Drive north into the intersection with the NS axis red.
    for (let i = 0; i < 200 && !core.terminated; i++) core.step(1.0)
    expect(core.terminated).toBe(true)
    expect(core.terminatedReason).toBe('red_light')
  })
})

describe('simCoreMirror — observation', () => {
  it('reproduces the measured Python t_junction trajectory', () => {
    const ep = runEpisode('t_junction', new Array(100).fill(1.0), 10)
    expect(ep.terminated).toBe(true)
    expect(ep.reason).toBe('success_t_junction')
    expect(ep.finalStep).toBe(38)
    expect(ep.finalZ).toBe(-2.769999999999997)
  })

  it('reproduces the measured Python roundabout trajectory', () => {
    const ep = runEpisode('roundabout', new Array(100).fill(1.0), 10)
    expect(ep.terminated).toBe(true)
    expect(ep.reason).toBe('success_roundabout')
    expect(ep.finalStep).toBe(45)
    expect(ep.finalZ).toBe(6.05000000000001)
  })

  it('gives the roundabout a both-green light, like Python (no signals there)', () => {
    const core = new SimCoreMirror('roundabout')
    core.reset()
    expect(core.light.nsGreen).toBe(true)
    expect(core.light.ewGreen).toBe(true)
    // The swap of (true, true) is a no-op, so the light never changes.
    for (let i = 0; i < 400; i++) core.step(1.0)
    expect(core.light.nsGreen).toBe(true)
    expect(core.light.ewGreen).toBe(true)
  })

  it('produces a 14-dim one-hot light pair like Python', () => {
    const core = new SimCoreMirror('cross')
    core.reset()
    const obs = core.obs()
    expect(obs).toHaveLength(14)
    // One-hot for the signalised scenes; the roundabout is (1, 1) in Python.
    expect(obs[6] + obs[7]).toBe(1)
    const roundabout = new SimCoreMirror('roundabout')
    roundabout.reset()
    expect(roundabout.obs()[6]).toBe(1)
    expect(roundabout.obs()[7]).toBe(1)
    expect(obs[0]).toBe(0)
    expect(obs[1]).toBe(-0.5) // -25 / 50
    expect(obs[2]).toBe(Math.PI / 2 / Math.PI)
    expect(obs[3]).toBe(0)
  })
})
