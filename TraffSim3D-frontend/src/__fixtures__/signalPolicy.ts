// src/__fixtures__/signalPolicy.ts
//
// Test-only helper: a **discrete** signal policy whose argmax is a chosen
// action, whatever the observation.
//
// One hidden unit that is switched off, so the action layer sees a zero
// input and only the action bias decides — the simplest possible policy
// that still goes through the real forward pass
// (`mlpInference.mlpForwardDiscrete`).

import { SIGNAL_ACTION_NAMES } from '@shared/constants/simulation'
import type { PolicyWeights } from '@infrastructure/rl/types'
import { SIG_OBS_DIM } from '@application/services/signalPolicySource'

export const constantSignalPolicy = (actionIndex: number): PolicyWeights => {
  const zeros = (n: number) => new Array<number>(n).fill(0)
  const actionBias = zeros(SIGNAL_ACTION_NAMES.length)
  actionBias[actionIndex] = 1
  const actionWeight = SIGNAL_ACTION_NAMES.map((_, i) => (i === actionIndex ? [1] : [0]))
  return {
    name: `constant-${SIGNAL_ACTION_NAMES[actionIndex]}.zip`,
    obs_dim: SIG_OBS_DIM,
    action_dim: SIGNAL_ACTION_NAMES.length,
    action_space: 'discrete',
    hidden_sizes: [1, 1],
    layers: {
      'policy_net.0.weight': [zeros(SIG_OBS_DIM)],
      'policy_net.0.bias': [0],
      'policy_net.2.weight': [[0]],
      'policy_net.2.bias': [0],
      'action_net.weight': actionWeight,
      'action_net.bias': actionBias,
    },
  }
}
