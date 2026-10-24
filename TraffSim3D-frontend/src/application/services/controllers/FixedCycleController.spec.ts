// src/application/services/controllers/FixedCycleController.spec.ts
//
// The fixed cycle, at the **junction** level.
//
// The invariant: one junction, one plan, one clock.
//
//   green(30 s) → yellow(3 s) → all-red(3 s) → green(the other axis)
//
// so the cycle is 72 s and the "neither axis is green" gap before every
// green is exactly 6 s. The lights are views of that plan.

import { describe, it, expect } from 'vitest'
import { FixedCycleController } from './FixedCycleController'
import { buildTestNetwork } from '@__fixtures__/testNetwork'
import { LightPhase } from '@domain/value-objects/Phase'
import type { Intersection } from '@domain/entities/Intersection'
import type { TrafficLight } from '@domain/entities/TrafficLight'

const makeLight = (axis: 'ns' | 'ew', phase: LightPhase, remaining: number): TrafficLight => ({
  id: `tl-${axis}`,
  position: { x: 0, y: 0, z: 0 },
  phase,
  phaseRemaining: remaining,
  cycleSeconds: 72,
  axis,
})

/** A junction with one light per axis: ns green, ew red — the built-in shape. */
const makeJunction = (): Intersection => ({
  id: 'i-1',
  position: { x: 0, y: 0, z: 0 },
  connectedRoads: ['r-ns', 'r-ew'],
  trafficLights: [makeLight('ns', LightPhase.Green, 30), makeLight('ew', LightPhase.Red, 36)],
  intersectionRadius: 8,
})

describe('FixedCycleController — the junction plan', () => {
  it('runs green → yellow → all-red → green on the other axis', () => {
    const net = buildTestNetwork()
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new FixedCycleController()

    const green = c.decide(junction, net, 0, 0)
    expect(green.phase).toBe(LightPhase.Green)
    expect(green.duration).toBe(30)

    const yellow = c.decide(junction, net, 0, 30)
    expect(yellow.phase).toBe(LightPhase.Yellow)
    expect(yellow.duration).toBe(3)

    const allRed = c.decide(junction, net, 0, 3)
    expect(allRed.phase).toBe(LightPhase.AllRed)
    expect(allRed.duration).toBe(3)

    const other = c.decide(junction, net, 0, 3)
    expect(other.phase).toBe(LightPhase.Green)
    expect(other.duration).toBe(30)
    expect(other.axis).toBe('ew')
  })

  it('gives the junction a 6 s clearance before every green', () => {
    const net = buildTestNetwork()
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new FixedCycleController()

    // The green ends, the clearance runs (3 s yellow + 3 s all-red) and
    // then the other axis is served.
    c.decide(junction, net, 0, 0)
    c.decide(junction, net, 0, 30)
    c.decide(junction, net, 0, 3)
    const handedOver = c.decide(junction, net, 0, 3)
    expect(handedOver.phase).toBe(LightPhase.Green)
    expect(handedOver.axis).toBe('ew')
  })

  it('shows the served axis the plan and the other axis red with the wait', () => {
    const net = buildTestNetwork()
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new FixedCycleController()

    const green = c.decide(junction, net, 0, 0)
    expect(green.views?.ns.phase).toBe(LightPhase.Green)
    expect(green.views?.ns.remaining).toBe(30)
    // The other axis waits for the rest of the green plus the 6 s
    // clearance that follows it.
    expect(green.views?.ew.phase).toBe(LightPhase.Red)
    expect(green.views?.ew.remaining).toBe(30 + 3 + 3)

    const yellow = c.decide(junction, net, 0, 30)
    expect(yellow.views?.ns.phase).toBe(LightPhase.Yellow)
    expect(yellow.views?.ew.remaining).toBe(3 + 3)

    const allRed = c.decide(junction, net, 0, 3)
    expect(allRed.views?.ns.phase).toBe(LightPhase.AllRed)
    expect(allRed.views?.ew.remaining).toBe(3)
  })

  it('adopts the junction it finds, so a controller switch does not flash', () => {
    const net = buildTestNetwork()
    const junction = makeJunction()
    junction.trafficLights[1]!.phase = LightPhase.Yellow
    junction.trafficLights[1]!.phaseRemaining = 2
    net.intersections['i-1'] = junction
    const c = new FixedCycleController()

    const plan = c.decide(junction, net, 0, 0)
    expect(plan.phase).toBe(LightPhase.Green)
    expect(plan.axis).toBe('ns')
    expect(plan.duration).toBe(30)
  })
})
