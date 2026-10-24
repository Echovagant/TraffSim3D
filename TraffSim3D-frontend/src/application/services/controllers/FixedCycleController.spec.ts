import { describe, it, expect } from 'vitest'
import { FixedCycleController } from './FixedCycleController'
import { makeTestLight, buildTestNetwork } from '@__fixtures__/testNetwork'

describe('FixedCycleController', () => {
  const c = new FixedCycleController()

  it('stays in current phase when phaseRemaining > 0', () => {
    const net = buildTestNetwork()
    const light = makeTestLight({ phase: 'green', phaseRemaining: 10 })
    const d = c.decide(light, net, 0)
    expect(d.phase).toBe('green')
    expect(d.duration).toBe(10)
  })
  it('green → yellow when phaseRemaining hits 0', () => {
    const net = buildTestNetwork()
    const light = makeTestLight({ phase: 'green', phaseRemaining: 0 })
    const d = c.decide(light, net, 0)
    expect(d.phase).toBe('yellow')
    expect(d.duration).toBe(3)
  })
  it('yellow → all-red when phaseRemaining hits 0', () => {
    const net = buildTestNetwork()
    const light = makeTestLight({ phase: 'yellow', phaseRemaining: 0 })
    const d = c.decide(light, net, 0)
    // The clearance-yellow is followed by an explicit all-red: the junction
    // shows nothing to anybody for 3 s before the red starts.
    expect(d.phase).toBe('allRed')
    expect(d.duration).toBe(3)
  })
  it('all-red → red when phaseRemaining hits 0', () => {
    const net = buildTestNetwork()
    const light = makeTestLight({ phase: 'allRed', phaseRemaining: 0 })
    const d = c.decide(light, net, 0)
    // The all-red runs out into a **full** red — never straight back into
    // the green, which is what used to make a desynchronised pair of
    // lights ping-pong every 3 s.
    expect(d.phase).toBe('red')
    expect(d.duration).toBe(36)
  })
  it('red → green when phaseRemaining hits 0', () => {
    const net = buildTestNetwork()
    const light = makeTestLight({ phase: 'red', phaseRemaining: 0 })
    const d = c.decide(light, net, 0)
    expect(d.phase).toBe('green')
    expect(d.duration).toBe(30)
  })
})
