"""Plan 074 (T5): the training entry point for the traffic-signal agent.

The signal agent learns in `signal_env.SignalEnv` — a Gymnasium env with a
`Discrete(5)` action space (the index is the position in
`sim_core.SIGNAL_ACTION_NAMES`) and the six-dimensional observation of
Plan 074 §2 D1. The reward is the **total delay** (D2): the negative area
under the two axes' queue-length curves.

This module reuses the ego agent's machinery instead of inventing a parallel
one:

- the **status file** (`app/apps/rl/status.py`) — the same document the API's
  `GET /rl/status` serves and the AI Playground renders;
- the **control channel** (`app/apps/rl/control.py`) — pause / resume /
  terminate, through the shared gate in `train.py`;
- the **checkpoint paths** (`app/apps/rl/paths.py`) — under
  `<backend>/.data/ppo_checkpoints/pid<pid>/`, never `/tmp`;
- the **checkpoint format** (`app/apps/rl/checkpoint.py`) — the same
  `ppo_step_XXXXXXX.zip` SB3 archive the API lists and exports.

What is specific to the signal agent: the env, the *discrete* policy, and the
evaluation. A signal checkpoint is told apart from an ego checkpoint by its
**exported weights** (`action_space == "discrete"`, `action_dim == 5`) — the
archive format itself is deliberately unchanged, so the API's checkpoint
listing keeps working.

THE GATE — the trained policy must beat the fixed cycle
--------------------------------------------------------
The fixed 30/30 cycle (`no_op` on every step) is the baseline a trained
policy has to beat: on the 600-step horizon it scores **-423.1**
(Plan 074 T9). `evaluate_policy` measures the trained policy the same way —
deterministic argmax, the same env, the same horizon — so the two numbers
are comparable and not a comparison of two different measurement setups.

MEASURED (2026-10-21, seed 0, 300 k steps, ~20 min on one CPU core):

    fixed 30/30 (no_op)          -423.1
    trained signal policy         **-399.9**   (23.2 better, 5.5 %)
    trained action mix            no_op 358 / shorten_red 242 (of 600)

The trained policy's mix is the rule the measurements predicted: shorten the
green while it is still young, which lets the busier axis get its green
earlier. A brute-force search over that rule family (`.data` scratch script)
puts the best reachable return at **-399.9** — the policy found the optimum
of that family, not merely "better than the baseline".

**Seed sensitivity**: the recipe is not seed-proof. Measured over four
seeds (300 k steps each): seed 0 → **-399.9**, seed 1 → -423.1 (its action
distribution collapsed onto `no_op` before the conditional rule was found),
seed 2 → **-399.9**, seed 3 → -423.1 (same collapse). So **2 of 4 seeds**
beat the baseline, and the two that did both landed on the *same* optimum
(-399.9). The run therefore keeps the **best** checkpoint it measured
rather than the last one, and the status file records the best return and
the step it came from.

Usage (from `TraffSim3D-backend/`):

    .\\.venv\\Scripts\\python.exe -m app.apps.rl.signal_train 300000
    .\\.venv\\Scripts\\python.exe -m app.apps.rl.signal_train --baselines
    .\\.venv\\Scripts\\python.exe -m app.apps.rl.signal_train --eval <checkpoint.zip>
"""

from __future__ import annotations

import argparse
import copy
from pathlib import Path
from typing import Any

from .sim_core import SIGNAL_ACTION_NAMES

#: The evaluation horizon: 600 sim steps at the 10 Hz clock = 60 s of wall
#: clock. The fixed-schedule baselines of Plan 074 T9 were measured on this
#: horizon, so the trained policy has to be scored on it too.
EVAL_STEPS = 600

#: The seed the baselines were measured with. The sim itself is fully
#: deterministic (no randomness anywhere in `sim_core.py`), so the seed only
#: pins the starting state.
EVAL_SEED = 0

#: `no_op` — the fixed 30/30 cycle, the baseline a trained policy must beat.
NO_OP_INDEX = SIGNAL_ACTION_NAMES.index("no_op")

#: How many episodes a policy is evaluated over. The env is deterministic,
#: so the episodes agree — the number is there to make that explicit rather
#: than to average noise.
EVAL_EPISODES = 3

#: The initial **action prior** written into the policy's action-layer bias.
#:
#: Why it exists — the "all-red cliff". `preempt` and `force_all_red` are
#: catastrophic *and sticky*: one sampled all-red re-arms `ALL_RED_STEPS`
#: (3 s) of clearance, so with a uniform initial policy **every** training
#: episode lands in the all-red mode, every episode scores the same, and
#: PPO has no variance to learn from — measured: the action distribution
#: stayed at ~0.2 per action for 60 k steps.
#:
#: The prior puts the policy on the safe default (`no_op`) and away from the
#: two actions that gridlock the intersection. It is an **initialisation**,
#: not a change to the MDP: the action space, the reward, the traffic model
#: and the signal semantics are untouched, and nothing stops the agent from
#: moving the bias back if the data says so.
ACTION_PRIOR_BIAS: dict[str, float] = {
    "no_op": 3.0,
    "preempt": -3.0,
    "force_all_red": -3.0,
}

