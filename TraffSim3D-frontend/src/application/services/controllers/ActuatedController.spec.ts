import { describe, it, expect } from 'vitest'
import { ActuatedController } from './ActuatedController'
import { makeTestLight, buildTestNetwork } from '@__fixtures__/testNetwork'
import { LightPhase } from '@domain/value-objects/Phase'
import { MAX_GREEN_SECS, GREEN_EXTENSION_STEP, MIN_RED_SECS } from '@shared/constants/simulation'
import { buildImportedNetwork, importedNsLight } from '@__fixtures__/importedNetwork'

describe('ActuatedController', () => {
  const c = new ActuatedController()

  it('extends green by GREEN_EXTENSION_STEP when queue > 0', () => {
    const net = buildTestNetwork(1)
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 10 })
    const d = c.decide(light, net, 0)
    expect(d.phase).toBe(LightPhase.Green)
    expect(d.duration).toBe(10 + GREEN_EXTENSION_STEP)
  })

  it('does not extend green when queue = 0', () => {
    const net = buildTestNetwork(0)
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 10 })
    const d = c.decide(light, net, 0)
    expect(d.duration).toBe(10)
  })

  it('caps green at MAX_GREEN_SECS', () => {
    const net = buildTestNetwork(1)
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: MAX_GREEN_SECS - 1 })
    const d = c.decide(light, net, 0)
    expect(d.duration).toBeLessThanOrEqual(MAX_GREEN_SECS)
  })

  it('green → yellow when phaseRemaining hits 0', () => {
    const net = buildTestNetwork(0)
    const light = makeTestLight({ phase: LightPhase.Green, phaseRemaining: 0 })
    const d = c.decide(light, net, 0)
    expect(d.phase).toBe(LightPhase.Yellow)
    expect(d.duration).toBe(3)
  })

  it('shortens red when opposite axis queue = 0 (016 H4)', () => {
    const net = buildTestNetwork(0)
    const light = makeTestLight({ phase: LightPhase.Red, phaseRemaining: 20, axis: 'ns' })
    const d = c.decide(light, net, 0)
    // The red is **shortened**, not replaced: the phase stays red and the
    // remaining red is cut to the floor. The old code switched the phase
    // to Yellow here, and a Yellow's only successor is Red(BASE_RED) — so
    // the shortened red could never reach Green.
    expect(d.phase).toBe(LightPhase.Red)
    expect(d.duration).toBe(MIN_RED_SECS)
    expect(d.actions[0]?.name).toBe('shorten_red')
  })

  it('counts the reds it shortened', () => {
    const net = buildTestNetwork(0)
    const counter = new ActuatedController()
    const light = makeTestLight({ phase: LightPhase.Red, phaseRemaining: 20, axis: 'ns' })
    expect(counter.shortenRedCount).toBe(0)
    counter.decide(light, net, 0)
    expect(counter.shortenRedCount).toBe(1)
  })

  it('reaches green even when the red is shortened on every check', () => {
    // The livelock this class used to have: the red was replaced by a
    // Yellow, the Yellow's only successor was a **full** red, and the
    // next check shortened that one again — red → yellow → red → … , so
    // the axis never got a green at all. The invariant: a red always
    // ends, so the light reaches Green.
    const net = buildTestNetwork(0)
    const controller = new ActuatedController()
    const light = makeTestLight({ phase: LightPhase.Red, phaseRemaining: 20, axis: 'ns' })
    const dt = 1 / 60
    let simTime = 0
    let sawGreen = false
    for (let frame = 0; frame < 20 / dt && !sawGreen; frame += 1) {
      simTime += dt
      light.phaseRemaining -= dt
      const d = controller.decide(light, net, simTime)
      light.phase = d.phase
      light.phaseRemaining = d.duration
      if (light.phase === LightPhase.Green) sawGreen = true
    }
    expect(sawGreen).toBe(true)
    // The shortening really did fire — the green is not an accident of
    // the red simply running out.
    expect(controller.shortenRedCount).toBeGreaterThan(0)
  })

  it('does not shorten red below MIN_RED_SECS', () => {
    const net = buildTestNetwork(0)
    const light = makeTestLight({ phase: LightPhase.Red, phaseRemaining: MIN_RED_SECS, axis: 'ns' })
    const d = c.decide(light, net, 0)
    expect(d.phase).toBe(LightPhase.Red)
  })

  it('does not shorten red when opposite axis has cars', () => {
    const net = buildTestNetwork(1)
    net.vehicles['v-1']!.roadId = 'r-ew'
    net.vehicles['v-1']!.s = 5
    const light = makeTestLight({ phase: LightPhase.Red, phaseRemaining: 20, axis: 'ns' })
    const d = c.decide(light, net, 0)
    expect(d.phase).toBe(LightPhase.Red)
  })

  it('yellow → all-red when phaseRemaining hits 0', () => {
    const net = buildTestNetwork(0)
    const light = makeTestLight({ phase: LightPhase.Yellow, phaseRemaining: 0 })
    const d = c.decide(light, net, 0)
    // The clearance-yellow is followed by an explicit all-red.
    expect(d.phase).toBe(LightPhase.AllRed)
    expect(d.duration).toBe(3)
  })

  it('all-red → red when phaseRemaining hits 0', () => {
    const net = buildTestNetwork(0)
    const light = makeTestLight({ phase: LightPhase.AllRed, phaseRemaining: 0 })
    const d = c.decide(light, net, 0)
    // The all-red runs out into a **full** red, never straight back into
    // the green.
    expect(d.phase).toBe(LightPhase.Red)
    expect(d.duration).toBe(36)
  })
})

