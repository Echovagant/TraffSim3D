// src/application/services/simCoreMirror.spec.ts
//
// Plan 071: the L3 contract mirror — a 1:1 port of the Python training
// sim (`app/apps/rl/sim_core.py`).
//
// The expected values are measured from the Python side. Exact equality,
// not tolerance: the contract's whole value is catching drift.

import { describe, it, expect } from 'vitest'
import { SimCoreMirror, runEpisode, type MirrorEpisode } from './simCoreMirror'
import { PYTHON_SIM, MAX_GREEN_SECS, type SignalActionName } from '@shared/constants/simulation'

describe('simCoreMirror — cross scene', () => {
  it('reproduces the measured Python cross trajectory', () => {
    const ep = runEpisode('cross', new Array(100).fill(1.0), 10)
    expect(ep.terminated).toBe(true)
    expect(ep.reason).toBe('success')
    expect(ep.finalStep).toBe(58)
    expect(ep.finalZ).toBe(26.20100000000003)
    expect(ep.finalX).toBe(-8.404945169006555e-15)
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

// Plan 073 Sprint 2 (A2a): the mirror carries the same five signal actions
// as the Python light. These are the TS-side pins of the *semantics*; the
// *vocabulary* is cross-language and asserted by the Python contract test.
describe('simCoreMirror — signal actions', () => {
  /**
   * Run a long episode and report the 1-based steps at which the light
   * changes.
   *
   * The roundabout is used because it is the only scene whose episode
   * survives past the first 30 s flip (a parked ego is hit by an NPC in
   * every signalled scene). Its light is overridden to a plain NS-green
   * light, because the roundabout's own light is both-green — "no traffic
   * lights there" — and its swap would be a no-op.
   */
  const lightChanges = (action?: SignalActionName): number[] => {
    const core = new SimCoreMirror('roundabout', 500)
    core.reset()
    core.light.nsGreen = true
    core.light.ewGreen = false
    if (action !== undefined) core.applySignalAction(action)
    const bits: boolean[] = []
    for (let i = 0; i < 400; i++) {
      core.step(0)
      bits.push(core.light.nsGreen)
    }
    const changes: number[] = []
    for (let i = 1; i < bits.length; i++) {
      if (bits[i] !== bits[i - 1]) changes.push(i + 1)
    }
    return changes
  }

  it('queues an action without changing the light', () => {
    const core = new SimCoreMirror('cross')
    core.reset()
    core.applySignalAction('preempt')
    expect(core.light.nsGreen).toBe(true)
    expect(core.light.ewGreen).toBe(false)
    expect(core.light.pendingActions).toEqual(['preempt'])
  })

  it('rejects an unknown action name', () => {
    const core = new SimCoreMirror('cross')
    core.reset()
    expect(() => core.applySignalAction('go_faster' as SignalActionName)).toThrow()
  })

  it('keeps the default cycle: the swap lands on step 300', () => {
    expect(lightChanges()).toEqual([300])
  })

  it('extend_green delays the swap by 5 s (50 steps)', () => {
    expect(lightChanges('extend_green')).toEqual([350])
  })

  it('shorten_red advances the swap by 5 s (50 steps)', () => {
    expect(lightChanges('shorten_red')).toEqual([250])
  })

  it('preempt clears both axes for 3 s, then the phase resumes', () => {
    const core = new SimCoreMirror('roundabout', 500)
    core.reset()
    core.light.nsGreen = true
    core.light.ewGreen = false
    core.applySignalAction('preempt')
    const bits: Array<[boolean, boolean]> = []
    for (let i = 0; i < 400; i++) {
      core.step(0)
      bits.push([core.light.nsGreen, core.light.ewGreen])
    }
    const allRed = bits.filter((b) => b[0] === false && b[1] === false)
    expect(allRed).toHaveLength(30)
    expect(bits[0]).toEqual([false, false])
    expect(bits[29]).toEqual([false, false])
    // The interrupted phase resumes on the next step ...
    expect(bits[30]).toEqual([true, false])
    // ... and the swap happens 30 steps later: the phase clock was frozen
    // during the clearance. (`bits[i]` is the state *after* step i+1, so the
    // swap observed at step 330 is `bits[329]`.)
    expect(bits[328]).toEqual([true, false])
    expect(bits[329]).toEqual([false, true])
  })

  it('force_all_red behaves like preempt', () => {
    expect(lightChanges('force_all_red')).toEqual(lightChanges('preempt'))
  })

  it('no_op changes nothing', () => {
    expect(lightChanges('no_op')).toEqual(lightChanges())
  })

  /**
   * Run an episode, applying an action on the given **1-based** steps, and
   * record the light bits after every step (`bits[i]` is the state after
   * step `i + 1`).
   */
  const bitsWithActions = (
    atSteps: Record<number, SignalActionName>,
    steps = 400,
  ): Array<[boolean, boolean]> => {
    const core = new SimCoreMirror('roundabout', 500)
    core.reset()
    core.light.nsGreen = true
    core.light.ewGreen = false
    const bits: Array<[boolean, boolean]> = []
    for (let step = 1; step <= steps; step++) {
      const action = atSteps[step]
      if (action !== undefined) core.applySignalAction(action)
      core.step(0)
      bits.push([core.light.nsGreen, core.light.ewGreen])
    }
    return bits
  }

  it('a preempt right after a clearance does not kill the light', () => {
    // Regression (Plan 073 Sprint 2 fix wave). The clearance that ends
    // resumes BEFORE the queued actions are consumed. Without that order a
    // preempt landing on the boundary step recorded the all-red state as
    // the resume point, and the light never went green again.
    const bits = bitsWithActions({ 1: 'preempt', 31: 'preempt' })
    // The first clearance: steps 1..30.
    expect(bits[0]).toEqual([false, false])
    expect(bits[29]).toEqual([false, false])
    // The second clearance starts on the very step the phase resumed.
    expect(bits[30]).toEqual([false, false])
    expect(bits[59]).toEqual([false, false])
    // ... and the phase must come back.
    expect(bits[60]).toEqual([true, false])
  })

  it('a preempt during a clearance keeps the original resume point', () => {
    // The case that already worked before the fix wave — pinned so the
    // boundary fix does not regress it.
    const bits = bitsWithActions({ 1: 'preempt', 20: 'preempt' })
    expect(bits[48]).toEqual([false, false]) // step 49 — still clearing
    expect(bits[49]).toEqual([true, false]) // step 50 — the phase resumes
  })

  it('extend_green never exceeds the max-green bound', () => {
    // The bound is the project's existing `MAX_GREEN_SECS` convention, and
    // the Python training sim uses the same one (the contract compares the
    // constant).
    const core = new SimCoreMirror('roundabout', 500)
    core.reset()
    const floor = core.light.cycleDuration - MAX_GREEN_SECS
    for (let i = 0; i < 40; i++) {
      core.applySignalAction('extend_green')
      core.step(0)
      expect(core.light.cycleTimer).toBeGreaterThanOrEqual(floor)
    }
  })
})

// Plan 074 (T3): the mirror can run the contract vectors' two optional
// extras — the light override and the scheduled signal actions.
describe('simCoreMirror — contract vector options (Plan 074)', () => {
  const lightAt = (ep: MirrorEpisode): Map<number, { nsGreen: boolean; ewGreen: boolean }> =>
    new Map(ep.samples.map((s) => [s.step, s.light]))

  it('runs the default cycle over the overridden light', () => {
    // The roundabout's own light is both-green; the override gives it the
    // plain NS-green light the Python side installs.
    const ep = runEpisode('roundabout', new Array(400).fill(0), 10, 400, {
      lightOverride: { nsGreen: true, ewGreen: false },
    })
    const lights = lightAt(ep)
    expect(lights.get(0)).toEqual({ nsGreen: true, ewGreen: false })
    expect(lights.get(300)).toEqual({ nsGreen: false, ewGreen: true })
  })

  it('applies a scheduled action before the step it is labelled with', () => {
    // The step convention: `"step": 10` is applied BEFORE the 10th step, so
    // the 10th step is the one that consumes it.
    const ep = runEpisode('roundabout', new Array(400).fill(0), 10, 400, {
      lightOverride: { nsGreen: true, ewGreen: false },
      signalActions: [{ step: 10, action: 'preempt' }],
    })
    const lights = lightAt(ep)
    expect(lights.get(0)).toEqual({ nsGreen: true, ewGreen: false })
    // The clearance runs on steps 10..39 ...
    expect(lights.get(10)).toEqual({ nsGreen: false, ewGreen: false })
    expect(lights.get(30)).toEqual({ nsGreen: false, ewGreen: false })
    // ... and the phase resumes inside step 40.
    expect(lights.get(40)).toEqual({ nsGreen: true, ewGreen: false })
  })

  it('keeps the light alive across the clearance boundary', () => {
    // A second preempt on the very step the phase resumed (step 40) must
    // not wedge the light — the Plan 073 Sprint 2 regression.
    const ep = runEpisode('roundabout', new Array(400).fill(0), 10, 400, {
      lightOverride: { nsGreen: true, ewGreen: false },
      signalActions: [
        { step: 10, action: 'preempt' },
        { step: 40, action: 'preempt' },
      ],
    })
    const lights = lightAt(ep)
    expect(lights.get(60)).toEqual({ nsGreen: false, ewGreen: false })
    expect(lights.get(70)).toEqual({ nsGreen: true, ewGreen: false })
  })

  it('rejects a malformed scheduled action', () => {
    expect(() =>
      runEpisode('roundabout', new Array(10).fill(0), 10, 400, {
        signalActions: [{ step: 0, action: 'preempt' }],
      }),
    ).toThrow(/positive integer/)
    expect(() =>
      runEpisode('roundabout', new Array(10).fill(0), 10, 400, {
        signalActions: [{ step: 1, action: 'go_faster' as SignalActionName }],
      }),
    ).toThrow(/unknown signal action/)
  })
})

// Plan 076 S5a: the mirror can start the ego somewhere else.
//
// Every contract vector used to be a straight-line scenario, so Pure
// Pursuit's angle was ~0, `steer` was 0, and the three turning constants
// (`LOOKAHEAD_DISTANCE`, `MAX_STEER`, `EGO_WHEELBASE`) were blind spots: a
// change to any of them left every golden untouched. A vector that starts
// the ego off its target line makes the steer non-zero, so they become
// observable.
//
// The Python side applies the same override to `core.ego` right after
// `reset()` — see `tests/contract/test_cross_lang_consistency.py`.
describe('simCoreMirror — the ego start override (Plan 076 S5a)', () => {
  const lateral = { x: 60, z: -25, heading: Math.PI / 2, speed: 0 }
  const headingOffset = { x: 0, z: -25, heading: Math.PI / 2 + 2.0, speed: 0 }

  it('starts the ego at the overridden pose', () => {
    const ep = runEpisode('roundabout', new Array(60).fill(0.2), 10, 60, {
      lightOverride: { nsGreen: true, ewGreen: false },
      egoStart: lateral,
    })
    expect(ep.samples[0]).toEqual({
      step: 0,
      x: 60,
      z: -25,
      heading: Math.PI / 2,
      speed: 0,
      light: { nsGreen: true, ewGreen: false },
    })
  })

  it('changes the trajectory — the override is not a no-op', () => {
    const withOverride = runEpisode('roundabout', new Array(60).fill(0.2), 10, 60, {
      lightOverride: { nsGreen: true, ewGreen: false },
      egoStart: lateral,
    })
    const without = runEpisode('roundabout', new Array(60).fill(0.2), 10, 60, {
      lightOverride: { nsGreen: true, ewGreen: false },
    })
    expect(withOverride.samples).not.toEqual(without.samples)
  })

  it('makes the ego turn — the heading changes, so the steer is not zero', () => {
    const ep = runEpisode('roundabout', new Array(60).fill(0.2), 10, 60, {
      lightOverride: { nsGreen: true, ewGreen: false },
      egoStart: headingOffset,
    })
    const headings = ep.samples.map((s) => s.heading)
    expect(headings[0]).not.toBe(headings[headings.length - 1])
    // The turn is material, not a last-bit wobble: the Pure Pursuit angle
    // is non-zero from the first step on.
    //
    // The **span** is the right measure, not the first-to-last difference:
    // the ego *converges* on its target (it overshoots and swings back),
    // so the heading can end up near where it started even though the
    // vehicle turned hard in between. The span must also sit far above the
    // libm noise floor (1e-9 rad) that the contract's comparison allows.
    const span = Math.max(...headings) - Math.min(...headings)
    expect(span).toBeGreaterThan(0.1)
  })

  it('reproduces the measured Python steering trajectories', () => {
    // Measured from the Python side (the committed goldens carry the same
    // numbers); exact equality, like the rest of the contract.
    const lateralEp = runEpisode('roundabout', new Array(60).fill(0.2), 10, 60, {
      lightOverride: { nsGreen: true, ewGreen: false },
      egoStart: lateral,
    })
    expect(lateralEp.truncated).toBe(true)
    expect(lateralEp.finalStep).toBe(60)
    expect(lateralEp.finalX).toBe(51.48737247857822)
    expect(lateralEp.finalZ).toBe(-18.31828005457018)

    const headingEp = runEpisode('roundabout', new Array(60).fill(0.2), 10, 60, {
      lightOverride: { nsGreen: true, ewGreen: false },
      egoStart: headingOffset,
    })
    expect(headingEp.truncated).toBe(true)
    expect(headingEp.finalStep).toBe(60)
    expect(headingEp.finalX).toBe(-4.620250835521059)
    expect(headingEp.finalZ).toBe(-16.27592974962582)
  })
})