#: The discount factor the run uses by default.
#:
#: `gamma` is not a free knob here — it decides whether the **value
#: function** can be learned at all. The episode is truncated at
#: `max_steps`, and the observation does not say how much of the episode is
#: left, so a long discount horizon makes `V(s)` time-dependent and
#: therefore unrepresentable by the 6-dimensional observation: measured
#: `explained_variance` = **0.001** at `gamma = 0.999` (the policy gradient
#: then has nothing to follow — the action distribution stayed at ~0.2 per
#: action for 60 k steps) versus **0.80 – 0.84** at `gamma = 0.995`.
#:
#: 0.995 still discounts over ~20 s — long enough to see the effect of a
#: phase change, short enough that the truncation is a 5 % correction.
DEFAULT_GAMMA = 0.995

#: PPO's GAE trace-decay — the window the advantage looks back over.
#:
#: PPO's default of 0.95 is kept: measured, it is the value that lets the
#: policy find the delayed payoff. The Monte-Carlo variant (`lambda = 1.0`)
#: was tried and made the action distribution **collapse harder** (at 90 k
#: steps it was already at `p(no_op) = 0.991`, against 0.88 at the same
#: point with 0.95) — the higher-variance advantage drives the policy onto
#: the safe default before the conditional rule can be found.
DEFAULT_GAE_LAMBDA = 0.95


def make_env(max_steps: int = EVAL_STEPS) -> Any:
    """A fresh `SignalEnv` on the horizon the baselines were measured on."""
    from .signal_env import SignalEnv

    return SignalEnv(max_steps=max_steps)


def _run_episode(env: Any, action_for: Any, seed: int) -> dict[str, Any]:
    """Run one episode, returning its return and the action histogram.

    `action_for(obs)` returns the action index to apply. It is a callable so
    the same driver serves both the constant schedules (a constant index) and
    a trained policy (argmax over the logits).
    """
    obs, _ = env.reset(seed=seed)
    total = 0.0
    steps = 0
    histogram: dict[str, int] = {}
    masked = 0
    while True:
        action = int(action_for(obs))
        obs, reward, terminated, truncated, info = env.step(action)
        total += float(reward)
        steps += 1
        name = str(info.get("action", SIGNAL_ACTION_NAMES[action]))
        histogram[name] = histogram.get(name, 0) + 1
        if info.get("masked"):
            masked += 1
        if terminated or truncated:
            break
    return {
        "return": total,
        "steps": steps,
        "actions": histogram,
        "masked_actions": masked,
    }


def evaluate_schedule(
    action_index: int,
    *,
    steps: int = EVAL_STEPS,
    seed: int = EVAL_SEED,
) -> dict[str, Any]:
    """Score a **constant-action** schedule — e.g. the fixed 30/30 cycle.

    This is the baseline the trained policy is compared against. `no_op` on
    every step is the plain 30/30 cycle; the other four actions give the
    degenerate schedules Plan 074 T9 measured (flicker / starve / preempt).
    """
    env = make_env(steps)
    result = _run_episode(env, lambda _obs: action_index, seed)
    result["action"] = SIGNAL_ACTION_NAMES[action_index]
    return result


def evaluate_policy(
    policy: Any,
    *,
    steps: int = EVAL_STEPS,
    seed: int = EVAL_SEED,
    episodes: int = EVAL_EPISODES,
) -> dict[str, Any]:
    """Score a **trained policy** deterministically (argmax) on the env.

    `policy` is anything with SB3's `predict(obs, deterministic=True)`
    signature — a live `PPO` model or a loaded checkpoint's model.
    """
    env = make_env(steps)
    returns: list[float] = []
    histogram: dict[str, int] = {}
    masked = 0
    for episode in range(episodes):
        result = _run_episode(
            env,
            lambda obs: int(policy.predict(obs, deterministic=True)[0]),
            seed + episode,
        )
        returns.append(result["return"])
        for name, count in result["actions"].items():
            histogram[name] = histogram.get(name, 0) + count
        masked += result["masked_actions"]
    mean = sum(returns) / len(returns) if returns else 0.0
    return {
        "return": mean,
        "returns": returns,
        "episodes": episodes,
        "actions": histogram,
        "masked_actions": masked,
    }


