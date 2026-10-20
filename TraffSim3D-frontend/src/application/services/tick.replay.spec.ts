// src/application/services/tick.replay.spec.ts
//
// Plan 071: the product replay path's speed integration.
//
// Before Plan 071 the replay path was inert: tick's step 3 wrote
// `v.targetSpeed = road.speedLimit` unconditionally, overwriting the
// policy's own `nextSpeed`, so the vehicle drove at the road speed limit
// whether or not a policy was loaded. These tests pin the fixed
// behaviour: the policy (or an injected fixed action) owns the replay
// target's speed, and that speed follows Python's integration exactly.

import { describe, it, expect } from 'vitest'
import { tick } from './tick'
import { buildTestNetwork } from '@__fixtures__/testNetwork'
import { PYTHON_SIM } from '@shared/constants/simulation'
import type { TickContext } from './tick'
import type { PolicyWeights } from '@infrastructure/rl/types'

/** A policy whose forward pass always emits action[0] = 1.0. */
const CONSTANT_POLICY: PolicyWeights = {
  name: 'test',
  obs_dim: 14,
  action_dim: 2,
  hidden_sizes: [64, 64],
  layers: {
    'policy_net.0.weight': Array.from({ length: 64 }, () => new Array(14).fill(0)),
    'policy_net.0.bias': new Array(64).fill(0),
    'policy_net.2.weight': Array.from({ length: 64 }, () => new Array(64).fill(0)),
    'policy_net.2.bias': new Array(64).fill(0),
    'action_net.weight': [new Array(64).fill(0), new Array(64).fill(0)],
    'action_net.bias': [1.0, 0.0],
    log_std: [0, 0],
  },
}

const makeCtx = (overrides: Partial<TickContext> = {}): TickContext => ({
  rapierWorld: null,
  signal: null,
  trajectoryExporter: null,
  sensorRegistry: null,
  lidarEnabled: false,
  getHostPose: () => null,
  fixedStepScheduler: null,
  draggingId: null,
  removeVehicle: () => {},
  policy: null,
  replayTargetId: null,
  ...overrides,
})

const speedSeries = (
  ctx: TickContext,
  net: ReturnType<typeof buildTestNetwork>,
  steps: number,
  action: readonly [number, number] = [1.0, 0.0],
): number[] => {
  const out: number[] = []
  for (let i = 0; i < steps; i++) {
    ctx.replayAction = action
    tick(net, PYTHON_SIM.DT, (i + 1) * PYTHON_SIM.DT, ctx)
    out.push(net.vehicles['v-1']!.speed)
  }
  return out
}

describe('tick — replay path owns the target speed', () => {
  it('does not fall back to the road speed limit when a policy is loaded', () => {
    const net = buildTestNetwork(1)
    const ctx = makeCtx({ policy: CONSTANT_POLICY, replayTargetId: 'v-1' })
    tick(net, PYTHON_SIM.DT, PYTHON_SIM.DT, ctx)
    // The policy asked for accel 1.0 -> next speed = 0 + 3.0 * 0.1.
    // The road speed limit is 20, which is what the old code produced.
    expect(net.vehicles['v-1']!.targetSpeed).toBe(0.30000000000000004)
    expect(net.vehicles['v-1']!.targetSpeed).not.toBe(20)
  })

  it('follows Python speed integration exactly for an injected action', () => {
    const net = buildTestNetwork(1)
    const ctx = makeCtx({ replayTargetId: 'v-1' })
    const series = speedSeries(ctx, net, 6)
    expect(series).toEqual([
      0.30000000000000004, 0.6000000000000001, 0.9000000000000001, 1.2000000000000002,
      1.5000000000000002, 1.8000000000000003,
    ])
  })

  it('clips the action into [-1, 1] like Python does', () => {
    const net = buildTestNetwork(1)
    const ctx = makeCtx({ replayTargetId: 'v-1' })
    const clipped = speedSeries(ctx, net, 1, [2.0, 0.0])
    const net2 = buildTestNetwork(1)
    const ctx2 = makeCtx({ replayTargetId: 'v-1' })
    const inRange = speedSeries(ctx2, net2, 1, [1.0, 0.0])
    expect(clipped).toEqual(inRange)
  })

  it('leaves non-replay vehicles on the road speed limit', () => {
    const net = buildTestNetwork(2)
    const ctx = makeCtx({ replayTargetId: 'v-1' })
    tick(net, PYTHON_SIM.DT, PYTHON_SIM.DT, ctx)
    expect(net.vehicles['v-2']!.targetSpeed).toBe(20)
  })
})
