// src/infrastructure/api/rlWeightsClient.ts
//
// Plan 049: fetch a saved PPO checkpoint's weights as JSON.
//
// The backend (`app/apps/rl/weights.py`) loads an SB3 .zip, extracts
// the policy `state_dict()`, and returns architecture metadata plus
// nested lists of weights / biases / log_std. The frontend uses this
// to instantiate an in-browser MlpPolicy for replay.

import type { HttpClient } from './httpClient';
import type { PolicyWeights } from '@infrastructure/rl/types';

export interface CheckpointWeightsResponse extends PolicyWeights {
  name: string;
  obs_dim: number;
  action_dim: number;
  hidden_sizes: number[];
  layers: PolicyWeights['layers'];
}

export interface RLWeightsClient {
  /** GET /rl/checkpoints/{name}/weights → JSON weights + architecture.
   *  Throws BackendError(404) when the checkpoint doesn't exist or
   *  BackendError(503) when SB3 isn't installed on the backend. */
  getCheckpointWeights(name: string): Promise<CheckpointWeightsResponse>;
}

export const createRLWeightsClient = (http: HttpClient): RLWeightsClient => ({
  getCheckpointWeights: (name) =>
    http.get<CheckpointWeightsResponse>(
      `/rl/checkpoints/${encodeURIComponent(name)}/weights`,
    ),
});