def _apply_action_prior(model: Any) -> None:
    """Write the initial action prior into the policy's action-layer bias.

    See `ACTION_PRIOR_BIAS` for why the prior exists. The bias is the
    policy's *initial* preference; PPO is free to move it.
    """
    import torch

    with torch.no_grad():
        bias = model.policy.action_net.bias
        bias[:] = 0.0
        for name, value in ACTION_PRIOR_BIAS.items():
            bias[SIGNAL_ACTION_NAMES.index(name)] = value


def train_signal_policy(
    total_steps: int,
    *,
    device: str = "cpu",
    save_every: int = 10_000,
    max_steps: int = EVAL_STEPS,
    seed: int = EVAL_SEED,
    learning_rate: float = 3e-4,
    gamma: float = DEFAULT_GAMMA,
    gae_lambda: float = DEFAULT_GAE_LAMBDA,
    ent_coef: float = 0.0,
    n_steps: int = 2048,
    batch_size: int = 64,
    eval_every: int = 10_000,
) -> dict[str, Any]:
    """Train the signal policy with SB3 PPO and return the run's summary.

    The run writes the same status document the ego trainer writes, honours
    the same pause / resume / terminate channel, and saves checkpoints through
    the same `checkpoint.save_checkpoint` — so the API, the checkpoint list
    and the weights export all work unchanged.

    The run is **chunked**: every `eval_every` steps the deterministic
    policy is scored on the training env and the best-scoring policy state
    is kept. The checkpoint the run leaves behind is that best one — a
    PPO run on this env is not monotone (the policy can fall back into the
    all-red mode), so "the last checkpoint" is not necessarily "the best
    policy", and the browser runs the **argmax**, which is what the
    evaluation measures.
    """
    from . import capabilities as caps
    from . import checkpoint as ckpt
    from . import control as ctl
    from . import status as st
    from . import train

    resolved_device, reason = caps.resolve_device(device)

    # A fresh run starts with no outstanding pause / terminate request.
    ctl.clear_control()
    st.init_status(total_steps)
    s = st.read_status()
    s["device"] = resolved_device
    s["device_reason"] = reason
    s["scene_kind"] = "cross"
    # The signal agent is a *different* agent from the ego policy: it has its
    # own observation width and a discrete action space. The flag lets the UI
    # (and any consumer of the status file) tell the two apart.
    s["policy_kind"] = "signal"
    s["action_space"] = "discrete"
    s["action_dim"] = len(SIGNAL_ACTION_NAMES)
    s["obs_dim"] = 6
    s["latest_checkpoint"] = ""
    st.write_status(s)

    if resolved_device == "dry_run":
        st.append_reward(0.0)
        s = st.read_status()
        s["latest_checkpoint"] = "dry_run_fallback"
        st.write_status(s)
        st.finalize_status(f"dry_run_fallback ({reason})")
        return {"trained": False, "reason": reason}

    from stable_baselines3 import PPO

    env = make_env(max_steps)
    model = PPO(
        "MlpPolicy",
        env,
        verbose=0,
        device=resolved_device,
        seed=seed,
        learning_rate=learning_rate,
        gamma=gamma,
        gae_lambda=gae_lambda,
        ent_coef=ent_coef,
        n_steps=n_steps,
        batch_size=batch_size,
    )
    _apply_action_prior(model)

    checkpoints: list[str] = []

    def _save_and_record(m: Any, step: int) -> None:
        path = ckpt.save_checkpoint(m, step)
        checkpoints.append(path.name)
        ss = st.read_status()
        ss["latest_checkpoint"] = ", ".join(checkpoints[-4:])
        ss["step"] = step
        st.write_status(ss)

    def on_step(_locals: dict[str, Any], _globals: dict[str, Any]) -> bool:
        # The **shared** control gate (the ego trainer's) — pause blocks
        # inside the callback, terminate ends the rollout.
        if train._control_gate()[0]:
            st.finalize_status("terminated_by_request")
            return False
        step = int(_locals["self"].num_timesteps)
        if save_every > 0 and step % save_every == 0 and step > 0:
            _save_and_record(_locals["self"], step)
        if step % 200 == 0:
            ep_buf = _locals["self"].ep_info_buffer
            if ep_buf:
                st.append_reward(float(ep_buf[-1]["r"]))
        return True

    best_return: float | None = None
    best_step = 0
    best_state: dict[str, Any] | None = None
    best_actions: dict[str, int] = {}

    chunk = max(eval_every, n_steps) if eval_every > 0 else total_steps
    trained = 0
    while trained < total_steps:
        budget = min(chunk, total_steps - trained)
        model.learn(
            total_timesteps=budget,
            callback=on_step,
            reset_num_timesteps=False,
        )
        trained += budget
        if st.read_status().get("running") is False:
            # A terminate request stopped SB3 early — don't relabel it.
            return {"trained": False, "reason": "terminated_by_request"}
        if eval_every <= 0:
            continue
        scored = evaluate_policy(model, steps=max_steps, seed=seed, episodes=1)
        ss = st.read_status()
        ss["signal_eval_return"] = scored["return"]
        ss["signal_eval_step"] = trained
        ss["signal_eval_actions"] = scored["actions"]
        st.write_status(ss)
        if best_return is None or scored["return"] > best_return:
            best_return = scored["return"]
            best_step = trained
            best_actions = scored["actions"]
            best_state = copy.deepcopy(model.policy.state_dict())

    if best_state is not None:
        # Leave the *best* policy behind, not merely the last one.
        model.policy.load_state_dict(best_state)
    final_path = ckpt.save_checkpoint(model, best_step or total_steps)
    s = st.read_status()
    s["latest_checkpoint"] = final_path.name
    s["best_checkpoint"] = final_path.name
    s["best_return"] = best_return
    s["best_step"] = best_step
    s["baseline_no_op_return"] = evaluate_schedule(NO_OP_INDEX, steps=max_steps)["return"]
    st.write_status(s)
    st.finalize_status(f"signal_ppo_completed on {resolved_device}")

    evaluation = evaluate_policy(model, steps=max_steps, seed=seed)
    return {
        "trained": True,
        "checkpoint": str(final_path),
        "best_checkpoint": str(final_path),
        "best_step": best_step,
        "best_return": best_return,
        "best_actions": best_actions,
        "baseline_return": s["baseline_no_op_return"],
        "device": resolved_device,
        "evaluation": evaluation,
    }


