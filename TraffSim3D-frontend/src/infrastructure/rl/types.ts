// src/infrastructure/rl/types.ts
//
// Plan 049: shared types for in-browser PPO policy replay.
//
// A `PolicyWeights` is the JSON shape returned by the backend
// `GET /api/v1/rl/checkpoints/{name}/weights` endpoint — a flattened
// view of the SB3 PPO `policy.state_dict()` plus architecture metadata.

export interface PolicyWeights {
  /** Source checkpoint filename, e.g. "ppo_step_0005000.zip". */
  name: string
  /** Input observation dimension reported by the checkpoint (14 for current sims). */
  obs_dim: number
  /** Action dimension. Defaults to 2 (accel, steer). */
  action_dim: number
  /**
   * The checkpoint's action space (Plan 074).
   *
   * - `"discrete"` — the policy emits action *logits*; use
   *   `mlpForwardDiscrete` to get the action index.
   * - `"continuous"` — the policy emits a Gaussian mean; use
   *   `mlpForwardMean`.
   *
   * **Absent ⇒ treated as `"continuous"**, so the weights exported before
   * Plan 074 (and the committed fixtures) keep working unchanged.
   */
  action_space?: 'discrete' | 'continuous'
  /** Sizes of the two hidden layers. Defaults to [64, 64]. */
  hidden_sizes: number[]
  /** All layer parameters, flattened to nested lists. */
  layers: {
    'policy_net.0.weight': number[][] // [hidden[0]][obs_dim]
    'policy_net.0.bias': number[] // [hidden[0]]
    'policy_net.2.weight': number[][] // [hidden[1]][hidden[0]]
    'policy_net.2.bias': number[] // [hidden[1]]
    'action_net.weight': number[][] // [action_dim][hidden[-1]]
    'action_net.bias': number[] // [action_dim]
    /**
     * Diagonal Gaussian log-std, learnable parameter (action_dim,).
     *
     * **Continuous (Box) policies only.** A discrete policy has no such
     * parameter — SB3's `CategoricalPolicy` produces logits — so the key
     * is absent for a discrete export.
     */
    log_std?: number[]
  }
}

/** A single (accel, steer) action sampled from a diagonal Gaussian. */
export type PolicyAction = [number, number]
