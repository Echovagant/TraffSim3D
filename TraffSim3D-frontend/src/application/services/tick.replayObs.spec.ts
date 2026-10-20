// src/application/services/tick.replayObs.spec.ts
//
// Plan 069 — Python parity for the replay observation's traffic-light bits.
//
// Python's `SimCore._obs()` sets:
//     obs[6] = 1 if ns_green else 0      # the NS axis, ALWAYS
//     obs[7] = 1 if ew_green else 0      # the EW axis, ALWAYS
// and the two are always complementary, because SimCore swaps `ns_green` /
// `ew_green` together and has no yellow phase at all.
//
// The previous TS implementation set only the ego's own axis bit and used
// "phase === Green", so for an NS ego obs[7] stayed 0 forever and the pair
// degraded to (0,0) during the TS sim's 3s yellow — a state the policy can
// never observe in Python.
//
// These tests pin the corrected semantics:
//   1. each axis is reported independently of the ego's heading
//   2. the pair is always one-hot (never (0,0) and never (1,1))
//   3. "may go" includes the clearance-yellow phase
//   4. a left-turn light cannot mask a red through-lane

import { describe, it, expect } from 'vitest'
import { buildReplayObs } from './tick'
import { LightPhase } from '@domain/value-objects/Phase'
import { createRoadNetwork } from '@domain/entities/RoadNetwork'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { TrafficLight } from '@domain/entities/TrafficLight'
import { makeTestRoad, makeTestVehicle } from '@__fixtures__/testNetwork'

const light = (axis: 'ns' | 'ew', phase: LightPhase, id: string): TrafficLight => ({
  id,
  position: { x: 0, y: 0, z: 0 },
  phase,
  phaseRemaining: 10,
  cycleSeconds: 63,
  axis,
})

/** One intersection with an NS light and an EW light. */
const networkWith = (ns: TrafficLight, ew: TrafficLight): RoadNetwork => {
  const net = createRoadNetwork()
  net.roads['r-ns'] = makeTestRoad('r-ns', 'ns', 2)
  net.roads['r-ew'] = makeTestRoad('r-ew', 'ew', 2)
  net.intersections['i-1'] = {
    id: 'i-1',
    position: { x: 0, y: 0, z: 0 },
    connectedRoads: ['r-ns', 'r-ew'],
    trafficLights: [ns, ew],
    intersectionRadius: 8,
  }
  return net
}

const nsEgo = () => makeTestVehicle({ id: 'v-1', roadId: 'r-ns', heading: Math.PI / 2 })
const ewEgo = () =>
  makeTestVehicle({ id: 'v-ew', roadId: 'r-ew', heading: 0, position: { x: -20, y: 0, z: 0 } })

describe('buildReplayObs traffic-light bits (Plan 069)', () => {
  it('reports the NS axis in obs[6] and the EW axis in obs[7]', () => {
    const net = networkWith(
      light('ns', LightPhase.Green, 'tl-ns'),
      light('ew', LightPhase.Red, 'tl-ew'),
    )
    const obs = buildReplayObs(nsEgo(), net)
    expect(obs[6]).toBe(1)
    expect(obs[7]).toBe(0)

    // Flip the axes: the bits must follow the AXIS, not the ego.
    const flipped = networkWith(
      light('ns', LightPhase.Red, 'tl-ns'),
      light('ew', LightPhase.Green, 'tl-ew'),
    )
    const obs2 = buildReplayObs(nsEgo(), flipped)
    expect(obs2[6]).toBe(0)
    expect(obs2[7]).toBe(1)
  })

  it('is heading-independent — an EW ego sees the same light bits', () => {
    const net = networkWith(
      light('ns', LightPhase.Green, 'tl-ns'),
      light('ew', LightPhase.Red, 'tl-ew'),
    )
    const fromNs = buildReplayObs(nsEgo(), net)
    const fromEw = buildReplayObs(ewEgo(), net)
    expect(fromEw[6]).toBe(fromNs[6])
    expect(fromEw[7]).toBe(fromNs[7])
  })

  it('keeps the pair one-hot across the whole phase sweep', () => {
    // The TS cycle is NS: G(30) Y(3) R(30); EW: R(33) G(30) Y(3) R(30).
    // Every combination must yield exactly one "may go" axis.
    const phases = [
      LightPhase.Green,
      LightPhase.Yellow,
      LightPhase.Red,
      LightPhase.GreenLeft,
      LightPhase.YellowLeft,
      LightPhase.RedLeft,
      LightPhase.AllRed,
    ]
    for (const nsPhase of phases) {
      for (const ewPhase of phases) {
        const net = networkWith(light('ns', nsPhase, 'tl-ns'), light('ew', ewPhase, 'tl-ew'))
        const obs = buildReplayObs(nsEgo(), net)
        const sum = obs[6]! + obs[7]!
        expect(sum, `ns=${nsPhase} ew=${ewPhase} -> obs[6]=${obs[6]} obs[7]=${obs[7]}`).toBe(1)
      }
    }
  })

  it('treats the clearance-yellow phase as "may go"', () => {
    const net = networkWith(
      light('ns', LightPhase.Yellow, 'tl-ns'),
      light('ew', LightPhase.Red, 'tl-ew'),
    )
    const obs = buildReplayObs(nsEgo(), net)
    expect(obs[6]).toBe(1)
    expect(obs[7]).toBe(0)
  })

  it('does not let a left-turn light mask a red through-lane', () => {
    const net = createRoadNetwork()
    net.roads['r-ns'] = makeTestRoad('r-ns', 'ns', 2)
    net.roads['r-ew'] = makeTestRoad('r-ew', 'ew', 2)
    net.intersections['i-1'] = {
      id: 'i-1',
      position: { x: 0, y: 0, z: 0 },
      connectedRoads: ['r-ns', 'r-ew'],
      trafficLights: [
        // The left-turn light comes FIRST on purpose: the axis state must be
        // taken from the through-lane light, not from whichever light the
        // array happens to list first.
        light('ns', LightPhase.GreenLeft, 'tl-ns-left'),
        light('ns', LightPhase.Red, 'tl-ns'),
        light('ew', LightPhase.Red, 'tl-ew'),
      ],
      intersectionRadius: 8,
    }
    const obs = buildReplayObs(nsEgo(), net)
    // The through-lane is red → the NS axis is not "may go", even though a
    // left-turn light on the same axis is green.
    expect(obs[6]).toBe(0)
    // Neither axis may go (the left-turn green is excluded by the
    // through-lane preference). Python's pair is always one-hot, so the
    // "neither" case is reported as (0,1) — "NS must stop", which is the
    // right action during an all-red clearance.
    expect(obs[7]).toBe(1)
  })

  it('keeps the pair one-hot even for degenerate light configurations', () => {
    // Both axes green → NS wins the tie.
    const bothGreen = networkWith(
      light('ns', LightPhase.Green, 'tl-ns'),
      light('ew', LightPhase.Green, 'tl-ew'),
    )
    const a = buildReplayObs(nsEgo(), bothGreen)
    expect(a[6] + a[7]).toBe(1)
    expect(a[6]).toBe(1)

    // Neither axis may go → reported as (0,1) = "NS must stop".
    const allRed = networkWith(
      light('ns', LightPhase.Red, 'tl-ns'),
      light('ew', LightPhase.Red, 'tl-ew'),
    )
    const b = buildReplayObs(nsEgo(), allRed)
    expect(b[6] + b[7]).toBe(1)
    expect(b[6]).toBe(0)
  })
})
