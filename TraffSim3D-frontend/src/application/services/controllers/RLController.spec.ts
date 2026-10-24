// src/application/services/controllers/RLController.spec.ts
//
// The RL controller's five actions, applied to the **junction**.
//
// The semantics are the Python training sim's
// (`app/apps/rl/sim_core.py` → `class TrafficLight` → `apply_action`,
// driven by `app/apps/rl/signal_env.py`):
//
//   extend_green          the junction's current green axis grows by 5 s
//                         (never past MAX_GREEN_SECS)
//   shorten_red           the opposite axis is served 5 s earlier — its
//                         red shrinks by 5 s (never below MIN_RED_SECS)
//   preempt /
//   force_all_red         the whole junction holds all-red for 3 s, then
//                         resumes the interrupted phase with the time it
//                         had left
//   no_op                 nothing
//
// The contract on top of that:
//   - `applyAction` is synchronous and only mutates the pending-action
//     queue — it never calls `decide()`.
//   - the next `decide()` consumes the queue.

import { describe, it, expect } from 'vitest'
import { RLController } from './RLController'
import { buildTestNetwork } from '@__fixtures__/testNetwork'
import { LightPhase } from '@domain/value-objects/Phase'
import type { Intersection } from '@domain/entities/Intersection'
import type { TrafficLight } from '@domain/entities/TrafficLight'
import {
  ALL_RED_SECS,
  MAX_GREEN_SECS,
  MIN_RED_SECS,
  PHASE_ADJUST_SECS,
} from '@shared/constants/simulation'
import { createSequenceActionSource } from '../signalController'

const makeLight = (axis: 'ns' | 'ew', phase: LightPhase, remaining: number): TrafficLight => ({
  id: `tl-${axis}`,
  position: { x: 0, y: 0, z: 0 },
  phase,
  phaseRemaining: remaining,
  cycleSeconds: 72,
  axis,
})

const makeJunction = (nsRemaining = 30): Intersection => ({
  id: 'i-1',
  position: { x: 0, y: 0, z: 0 },
  connectedRoads: ['r-ns', 'r-ew'],
  trafficLights: [
    makeLight('ns', LightPhase.Green, nsRemaining),
    makeLight('ew', LightPhase.Red, 36),
  ],
  intersectionRadius: 8,
})

describe('RLController — the junction runs the plain cycle', () => {
  it('runs green → yellow → all-red → green on the other axis', () => {
    const net = buildTestNetwork()
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new RLController()

    expect(c.decide(junction, net, 0, 0).phase).toBe(LightPhase.Green)
    expect(c.decide(junction, net, 0, 30).phase).toBe(LightPhase.Yellow)
    expect(c.decide(junction, net, 0, 3).phase).toBe(LightPhase.AllRed)
    const other = c.decide(junction, net, 0, 3)
    expect(other.phase).toBe(LightPhase.Green)
    expect(other.axis).toBe('ew')
  })

  it('offers the whole vocabulary as its action space', () => {
    const net = buildTestNetwork()
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new RLController()

    const d = c.decide(junction, net, 0, 0)
    expect(d.actions.map((a) => a.name)).toEqual([
      'extend_green',
      'shorten_red',
      'preempt',
      'force_all_red',
      'no_op',
    ])
    // The junction is serving an axis: the green may be extended and the
    // opposite axis' red may be shortened.
    expect(d.actions.find((a) => a.name === 'extend_green')?.available).toBe(true)
    expect(d.actions.find((a) => a.name === 'shorten_red')?.available).toBe(true)
  })
})