def _print_baselines(steps: int = EVAL_STEPS) -> dict[str, Any]:
    """Measure every constant-action schedule (the fixed-cycle baseline)."""
    results: dict[str, Any] = {}
    for index, name in enumerate(SIGNAL_ACTION_NAMES):
        result = evaluate_schedule(index, steps=steps)
        results[name] = result
        print(f"{name:>14}  return {result['return']:9.1f}  steps {result['steps']}")
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the traffic-signal policy (Plan 074 T5).")
    parser.add_argument("steps", nargs="?", type=int, default=200_000)
    parser.add_argument("--device", choices=["auto", "gpu", "cpu"], default="cpu")
    parser.add_argument("--save-every", type=int, default=10_000)
    parser.add_argument("--max-steps", type=int, default=EVAL_STEPS)
    parser.add_argument("--seed", type=int, default=EVAL_SEED)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--gamma", type=float, default=DEFAULT_GAMMA)
    parser.add_argument("--gae-lambda", type=float, default=DEFAULT_GAE_LAMBDA)
    parser.add_argument("--ent-coef", type=float, default=0.0)
    parser.add_argument(
        "--eval-every",
        type=int,
        default=10_000,
        help="Evaluate the deterministic policy every N steps; the best one is kept.",
    )
    parser.add_argument(
        "--baselines",
        action="store_true",
        help="Measure the constant-action schedules and exit (no training).",
    )
    parser.add_argument(
        "--eval",
        type=str,
        default="",
        help="Evaluate an existing checkpoint and exit (no training).",
    )
    args = parser.parse_args()

    if args.baselines:
        _print_baselines(args.max_steps)
        return

    if args.eval:
        from stable_baselines3 import PPO

        from .weights import export_weights

        path = Path(args.eval)
        weights = export_weights(path)
        print(
            f"checkpoint {path.name}: action_dim={weights['action_dim']} "
            f"action_space={weights['action_space']}"
        )
        model = PPO.load(str(path), device="cpu")
        result = evaluate_policy(model, steps=args.max_steps, seed=args.seed)
        print(f"return {result['return']:.1f}  (episodes {result['returns']})")
        print(f"actions {result['actions']}")
        return

    summary = train_signal_policy(
        args.steps,
        device=args.device,
        save_every=args.save_every,
        max_steps=args.max_steps,
        seed=args.seed,
        learning_rate=args.learning_rate,
        gamma=args.gamma,
        gae_lambda=args.gae_lambda,
        ent_coef=args.ent_coef,
        eval_every=args.eval_every,
    )
    if not summary.get("trained"):
        print(f"not trained: {summary.get('reason')}")
        return
    evaluation = summary["evaluation"]
    print(f"checkpoint {summary['checkpoint']}")
    print(f"best return {summary.get('best_return')} at step {summary.get('best_step')}")
    print(f"baseline (fixed 30/30) {summary.get('baseline_return')}")
    print(f"best actions {summary.get('best_actions')}")
    print(f"return {evaluation['return']:.1f}  (episodes {evaluation['returns']})")
    print(f"actions {evaluation['actions']}")


if __name__ == "__main__":
    main()
