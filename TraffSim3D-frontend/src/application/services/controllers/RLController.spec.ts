// src/application/services/controllers/RLController.spec.ts
//
// The RL controller is a real control surface.
//
// The contract is:
//   - `applyAction` is synchronous and only mutates the pending-action
//     queue — it never calls `decide()`.
//   - the next `decide()` consumes the queue.

import { describe, it, expect } from 'vitest'
import { RLController } from './RLController'
import { makeTestLight, buildTestNetwork } from '@__fixtures__/testNetwork'
import { LightPhase } from '@domain/value-objects/Phase'
import {
  ALL_RED_SECS,
  MAX_GREEN_SECS,
  MIN_GREEN_SECS,
  MIN_RED_SECS,
  PHASE_ADJUST_SECS,
} from '@shared/constants/simulation'
import { createSequenceActionSource } from '../signalController'

describe('RLController', () => {
  const net = buildTestNetwork()

  it('runs the plain cycle: green → yellow at phaseRemaining=0', () => {
    const c = new RLController()
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 0 })
    const d = c.decide(light, net, 0)
    expect(d.phase).toBe(LightPhase.Yellow)
    expect(d.duration).toBe(3)
  })

  it('stays in green while phaseRemaining > 0', () => {
    const c = new RLController()
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 10 })
    const d = c.decide(light, net, 0)
    expect(d.phase).toBe(LightPhase.Green)
    expect(d.duration).toBe(10)
  })

  it('runs the whole green → yellow → all-red → red → green cycle', () => {
    const c = new RLController()
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 0 })
    expect(c.decide(light, net, 0).phase).toBe(LightPhase.Yellow)
    light.phase = LightPhase.Yellow
    light.phaseRemaining = 0
    expect(c.decide(light, net, 0).phase).toBe(LightPhase.AllRed)
    light.phase = LightPhase.AllRed
    light.phaseRemaining = 0
    expect(c.decide(light, net, 0).phase).toBe(LightPhase.Red)
    light.phase = LightPhase.Red
    light.phaseRemaining = 0
    expect(c.decide(light, net, 0).phase).toBe(LightPhase.Green)
  })

  it('offers the whole vocabulary as its action space', () => {
    const c = new RLController()
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 30 })
    const d = c.decide(light, net, 0)
    expect(d.actions.map((a) => a.name)).toEqual([
      'extend_green',
      'shorten_red',
      'preempt',
      'force_all_red',
      'no_op',
    ])
    // A green light may be extended; it is not red, so it cannot be shortened.
    expect(d.actions.find((a) => a.name === 'extend_green')?.available).toBe(true)
    expect(d.actions.find((a) => a.name === 'shorten_red')?.available).toBe(false)
  })
})

describe('RLController — applyAction', () => {
  const net = buildTestNetwork()

  it('only queues: the light is untouched until the next decide()', () => {
    const c = new RLController()
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 30 })
    c.applyAction(light, 'extend_green')
    expect(light.phase).toBe(LightPhase.Green)
    expect(light.phaseRemaining).toBe(30)
    // The effect appears on the next decide().
    expect(c.decide(light, net, 0).duration).toBe(30 + PHASE_ADJUST_SECS)
  })

  it('never calls decide() itself', () => {
    // The action source is polled once per decide() — a poll counter is a
    // direct witness that applyAction did not decide.
    let polls = 0
    const c = new RLController({
      actionSource: {
        nextAction: () => {
          polls += 1
          return null
        },
      },
    })
    const light = makeTestLight()
    c.applyAction(light, 'no_op')
    expect(polls).toBe(0)
    c.decide(light, net, 0)
    expect(polls).toBe(1)
  })

  it('consumes the queue exactly once', () => {
    const c = new RLController()
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 30 })
    c.applyAction(light, 'extend_green')
    expect(c.decide(light, net, 0).duration).toBe(35)
    // The second decide() has nothing left to consume.
    expect(c.decide(light, net, 0.1).duration).toBe(30)
  })
})

