// src/shared/constants/simulation.spec.ts
//
// The browser's minimum inter-green.
//
// The inter-green is the "lost time" every phase change costs: the time
// between the end of one axis' green and the start of the other axis'
// green, during which no new vehicle may go. The browser implements it
// with two pieces — the outgoing axis' clearance-yellow and the all-red
// the intersection's conflict resolution forces — so the constant is
// *derived* from them rather than written as a bare literal: a number
// that cannot silently drift away from the code that implements it.
//
// The Python training sim charges the same 6 s (`app/apps/rl/sim_core.py`
// `CLEARANCE_SECS`), and the cross-language contract compares the two
// (`tests/contract/test_cross_lang_consistency.py`).

import { describe, it, expect } from 'vitest'
import { LightPhase } from '@domain/value-objects/Phase'
import { tick } from '@/application/services/tick'
import { buildTestNetwork, makeTestLight } from '@__fixtures__/testNetwork'
import { CONFLICT_ALL_RED_SECS, MIN_INTER_GREEN_SECS, YELLOW_CLEAR_SECS } from './simulation'
import type { TickContext } from '@/application/services/tick'
import type { SignalController, SignalDecision } from '@/application/services/signalController'

describe('the minimum inter-green', () => {
  it('is six seconds', () => {
    expect(MIN_INTER_GREEN_SECS).toBe(6)
  })

  it('is derived from the two pieces that implement it', () => {
    // The outgoing axis' clearance-yellow ...
    expect(YELLOW_CLEAR_SECS).toBe(3)
    // ... plus the all-red the conflict resolution forces.
    expect(CONFLICT_ALL_RED_SECS).toBe(3)
    // The inter-green is their sum — not a separate literal that could
    // drift away from the code.
    expect(MIN_INTER_GREEN_SECS).toBe(YELLOW_CLEAR_SECS + CONFLICT_ALL_RED_SECS)
  })

  it('is what the conflict resolution actually charges', () => {
    // Two perpendicular approaches both showing green is the conflict
    // the resolution exists for: one of them is forced into the clearance,
    // and it is given exactly `CONFLICT_ALL_RED_SECS` to run. If that
    // literal ever drifts away from the constant, this test goes red.
    const net = buildTestNetwork(0)
    const ns = makeTestLight({
      id: 'tl-ns',
      axis: 'ns',
      phase: LightPhase.Green,
      phaseRemaining: 30,
    })
    const ew = makeTestLight({
      id: 'tl-ew',
      axis: 'ew',
      phase: LightPhase.Green,
      phaseRemaining: 10,
    })
    net.intersections['i-1']!.trafficLights = [ns, ew]

    // A controller that always answers "green" — the conflict is then
    // produced by the resolution, not by the controllers.
    const alwaysGreen: SignalController = {
      decide: (): SignalDecision => ({
        phase: LightPhase.Green,
        duration: 30,
        actions: [],
        decidedAt: 0,
      }),
      applyAction: () => {},
    }
    const ctx: TickContext = {
      rapierWorld: null,
      signal: {
        controllers: new Map([
          ['tl-ns', alwaysGreen],
          ['tl-ew', alwaysGreen],
        ]),
        controllerKind: 'fixed-cycle',
        getCoordinatedOffsets: () => new Map(),
        isCoordinatedEnabled: () => false,
        getRlActionSource: () => undefined,
      },
      trajectoryExporter: null,
      sensorRegistry: null,
      lidarEnabled: false,
      getHostPose: () => null,
      fixedStepScheduler: null,
      draggingId: null,
      removeVehicle: () => {},
      policy: null,
      replayTargetId: null,
    }

    tick(net, 0.1, 0.1, ctx)

    // One axis keeps the green, the other is forced into the all-red
    // clearance — and the phase machine then serves it a **full red**,
    // which is what stops the 3 s ping-pong.
    const phases = net.intersections['i-1']!.trafficLights.map((l) => l.phase)
    expect(phases.filter((p) => p === LightPhase.AllRed)).toHaveLength(1)
    const forced = net.intersections['i-1']!.trafficLights.find(
      (l) => l.phase === LightPhase.AllRed,
    )!
    expect(forced.phaseRemaining).toBe(CONFLICT_ALL_RED_SECS)
  })

  it('does not fire on a legal green → yellow hand-over', () => {
    // A yellow is the *clearing* of the axis that is ending: `green +
    // yellow` is a legal transition, and the phase machine's own all-red
    // phase provides the clearance. Treating the yellow as "active" is
    // what made the browser's inter-green asymmetric.
    const net = buildTestNetwork(0)
    const ns = makeTestLight({
      id: 'tl-ns',
      axis: 'ns',
      phase: LightPhase.Green,
      phaseRemaining: 30,
    })
    const ew = makeTestLight({
      id: 'tl-ew',
      axis: 'ew',
      phase: LightPhase.Yellow,
      phaseRemaining: 3,
    })
    net.intersections['i-1']!.trafficLights = [ns, ew]

    const ctx: TickContext = {
      rapierWorld: null,
      signal: {
        controllers: new Map<string, SignalController>(),
        controllerKind: 'fixed-cycle',
        getCoordinatedOffsets: () => new Map(),
        isCoordinatedEnabled: () => false,
        getRlActionSource: () => undefined,
      },
      trajectoryExporter: null,
      sensorRegistry: null,
      lidarEnabled: false,
      getHostPose: () => null,
      fixedStepScheduler: null,
      draggingId: null,
      removeVehicle: () => {},
      policy: null,
      replayTargetId: null,
    }

    tick(net, 0.1, 0.1, ctx)

    // The yellow keeps its phase — it was not forced into the clearance.
    const ewLight = net.intersections['i-1']!.trafficLights.find((l) => l.axis === 'ew')!
    expect(ewLight.phase).not.toBe(LightPhase.AllRed)
  })
})