describe('ActuatedController on an imported OSM map', () => {
  const c = new ActuatedController()

  it('shortens red when the opposite axis of the imported map has no queue', () => {
    // The imported map names its roads `w-…`: the old `r-${axis}`
    // lookup found no opposite road, so this branch was unreachable
    // and the light always burned the full red.
    const net = buildImportedNetwork()
    delete net.vehicles['v-osm-ew-1']
    delete net.vehicles['v-osm-branch-1']

    const light = importedNsLight(net)
    light.phase = LightPhase.Red
    light.phaseRemaining = 20

    const d = c.decide(light, net, 0)
    expect(d.phase).toBe(LightPhase.Red)
    expect(d.duration).toBe(MIN_RED_SECS)
    expect(d.actions[0]?.name).toBe('shorten_red')
  })

  it('does not shorten red when the opposite axis of the imported map has cars', () => {
    const net = buildImportedNetwork()
    const light = importedNsLight(net)
    light.phase = LightPhase.Red
    light.phaseRemaining = 20

    // The two EW cars (w-102 and w-103) are queued.
    const d = c.decide(light, net, 0)
    expect(d.phase).toBe(LightPhase.Red)
    expect(d.actions[0]?.name).toBe('no_op')
  })

  it('extends green when the imported map has a queue on the light axis', () => {
    const net = buildImportedNetwork()
    // The extension is the mirror image of the red-shortening: an axis may
    // only hold the junction while nobody is waiting on the other side.
    delete net.vehicles['v-osm-ew-1']
    delete net.vehicles['v-osm-branch-1']

    const light = importedNsLight(net)
    light.phase = LightPhase.Green
    light.phaseRemaining = 10

    const d = c.decide(light, net, 0)
    expect(d.phase).toBe(LightPhase.Green)
    expect(d.duration).toBe(10 + GREEN_EXTENSION_STEP)
  })

  it('does not extend green while the perpendicular axis has a queue', () => {
    const net = buildImportedNetwork()
    const light = importedNsLight(net)
    light.phase = LightPhase.Green
    light.phaseRemaining = 10

    // The two EW cars (w-102 and w-103) are queued: the north–south axis
    // may not hold the junction past its own phase while they wait.
    const d = c.decide(light, net, 0)
    expect(d.phase).toBe(LightPhase.Green)
    expect(d.duration).toBe(10)
  })
})