describe('RLController — the five actions', () => {
  const net = buildTestNetwork()

  it('extend_green grows the current light’s remaining time by 5 s', () => {
    const c = new RLController()
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 30 })
    c.applyAction(light, 'extend_green')
    const d = c.decide(light, net, 0)
    expect(d.phase).toBe(LightPhase.Green)
    expect(d.duration).toBe(30 + PHASE_ADJUST_SECS)
  })

  it('shorten_red shrinks the current light’s remaining time by 5 s', () => {
    const c = new RLController()
    const light = makeTestLight({ phase: LightPhase.Red, phaseRemaining: 30 })
    c.applyAction(light, 'shorten_red')
    const d = c.decide(light, net, 0)
    expect(d.phase).toBe(LightPhase.Red)
    expect(d.duration).toBe(30 - PHASE_ADJUST_SECS)
  })

  it('shorten_red never drops below the minimum-red floor', () => {
    const c = new RLController()
    const light = makeTestLight({ phase: LightPhase.Red, phaseRemaining: MIN_RED_SECS + 2 })
    c.applyAction(light, 'shorten_red')
    expect(c.decide(light, net, 0).duration).toBe(MIN_RED_SECS)
  })

  it('shorten_red never drops a green below the minimum-green floor', () => {
    // The symmetric counterpart of the red floor — "a red
    // is never shorter than MIN_RED_SECS, a green is never shorter than
    // MIN_GREEN_SECS". Without it a controller that shortens on every
    // decision flickers the light (0.6 s per phase), which no driver can
    // react to.
    const c = new RLController()
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: MIN_GREEN_SECS + 2 })
    c.applyAction(light, 'shorten_red')
    expect(c.decide(light, net, 0).duration).toBe(MIN_GREEN_SECS)
  })

  it('shorten_red still shrinks a green while there is room', () => {
    const c = new RLController()
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 30 })
    c.applyAction(light, 'shorten_red')
    expect(c.decide(light, net, 0).duration).toBe(30 - PHASE_ADJUST_SECS)
  })

  it('shorten_red on a yellow light has no floor', () => {
    // The clearance phases are not service intervals: the yellow must
    // keep its zero floor (it has to expire), and the all-red clearance
    // is not shortened at all.
    const c = new RLController()
    const light = makeTestLight({ phase: LightPhase.Yellow, phaseRemaining: 3 })
    c.applyAction(light, 'shorten_red')
    expect(c.decide(light, net, 0).duration).toBe(0)
  })

  it('preempt holds the light AllRed for 3 s, then the phase resumes', () => {
    const c = new RLController()
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 30 })
    c.applyAction(light, 'preempt')
    const d = c.decide(light, net, 0)
    expect(d.phase).toBe(LightPhase.AllRed)
    expect(d.duration).toBe(ALL_RED_SECS)
    // Still clearing one second later ...
    const clearing = c.decide(light, net, 1)
    expect(clearing.phase).toBe(LightPhase.AllRed)
    expect(clearing.duration).toBe(ALL_RED_SECS - 1)
    // ... and the interrupted phase resumes when the clearance is over.
    const resumed = c.decide(light, net, ALL_RED_SECS)
    expect(resumed.phase).toBe(LightPhase.Green)
    expect(resumed.duration).toBe(30)
  })

  it('force_all_red behaves like preempt', () => {
    const c = new RLController()
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 30 })
    c.applyAction(light, 'force_all_red')
    const d = c.decide(light, net, 0)
    expect(d.phase).toBe(LightPhase.AllRed)
    expect(d.duration).toBe(ALL_RED_SECS)
  })

  it('no_op changes nothing', () => {
    const c = new RLController()
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 30 })
    c.applyAction(light, 'no_op')
    const d = c.decide(light, net, 0)
    expect(d.phase).toBe(LightPhase.Green)
    expect(d.duration).toBe(30)
  })

  it('extend_green never exceeds the max-green bound', () => {
    // The bound is the project's existing `MAX_GREEN_SECS` convention (the
    // `ActuatedController` caps the green the same way). It is part of the
    // cross-language contract: the Python training sim uses the same one.
    const c = new RLController()
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 30 })
    let duration = 30
    for (let i = 0; i < 20; i++) {
      c.applyAction(light, 'extend_green')
      const d = c.decide(light, net, 0)
      duration = d.duration
      // `tick.ts` writes the decision back to the light.
      light.phaseRemaining = d.duration
    }
    expect(duration).toBe(MAX_GREEN_SECS)
  })
})

describe('RLController — the all-red resume point', () => {
  const net = buildTestNetwork()

  /**
   * Decide and write the decision back to the light, the way `tick.ts` does.
   * Without this the light entity keeps its pre-decision state and the
   * controller's view of the clearance diverges from the world's.
   */
  const apply = (c: RLController, light: ReturnType<typeof makeTestLight>, simTime: number) => {
    const d = c.decide(light, net, simTime)
    light.phase = d.phase
    light.phaseRemaining = d.duration
    return d
  }

  it('a preempt on the boundary step does not kill the light', () => {
    // Regression (the clearance fix wave). The clearance that ends
    // resumes BEFORE the queued actions are applied. Without that order a
    // preempt landing on the boundary step recorded the *all-red* state as
    // the resume point, and the light was then stuck AllRed forever — it
    // resumed into "no phase to resume" on every later step.
    const c = new RLController()
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 12 })
    c.applyAction(light, 'preempt')
    expect(apply(c, light, 0).phase).toBe(LightPhase.AllRed)

    // The clearance ends at t = ALL_RED_SECS. A preempt on that very step
    // must not lose the resume point.
    c.applyAction(light, 'preempt')
    expect(apply(c, light, ALL_RED_SECS).phase).toBe(LightPhase.AllRed)

    // When the second clearance ends, the interrupted phase resumes with
    // the 12 s it had left — not a fresh 30 s, and not AllRed.
    const resumed = apply(c, light, 2 * ALL_RED_SECS)
    expect(resumed.phase).toBe(LightPhase.Green)
    expect(resumed.duration).toBe(12)
  })

  it('a preempt during a clearance keeps the original resume point', () => {
    // The case that already worked before the fix wave — pinned so the
    // boundary fix does not regress it.
    const c = new RLController()
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 12 })
    c.applyAction(light, 'preempt')
    apply(c, light, 0)
    // A second preempt one second into the clearance extends it; the resume
    // point must stay (Green, 12).
    c.applyAction(light, 'preempt')
    apply(c, light, 1)
    const resumed = apply(c, light, 1 + ALL_RED_SECS)
    expect(resumed.phase).toBe(LightPhase.Green)
    expect(resumed.duration).toBe(12)
  })
})

describe('RLController — the action-source seam', () => {
  const net = buildTestNetwork()

  it('consumes the injected action sequence', () => {
    // Sprint 3 swaps this source for the trained policy's — one line, and
    // the controller does not change.
    const c = new RLController({
      actionSource: createSequenceActionSource(['extend_green', 'no_op']),
    })
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 30 })
    expect(c.decide(light, net, 0).duration).toBe(35)
    expect(c.decide(light, net, 0.1).duration).toBe(30)
    // The sequence is exhausted → the controller keeps its plain cycle.
    expect(c.decide(light, net, 0.2).duration).toBe(30)
  })

  it('works with no source at all — the applyAction path alone', () => {
    const c = new RLController()
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 30 })
    expect(c.decide(light, net, 0).duration).toBe(30)
  })
})
