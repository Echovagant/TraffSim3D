// src/application/services/controllers/CoordinatedController.spec.ts
//
// The green wave.
//
// A green wave is a relation **between junctions**: the next junction
// along a corridor starts its green a fixed number of seconds after the
// previous one. So the offset is per **junction** — the junction's whole
// plan is shifted by its offset against the common reference.
//
// The phase comes from the sim time, not from a countdown, so the
// clearance is exactly 6 s and the period exactly 72 s however the
// junctions are offset.

import { describe, it, expect } from 'vitest'
import {
  CoordinatedController,
  COORDINATED_DEFAULT_OFFSET_KEY,
  type CoordinatedControllerDeps,
} from './CoordinatedController'
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

const makeJunction = (id = 'i-1'): Intersection => ({
  id,
  position: { x: 0, y: 0, z: 0 },
  connectedRoads: ['r-ns', 'r-ew'],
  trafficLights: [makeLight('ns', LightPhase.Green, 30), makeLight('ew', LightPhase.Red, 36)],
  intersectionRadius: 8,
})

const makeDeps = (offsets: Map<string, number>, enabled: boolean): CoordinatedControllerDeps => ({
  getOffsets: () => offsets,
  isEnabled: () => enabled,
})

/** The sim time at which the junction's served axis goes green. */
const greenStartOf = (
  c: CoordinatedController,
  junction: Intersection,
  net: ReturnType<typeof buildTestNetwork>,
): number => {
  for (let t = 0; t <= 72; t += 0.5) {
    const plan = c.decide(junction, net, t, 0)
    if (plan.phase === LightPhase.Green && plan.axis === 'ns') return t
  }
  return Number.NaN
}

describe('CoordinatedController — the per-junction green wave', () => {
  it('offsets a junction’s green against the common reference', () => {
    const net = buildTestNetwork()
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new CoordinatedController(makeDeps(new Map([['i-1', 10]]), true))

    // The junction is anchored 10 s into the future, so at t=0 it is
    // already 62 s into its cycle — the other axis is being served.
    const atZero = c.decide(junction, net, 0, 0)
    expect(atZero.phase).toBe(LightPhase.Green)
    expect(atZero.axis).toBe('ew')

    // At t=10 the junction's own axis takes over, for a full 30 s.
    const atTen = c.decide(junction, net, 10, 0)
    expect(atTen.phase).toBe(LightPhase.Green)
    expect(atTen.axis).toBe('ns')
    expect(atTen.duration).toBe(30)
  })

  it('starts the junctions’ greens the configured amount apart', () => {
    const net = buildTestNetwork()
    const first = makeJunction('i-1')
    const second = makeJunction('i-2')
    net.intersections['i-1'] = first
    net.intersections['i-2'] = second
    const offsets = new Map([
      ['i-1', 0],
      ['i-2', 12],
    ])

    const a = new CoordinatedController(makeDeps(offsets, true))
    const b = new CoordinatedController(makeDeps(offsets, true))
    const startA = greenStartOf(a, first, net)
    const startB = greenStartOf(b, second, net)
    expect(startB - startA).toBeCloseTo(12, 5)
  })

  it('ignores the offsets while the coordination is disabled', () => {
    const net = buildTestNetwork()
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new CoordinatedController(makeDeps(new Map([['i-1', 10]]), false))

    const plan = c.decide(junction, net, 0, 0)
    expect(plan.phase).toBe(LightPhase.Green)
    expect(plan.axis).toBe('ns')
    expect(plan.duration).toBe(30)
  })

  it('inherits the corridor-wide default when the junction has none', () => {
    const net = buildTestNetwork()
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const offsets = new Map([[COORDINATED_DEFAULT_OFFSET_KEY, 10]])
    const c = new CoordinatedController(makeDeps(offsets, true))

    // The junction is anchored at the first decide — the offset shifts
    // its whole plan against the common reference.
    c.decide(junction, net, 0, 0)
    const atTen = c.decide(junction, net, 10, 0)
    expect(atTen.phase).toBe(LightPhase.Green)
    expect(atTen.axis).toBe('ns')
  })

  it('keeps a 6 s clearance and a 72 s period, offset or not', () => {
    const net = buildTestNetwork()
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new CoordinatedController(makeDeps(new Map([['i-1', 7]]), true))

    // The junction is anchored 7 s into the future, so its own axis is
    // served from t=7 to t=37.
    c.decide(junction, net, 0, 0)
    // The clearance: the served axis' yellow (3 s) plus the all-red
    // (3 s) before the other axis is served.
    const yellow = c.decide(junction, net, 37, 0)
    expect(yellow.phase).toBe(LightPhase.Yellow)
    expect(yellow.duration).toBe(3)
    const allRed = c.decide(junction, net, 40, 0)
    expect(allRed.phase).toBe(LightPhase.AllRed)
    expect(allRed.duration).toBe(3)
    const handedOver = c.decide(junction, net, 43, 0)
    expect(handedOver.phase).toBe(LightPhase.Green)
    expect(handedOver.axis).toBe('ew')
  })

  it('rebuilds the anchor when the sim time rewinds', () => {
    const net = buildTestNetwork()
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new CoordinatedController(makeDeps(new Map(), false))

    const at100 = c.decide(junction, net, 100, 0)
    const at50 = c.decide(junction, net, 50, 0)
    // The junction is still in the same phase — the anchor was rebuilt
    // from it, so the rewind does not jump the signal.
    expect(at50.phase).toBe(at100.phase)
    expect(at50.axis).toBe(at100.axis)
    expect(at50.duration).toBeCloseTo(at100.duration, 1)
  })
})