describe('RLController — applyAction', () => {
  it('only queues: the plan is untouched until the next decide()', () => {
    const net = buildTestNetwork()
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new RLController()

    c.applyAction(junction, 'extend_green')
    // The effect appears on the next decide().
    expect(c.decide(junction, net, 0, 0).duration).toBe(30 + PHASE_ADJUST_SECS)
  })

  it('never calls decide() itself', () => {
    const net = buildTestNetwork()
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    // A poll counter is a direct witness that applyAction did not decide.
    let polls = 0
    const c = new RLController({
      actionSource: {
        nextAction: () => {
          polls += 1
          return null
        },
      },
    })

    c.applyAction(junction, 'no_op')
    expect(polls).toBe(0)
    c.decide(junction, net, 0, 0)
    expect(polls).toBe(1)
  })

  it('consumes the queue exactly once', () => {
    const net = buildTestNetwork()
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new RLController()

    c.applyAction(junction, 'extend_green')
    expect(c.decide(junction, net, 0, 0).duration).toBe(35)
    // The second decide() has nothing left to consume: the extension
    // holds (the junction's plan keeps the time it was given) and is
    // **not** applied a second time.
    expect(c.decide(junction, net, 0.1, 0).duration).toBe(35)
  })
})

describe('RLController — the five actions on the junction', () => {
  const net = buildTestNetwork()

  it('extend_green grows the junction’s green by 5 s', () => {
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new RLController()

    c.applyAction(junction, 'extend_green')
    const d = c.decide(junction, net, 0, 0)
    expect(d.phase).toBe(LightPhase.Green)
    expect(d.duration).toBe(30 + PHASE_ADJUST_SECS)
  })

  it('extend_green never exceeds the max-green bound', () => {
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new RLController()

    let duration = 30
    for (let i = 0; i < 20; i++) {
      c.applyAction(junction, 'extend_green')
      const d = c.decide(junction, net, 0, 0)
      duration = d.duration
    }
    expect(duration).toBe(MAX_GREEN_SECS)
  })

  it('shorten_red hands the junction over 5 s earlier', () => {
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new RLController()

    c.applyAction(junction, 'shorten_red')
    const d = c.decide(junction, net, 0, 0)
    expect(d.phase).toBe(LightPhase.Green)
    expect(d.duration).toBe(30 - PHASE_ADJUST_SECS)
    // The opposite axis' red (its wait) shrinks by the same 5 s.
    expect(d.views?.ew.remaining).toBe(30 - PHASE_ADJUST_SECS + 3 + 3)
  })

  it('shorten_red never drops below the minimum-red floor', () => {
    // The floor is **refused**, not clamped: the Python's environment
    // masks the action when it would push the green below the floor,
    // and the light is not touched at all.
    const junction = makeJunction(MIN_RED_SECS + PHASE_ADJUST_SECS)
    net.intersections['i-1'] = junction
    const c = new RLController()

    c.applyAction(junction, 'shorten_red')
    expect(c.decide(junction, net, 0, 0).duration).toBe(MIN_RED_SECS)
  })

  it('shorten_red is refused when it would break the floor', () => {
    const junction = makeJunction(MIN_RED_SECS + 2)
    net.intersections['i-1'] = junction
    const c = new RLController()

    c.applyAction(junction, 'shorten_red')
    expect(c.decide(junction, net, 0, 0).duration).toBe(MIN_RED_SECS + 2)
  })

  it('a green shortened on every tick still runs out', () => {
    // The clamp would pin the countdown: the remaining time would be
    // topped back up to the floor on every tick and the green would
    // never end. The Python's mask refuses the action instead, so the
    // green runs its course.
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new RLController()

    let plan = c.decide(junction, net, 0, 0)
    for (let second = 0; second < 60 && plan.phase === LightPhase.Green; second += 1) {
      c.applyAction(junction, 'shorten_red')
      plan = c.decide(junction, net, second, 1)
    }
    expect(plan.phase).not.toBe(LightPhase.Green)
  })

  it('a green extended on every tick still runs out', () => {
    // The same for the extension: the bound is on the green's duration,
    // so the remaining time cannot be topped back up past the budget.
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new RLController()

    let plan = c.decide(junction, net, 0, 0)
    for (let second = 0; second < 120 && plan.phase === LightPhase.Green; second += 1) {
      c.applyAction(junction, 'extend_green')
      plan = c.decide(junction, net, second, 1)
    }
    expect(plan.phase).not.toBe(LightPhase.Green)
  })

  it('no_op changes nothing', () => {
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new RLController()

    c.applyAction(junction, 'no_op')
    const d = c.decide(junction, net, 0, 0)
    expect(d.phase).toBe(LightPhase.Green)
    expect(d.duration).toBe(30)
  })

  it('preempt holds the whole junction all-red for 3 s, then it resumes', () => {
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new RLController()

    c.applyAction(junction, 'preempt')
    const d = c.decide(junction, net, 0, 0)
    expect(d.phase).toBe(LightPhase.AllRed)
    expect(d.duration).toBe(ALL_RED_SECS)
    // Neither axis has the right of way while the junction is held.
    expect(d.views?.ns.phase).toBe(LightPhase.AllRed)
    expect(d.views?.ew.phase).toBe(LightPhase.Red)

    // Still clearing one second later ...
    const clearing = c.decide(junction, net, 1, 0)
    expect(clearing.phase).toBe(LightPhase.AllRed)
    expect(clearing.duration).toBe(ALL_RED_SECS - 1)

    // ... and the interrupted phase resumes when the clearance is over.
    const resumed = c.decide(junction, net, ALL_RED_SECS, 0)
    expect(resumed.phase).toBe(LightPhase.Green)
    expect(resumed.duration).toBe(30)
  })

  it('preempt resumes the interrupted phase with the time it had left', () => {
    const junction = makeJunction(12)
    net.intersections['i-1'] = junction
    const c = new RLController()

    c.applyAction(junction, 'preempt')
    expect(c.decide(junction, net, 0, 0).phase).toBe(LightPhase.AllRed)
    // The green comes back with the 12 s it had left — not a fresh 30 s.
    const resumed = c.decide(junction, net, ALL_RED_SECS, 0)
    expect(resumed.phase).toBe(LightPhase.Green)
    expect(resumed.duration).toBe(12)
  })

  it('force_all_red behaves like preempt', () => {
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new RLController()

    c.applyAction(junction, 'force_all_red')
    const d = c.decide(junction, net, 0, 0)
    expect(d.phase).toBe(LightPhase.AllRed)
    expect(d.duration).toBe(ALL_RED_SECS)
  })

  it('a preempt during the clearance keeps the original resume point', () => {
    const junction = makeJunction(12)
    net.intersections['i-1'] = junction
    const c = new RLController()

    c.applyAction(junction, 'preempt')
    c.decide(junction, net, 0, 0)
    // A second preempt one second into the clearance extends it; the
    // resume point must stay (green, 12).
    c.applyAction(junction, 'preempt')
    c.decide(junction, net, 1, 0)
    const resumed = c.decide(junction, net, 1 + ALL_RED_SECS, 0)
    expect(resumed.phase).toBe(LightPhase.Green)
    expect(resumed.duration).toBe(12)
  })

  it('extend_green and shorten_red do nothing during the clearance', () => {
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new RLController()

    // The green runs out → the junction is clearing.
    c.decide(junction, net, 0, 30)
    c.applyAction(junction, 'extend_green')
    c.applyAction(junction, 'shorten_red')
    const clearing = c.decide(junction, net, 0, 0)
    expect(clearing.phase).toBe(LightPhase.Yellow)
    expect(clearing.duration).toBe(3)
  })
})

describe('RLController — the action-source seam', () => {
  const net = buildTestNetwork()

  it('consumes the injected action sequence', () => {
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new RLController({
      actionSource: createSequenceActionSource(['extend_green', 'no_op']),
    })

    expect(c.decide(junction, net, 0, 0).duration).toBe(35)
    // The 'no_op' changes nothing ...
    expect(c.decide(junction, net, 0.1, 0).duration).toBe(35)
    // ... and the sequence is exhausted → the controller keeps its plain
    // cycle.
    expect(c.decide(junction, net, 0.2, 0).duration).toBe(35)
  })

  it('polls the source once per junction per tick', () => {
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    let polls = 0
    const c = new RLController({
      actionSource: {
        nextAction: () => {
          polls += 1
          return null
        },
      },
    })

    c.decide(junction, net, 0, 0)
    expect(polls).toBe(1)
  })

  it('works with no source at all — the applyAction path alone', () => {
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new RLController()
    expect(c.decide(junction, net, 0, 0).duration).toBe(30)
  })
})
