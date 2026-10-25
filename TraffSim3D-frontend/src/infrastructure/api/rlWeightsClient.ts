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

/** The training provenance the shipped grid policy carries. */
export interface GridPolicyTrainingInfo {
  grid: string
  demand_scale: number
  env_steps: number
  best_step: number
  margin: number
  beats_baseline: boolean
  actions: Record<string, number>
}

/** GET /rl/signal/grid-policy — the policy the product ships with.
 *
 * Same weights shape as a checkpoint export (a discrete five-action
 * policy, no `log_std`), plus the two delivery markers (`policy_kind`,
 * `source`) and the training provenance. See
 * `app/apps/rl/grid_policy.py` — the backend validates the same
 * constraints before serving it. */
export interface GridPolicyResponse extends CheckpointWeightsResponse {
  policy_kind: 'signal'
  source: 'shipped'
  action_names: string[]
  training?: GridPolicyTrainingInfo
}

export interface RLWeightsClient {
  /** GET /rl/checkpoints/{name}/weights → JSON weights + architecture.
   *  Throws BackendError(404) when the checkpoint doesn't exist or
   *  BackendError(503) when SB3 isn't installed on the backend. */
  getCheckpointWeights(name: string): Promise<CheckpointWeightsResponse>
  /** GET /rl/signal/grid-policy → the shipped grid MAPPO policy.
   *  Throws BackendError(503) when the shipped asset is broken (a broken
   *  install) and the network error when the backend is absent. */
  getGridPolicy(): Promise<GridPolicyResponse>
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

/**
 * Timeout budget for the shipped-grid-policy request, in milliseconds.
 *
 * Unlike the checkpoint export this endpoint loads no torch model — the
 * backend reads and validates a ~150 KB JSON asset (the first call; later
 * calls are served from the module cache). The budget is deliberately
 * tighter than the checkpoint one: 10 s covers a cold backend that is
 * still importing its own modules, and a genuinely broken install should
 * surface as an error quickly rather than hang the page's default-load
 * path for half a minute.
 */
export const GRID_POLICY_TIMEOUT_MS = 10000

export const createRLWeightsClient = (http: HttpClient): RLWeightsClient => ({
  getCheckpointWeights: (name) =>
    http.get<CheckpointWeightsResponse>(`/rl/checkpoints/${encodeURIComponent(name)}/weights`, {
      timeoutMs: RL_WEIGHTS_TIMEOUT_MS,
    }),
  getGridPolicy: () =>
    http.get<GridPolicyResponse>('/rl/signal/grid-policy', { timeoutMs: GRID_POLICY_TIMEOUT_MS }),
})
