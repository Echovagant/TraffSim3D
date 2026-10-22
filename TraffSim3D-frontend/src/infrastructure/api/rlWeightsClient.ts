// src/infrastructure/api/rlWeightsClient.ts
//
// Fetch a saved PPO checkpoint's weights as JSON.
//
// The backend (`app/apps/rl/weights.py`) loads an SB3 .zip, extracts
// the policy `state_dict()`, and returns architecture metadata plus
// nested lists of weights / biases / log_std. The frontend uses this
// to instantiate an in-browser MlpPolicy for replay.

import type { HttpClient } from './httpClient'
import type { PolicyWeights } from '@infrastructure/rl/types'

export interface CheckpointWeightsResponse extends PolicyWeights {
  name: string
  obs_dim: number
  action_dim: number
  hidden_sizes: number[]
  layers: PolicyWeights['layers']
}

export interface RLWeightsClient {
  /** GET /rl/checkpoints/{name}/weights → JSON weights + architecture.
   *  Throws BackendError(404) when the checkpoint doesn't exist or
   *  BackendError(503) when SB3 isn't installed on the backend. */
  getCheckpointWeights(name: string): Promise<CheckpointWeightsResponse>
}

/**
 * Timeout budget for the weights request, in milliseconds.
 *
 * This endpoint is legitimately slower than the rest of the API: the
 * backend loads a ~155 KB SB3 PPO checkpoint and serialises its
 * `state_dict()` to JSON. The first call after a backend restart costs
 * seconds, so the shared 3 s client default aborts the request before the
 * browser ever sees the policy — the "load the trained policy and watch
 * it drive" demo simply fails.
 *
 * Measured on 2026-10-23 (backend on :8001, RTX 4050 + torch 2.11):
 *   - warm backend, cached export: 11–33 ms
 *   - cold export (checkpoint loaded, torch already imported): ~4 s
 *   - cold backend, very first request (also pays `import torch`): ~22 s
 * 30 s covers the worst observed case with margin.
 *
 * The budget is per-request on purpose: raising the shared default would
 * make every other endpoint wait 30 s before giving up. The backend
 * memoises the export per checkpoint file, so this is only ever spent on
 * a genuinely cold load.
 */
export const RL_WEIGHTS_TIMEOUT_MS = 30000

export const createRLWeightsClient = (http: HttpClient): RLWeightsClient => ({
  getCheckpointWeights: (name) =>
    http.get<CheckpointWeightsResponse>(`/rl/checkpoints/${encodeURIComponent(name)}/weights`, {
      timeoutMs: RL_WEIGHTS_TIMEOUT_MS,
    }),
})
