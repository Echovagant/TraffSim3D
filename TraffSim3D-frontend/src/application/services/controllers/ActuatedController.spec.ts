// src/application/services/controllers/ActuatedController.spec.ts
//
// The actuated controller, at the **junction** level.
//
// The rules it enforces:
//   - the clearance comes first — an axis goes green only after the
//     other axis has finished its clearance,
//   - the green may be extended only while the perpendicular axis has
//     nobody waiting (the classical actuated rule),
//   - `MAX_GREEN_SECS` bounds the green's **duration**, not just its
//     remaining time.

import { describe, it, expect } from 'vitest'
import { ActuatedController } from './ActuatedController'
import { buildTestNetwork } from '@__fixtures__/testNetwork'
import { LightPhase } from '@domain/value-objects/Phase'
import type { Intersection } from '@domain/entities/Intersection'
import type { TrafficLight } from '@domain/entities/TrafficLight'
import { GREEN_EXTENSION_STEP, MAX_GREEN_SECS } from '@shared/constants/simulation'

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

describe('ActuatedController — the junction rules', () => {
  it('extends the green while the perpendicular axis has nobody waiting', () => {
    const net = buildTestNetwork(1)
    const junction = makeJunction(10)
    net.intersections['i-1'] = junction
    const c = new ActuatedController()

    const plan = c.decide(junction, net, 0, 0)
    expect(plan.phase).toBe(LightPhase.Green)
    expect(plan.duration).toBe(10 + GREEN_EXTENSION_STEP)
  })

  it('does not extend the green while the perpendicular axis has a queue', () => {
    const net = buildTestNetwork(1)
    // The vehicle waits on the **perpendicular** (east–west) axis.
    net.vehicles['v-1']!.roadId = 'r-ew'
    net.vehicles['v-1']!.s = 5
    const junction = makeJunction(10)
    net.intersections['i-1'] = junction
    const c = new ActuatedController()

    const plan = c.decide(junction, net, 0, 0)
    expect(plan.phase).toBe(LightPhase.Green)
    expect(plan.duration).toBe(10)
  })

  it('does not extend the green when the served axis has nobody waiting', () => {
    const net = buildTestNetwork(0)
    const junction = makeJunction(10)
    net.intersections['i-1'] = junction
    const c = new ActuatedController()

    const plan = c.decide(junction, net, 0, 0)
    expect(plan.duration).toBe(10)
  })

  it('bounds the green by MAX_GREEN_SECS of duration, not of remaining time', () => {
    // The extension tops the remaining time back up, so a green with a
    // permanent queue would never end on its own — the duration bound is
    // what stops it.
    const net = buildTestNetwork(1)
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new ActuatedController()

    let plan = c.decide(junction, net, 0, 1)
    for (let second = 1; second <= MAX_GREEN_SECS; second += 1) {
      plan = c.decide(junction, net, second, 1)
    }
    // The budget is spent: the green ends, queue or not.
    expect(plan.phase).not.toBe(LightPhase.Green)
  })

  it('hands the junction over only after the clearance has run out', () => {
    const net = buildTestNetwork(0)
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new ActuatedController()

    // The green runs out ...
    const yellow = c.decide(junction, net, 0, 30)
    expect(yellow.phase).toBe(LightPhase.Yellow)
    // ... the clearance follows ...
    const allRed = c.decide(junction, net, 0, 3)
    expect(allRed.phase).toBe(LightPhase.AllRed)
    // ... and only then is the other axis served.
    const green = c.decide(junction, net, 0, 3)
    expect(green.phase).toBe(LightPhase.Green)
    expect(green.axis).toBe('ew')
  })

  it('keeps the clearance at 6 s — the extension never eats it', () => {
    const net = buildTestNetwork(1)
    const junction = makeJunction()
    net.intersections['i-1'] = junction
    const c = new ActuatedController()

    // The green is extended every tick for a whole minute ...
    let plan = c.decide(junction, net, 0, 1)
    for (let second = 1; second <= MAX_GREEN_SECS; second += 1) {
      plan = c.decide(junction, net, second, 1)
    }
    // ... and when it finally runs out, the clearance is still 3 + 3 s.
    expect(plan.phase).toBe(LightPhase.Yellow)
    expect(plan.duration).toBe(3)
    const allRed = c.decide(junction, net, MAX_GREEN_SECS, 3)
    expect(allRed.phase).toBe(LightPhase.AllRed)
    expect(allRed.duration).toBe(3)
    const handedOver = c.decide(junction, net, MAX_GREEN_SECS, 3)
    expect(handedOver.phase).toBe(LightPhase.Green)
    expect(handedOver.axis).toBe('ew')
  })
})
