// src/infrastructure/rl/mlpInference.ts
//
// Plan 049: in-browser forward pass for SB3 PPO MlpPolicy.
//
// Re-implements the SB3 default policy in pure TS so the frontend can
// run a trained PPO checkpoint without PyTorch / onnxruntime. The
// forward pass is small (<30 lines) and matches the layer layout
// verified in the backend (`app/apps/rl/weights.py`):
//
//   obs (13)
//     → policy_net.0  Linear(13, 64)  + Tanh
//     → policy_net.2  Linear(64, 64)  + Tanh
//     → action_net    Linear(64, 2)
//     = mean (2,)
//
// Action sampling (for stochastic policy) uses `log_std` (learnable
// parameter) and Box-Muller Gaussian noise. Deterministic replay uses
// `mean` directly.

import type { PolicyAction, PolicyWeights } from './types'

/** Matrix-vector product `y = W x`, where W has shape (out, in).
 *
 *  PyTorch `nn.Linear.weight` is stored as (out_features, in_features).
 *  We compute `y[i] = Σ_j W[i][j] * x[j]` for each output row. */
export const matVec = (w: number[][], x: number[]): number[] => {
  const out = new Array<number>(w.length)
  for (let i = 0; i < w.length; i++) {
    const row = w[i]!
    let s = 0
    for (let j = 0; j < x.length; j++) s += row[j]! * x[j]!
    out[i] = s
  }
  return out
}

/** Element-wise vector add `y = v + b`. */
export const addBias = (v: number[], b: number[]): number[] => {
  const out = new Array<number>(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i]! + b[i]!
  return out
}

/** Element-wise `Math.tanh`. */
export const tanhVec = (v: number[]): number[] => v.map(Math.tanh)

/** Deterministic forward pass — returns the Gaussian mean (action).
 *  Use this for replay so the same state → same action. */
export const mlpForwardMean = (obs: number[], w: PolicyWeights): PolicyAction => {
  const inputWeights = w.layers['policy_net.0.weight']
  const expectedDim = inputWeights[0]?.length ?? 0
  if (obs.length !== expectedDim) {
    throw new Error(`obs dim mismatch: got ${obs.length}, weights expect ${expectedDim}`)
  }
  let h = addBias(matVec(inputWeights, obs), w.layers['policy_net.0.bias'])
  h = tanhVec(h)
  h = addBias(matVec(w.layers['policy_net.2.weight'], h), w.layers['policy_net.2.bias'])
  h = tanhVec(h)
  const mean = addBias(matVec(w.layers['action_net.weight'], h), w.layers['action_net.bias'])
  return [mean[0] ?? 0, mean[1] ?? 0]
}

/** Sample action from the diagonal Gaussian policy. Uses two cached
 *  uniform samples per call (Box-Muller), so we get a proper Normal
 *  draw without depending on `crypto` or other RNG sources.
 *
 *  Production: use `mlpForwardMean` for deterministic replay. This
 *  function is here for completeness / future stochastic mode. */
export const mlpForwardSample = (
  obs: number[],
  w: PolicyWeights,
  rng: () => number,
): PolicyAction => {
  const mean = mlpForwardMean(obs, w)
  const std = w.layers.log_std.map(Math.exp)
  const [z0, z1] = boxMuller(rng, rng)
  return [mean[0] + std[0]! * z0, mean[1] + std[1]! * z1]
}

/** Box-Muller transform: two uniform [0,1) draws → two standard normal. */
const boxMuller = (u1: () => number, u2: () => number): [number, number] => {
  const r = Math.sqrt(-2 * Math.log(Math.max(1e-7, u1())))
  const theta = 2 * Math.PI * u2()
  return [r * Math.cos(theta), r * Math.sin(theta)]
}
