"""Plan 074 (T5 + T10): the training entry point for the traffic-signal agent.

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

What is specific to the signal agent: the env, the *discrete* policy, and
the evaluation. A signal checkpoint is told apart from an ego checkpoint by its
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

T10 — MULTIPLE SEEDS, BEST OF N
-------------------------------
Plan 074 T10 turns "a lucky seed" into a procedure: `train_signal_seeds`
trains several seeds and keeps the one with the best **measured**
evaluation return. Every seed's number is recorded — in the run metadata,
in the status document and in the CLI output — so a seed that collapsed
onto the baseline is reported, never hidden.

**The evaluation set is separate from the training set.** This is what makes
the selection a measurement instead of self-deception:

- the policy is **trained** on `signal_conditions.TRAIN_CONDITION` (the
  dense scenario of Plan 074 T9, unchanged);
- it is **scored** on `signal_conditions.EVAL_CONDITION` — more demand, a
  different headway and a different signal offset, i.e. a genuinely
  different initial condition. A different RNG seed would NOT do: the sim
  is deterministic, so a different seed changes nothing;
- the winner is finally reported on `signal_conditions.HOLDOUT_CONDITION`,
  a third condition that never selects anything — the honest number.

Within a single seed, the best *checkpoint* is still chosen on the training
condition (that is the usual "keep the best checkpoint of the run" rule);
the held-out condition is only spent on the cross-seed selection.

Usage (from `TraffSim3D-backend/`):

    .\\.venv\\Scripts\\python.exe -m app.apps.rl.signal_train 300000
    .\\.venv\\Scripts\\python.exe -m app.apps.rl.signal_train --seeds 0,1,2,3
    .\\.venv\\Scripts\\python.exe -m app.apps.rl.signal_train --seeds 0,1,2,3 --workers 4
    .\\.venv\\Scripts\\python.exe -m app.apps.rl.signal_train --baselines
    .\\.venv\\Scripts\\python.exe -m app.apps.rl.signal_train --eval <checkpoint.zip>
"""

from __future__ import annotations

import argparse
import copy
import json
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from .signal_conditions import (
    EVAL_CONDITION,
    HOLDOUT_CONDITION,
    TRAIN_CONDITION,
    TrafficCondition,
)
from .sim_core import SIGNAL_ACTION_NAMES

#: The evaluation horizon: 600 sim steps at the 10 Hz clock = 60 s of wall
#: clock. The fixed-schedule baselines of Plan 074 T9 were measured on this
#: horizon, so the trained policy has to be scored on it too.
EVAL_STEPS = 600

#: The seed the baselines were measured with. The sim itself is fully
#: deterministic (no randomness anywhere in `sim_core.py`), so the seed only
#: pins the starting state.
EVAL_SEED = 0

#: The seed of the **evaluation** episodes (Plan 074 T10).
#:
#: The sim is deterministic, so this seed changes nothing about the
#: episodes — the separation between the training set and the evaluation
#: set comes from the *condition* (`signal_conditions.EVAL_CONDITION`),
#: not from the seed. The seed is still a different one, so the record
#: says which episodes were scored.
EVAL_CONDITION_SEED = 1000

#: `no_op` — the fixed 30/30 cycle, the baseline a trained policy must beat.
NO_OP_INDEX = SIGNAL_ACTION_NAMES.index("no_op")

#: How many episodes a policy is evaluated over. The env is deterministic,
#: so the episodes agree — the number is there to make that explicit rather
#: than to average noise.
EVAL_EPISODES = 3

#: The seeds a multi-seed run trains by default — the four Plan 074 S3b
#: measured (two of them beat the baseline, two collapsed onto it).
DEFAULT_SEEDS: tuple[int, ...] = (0, 1, 2, 3)

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


def make_env(max_steps: int = EVAL_STEPS, condition: TrafficCondition = TRAIN_CONDITION) -> Any:
    """A fresh `SignalEnv` on the horizon the baselines were measured on.

    `condition` selects the scene's initial condition (Plan 074 T10): the
    training condition by default, the held-out evaluation condition when
    the policy is scored.
    """
    from .signal_env import SignalEnv

    return SignalEnv(max_steps=max_steps, condition=condition)


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
    condition: TrafficCondition = TRAIN_CONDITION,
) -> dict[str, Any]:
    """Score a **constant-action** schedule — e.g. the fixed 30/30 cycle.

    This is the baseline the trained policy is compared against. `no_op` on
    every step is the plain 30/30 cycle; the other four actions give the
    degenerate schedules Plan 074 T9 measured (flicker / starve / preempt).

    The baseline has to be measured on the **same condition** as the policy
    it is compared against — the numbers of two different conditions are not
    comparable.
    """
    env = make_env(steps, condition)
    result = _run_episode(env, lambda _obs: action_index, seed)
    result["action"] = SIGNAL_ACTION_NAMES[action_index]
    result["condition"] = condition.name
    return result


def evaluate_policy(
    policy: Any,
    *,
    steps: int = EVAL_STEPS,
    seed: int = EVAL_SEED,
    episodes: int = EVAL_EPISODES,
    condition: TrafficCondition = TRAIN_CONDITION,
) -> dict[str, Any]:
    """Score a **trained policy** deterministically (argmax) on the env.

    `policy` is anything with SB3's `predict(obs, deterministic=True)`
    signature — a live `PPO` model or a loaded checkpoint's model.
    """
    env = make_env(steps, condition)
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
        "condition": condition.name,
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
    own_status: bool = True,
    checkpoint_prefix: str = "",
    eval_baseline: float | None = None,
    train_baseline: float | None = None,
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

    Plan 074 T10 adds three things:

    - the policy is **also** scored on the held-out evaluation condition
      (`signal_conditions.EVAL_CONDITION`), and the summary says whether it
      beat the fixed cycle *there*;
    - `own_status=False` lets a caller (the multi-seed run) own the status
      document — the seed's run then touches nothing, so parallel seeds
      cannot race on it;
    - `checkpoint_prefix` saves the run's final policy under an explicit
      name (a multi-seed run keeps one file per seed).
    """
    from . import capabilities as caps
    from . import checkpoint as ckpt
    from . import control as ctl
    from . import status as st
    from . import train

    resolved_device, reason = caps.resolve_device(device)

    if own_status:
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
        s["seed"] = seed
        st.write_status(s)

    if resolved_device == "dry_run":
        if own_status:
            st.append_reward(0.0)
            s = st.read_status()
            s["latest_checkpoint"] = "dry_run_fallback"
            st.write_status(s)
            st.finalize_status(f"dry_run_fallback ({reason})")
        return {"trained": False, "reason": reason, "seed": seed}

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
    terminated = False

    def _save_and_record(m: Any, step: int) -> None:
        path = ckpt.save_checkpoint(m, step)
        checkpoints.append(path.name)
        if not own_status:
            return
        ss = st.read_status()
        ss["latest_checkpoint"] = ", ".join(checkpoints[-4:])
        ss["step"] = step
        st.write_status(ss)

    def on_step(_locals: dict[str, Any], _globals: dict[str, Any]) -> bool:
        # The **shared** control gate (the ego trainer's) — pause blocks
        # inside the callback, terminate ends the rollout.
        nonlocal terminated
        if train._control_gate()[0]:
            terminated = True
            if own_status:
                st.finalize_status("terminated_by_request")
            return False
        step = int(_locals["self"].num_timesteps)
        if save_every > 0 and step % save_every == 0 and step > 0:
            _save_and_record(_locals["self"], step)
        if own_status and step % 200 == 0:
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
        if terminated:
            # A terminate request stopped SB3 early — don't relabel it.
            return {"trained": False, "reason": "terminated_by_request", "seed": seed}
        if eval_every <= 0:
            continue
        scored = evaluate_policy(model, steps=max_steps, seed=seed, episodes=1)
        if own_status:
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
    if checkpoint_prefix:
        final_path = ckpt.save_named_checkpoint(
            model, f"{checkpoint_prefix}_step_{best_step or total_steps:07d}.zip"
        )
    else:
        final_path = ckpt.save_checkpoint(model, best_step or total_steps)

    # Plan 074 T10: score the policy on the **held-out** condition. The
    # number that decides which seed wins is measured here — never on the
    # episodes the policy was trained on.
    eval_result = evaluate_policy(
        model,
        steps=max_steps,
        seed=EVAL_CONDITION_SEED,
        episodes=1,
        condition=EVAL_CONDITION,
    )
    if eval_baseline is None:
        eval_baseline = evaluate_schedule(
            NO_OP_INDEX,
            steps=max_steps,
            seed=EVAL_CONDITION_SEED,
            condition=EVAL_CONDITION,
        )["return"]
    if train_baseline is None:
        # The published T9 baseline: the fixed 30/30 cycle on the
        # **training** condition (-423.1 over 600 steps).
        train_baseline = evaluate_schedule(NO_OP_INDEX, steps=max_steps)["return"]

    if own_status:
        s = st.read_status()
        s["latest_checkpoint"] = final_path.name
        s["best_checkpoint"] = final_path.name
        s["best_return"] = best_return
        s["best_step"] = best_step
        s["baseline_no_op_return"] = train_baseline
        s["signal_eval_condition_return"] = eval_result["return"]
        s["signal_eval_condition_baseline"] = eval_baseline
        st.write_status(s)
        st.finalize_status(f"signal_ppo_completed on {resolved_device}")

    evaluation = evaluate_policy(model, steps=max_steps, seed=seed)
    return {
        "trained": True,
        "seed": seed,
        "checkpoint": str(final_path),
        "best_checkpoint": str(final_path),
        "best_step": best_step,
        "best_return": best_return,
        "best_actions": best_actions,
        "baseline_return": train_baseline,
        "eval_baseline": eval_baseline,
        "eval_return": eval_result["return"],
        "eval_actions": eval_result["actions"],
        "beats_baseline": bool(eval_result["return"] > eval_baseline),
        "beats_train_baseline": bool(best_return is not None and best_return > train_baseline),
        "device": resolved_device,
        "evaluation": evaluation,
    }


def select_best_seed(
    records: Sequence[dict[str, Any]], *, key: str = "eval_return"
) -> dict[str, Any]:
    """The candidate with the highest measured return (Plan 074 T10).

    The selection is made on the **evaluation** condition — a condition the
    policy was not trained on — so the winner is not simply the seed that
    memorised its training episodes.

    Ties go to the **earlier** candidate, so the selection is deterministic
    and does not depend on the order the seeds happened to finish in.
    """
    if not records:
        raise ValueError("no seed results to select from")
    best = records[0]
    for record in records[1:]:
        if float(record[key]) > float(best[key]):
            best = record
    return best


def _seed_record(summary: dict[str, Any]) -> dict[str, Any]:
    """The per-seed record of a training run (JSON-friendly).

    Every seed gets one — including the seeds that collapsed onto the
    baseline. The record is what the run metadata, the status document and
    the CLI output all report.
    """
    return {
        "seed": int(summary["seed"]),
        "train_return": float(summary["best_return"]),
        "train_actions": dict(summary["best_actions"]),
        "beats_train_baseline": bool(summary["beats_train_baseline"]),
        "eval_return": float(summary["eval_return"]),
        "eval_actions": dict(summary["eval_actions"]),
        "beats_baseline": bool(summary["beats_baseline"]),
        "best_step": int(summary["best_step"]),
        "checkpoint": str(summary["checkpoint"]),
    }


def _write_run_metadata(metadata: dict[str, Any]) -> Path:
    """Write the run's metadata next to the RL runtime state.

    The artefact (the winning checkpoint) has to say **how** it was won,
    and a failed seed must not be hidden: the per-seed results live here,
    in the status document and in the CLI output.
    """
    from . import paths as rl_paths

    path = rl_paths.data_root() / "signal_training_run.json"
    path.write_text(json.dumps(metadata, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def _train_seed_worker(payload: dict[str, Any]) -> dict[str, Any]:
    """Train one seed in a **worker process** (Plan 074 T10).

    Module level so that `ProcessPoolExecutor` can pickle it: on Windows a
    worker is a fresh interpreter that re-imports this module. The worker
    does not touch the status document (the parent owns it) and keeps its
    checkpoint in its own per-process directory.
    """
    import torch

    # One thread per worker: the policy is a 6-64-64-5 MLP, so the matrix
    # multiplies are tiny — several workers would only oversubscribe the
    # CPU and slow the whole run down.
    torch.set_num_threads(1)
    summary = train_signal_policy(
        payload["total_steps"],
        device=payload["device"],
        save_every=payload["save_every"],
        max_steps=payload["max_steps"],
        seed=payload["seed"],
        learning_rate=payload["learning_rate"],
        gamma=payload["gamma"],
        gae_lambda=payload["gae_lambda"],
        ent_coef=payload["ent_coef"],
        n_steps=payload["n_steps"],
        batch_size=payload["batch_size"],
        eval_every=payload["eval_every"],
        own_status=False,
        checkpoint_prefix=f"signal_seed{payload['seed']}",
        eval_baseline=payload["eval_baseline"],
        train_baseline=payload["train_baseline"],
    )
    if not summary.get("trained"):
        # The run was interrupted (a terminate request) — hand the reason
        # back instead of a half-filled record.
        return summary
    return _seed_record(summary)


def _publish_winner(winner: dict[str, Any]) -> Path:
    """Re-save the winning policy under the standard checkpoint name.

    Every seed's policy is kept under a seed-specific name; the winner is
    additionally saved as `ppo_step_<n>.zip` so that the API's checkpoint
    list and the weights export see it like any other checkpoint.
    """
    from stable_baselines3 import PPO

    from . import checkpoint as ckpt

    source = Path(winner["checkpoint"])
    model = PPO.load(str(source), device="cpu")
    return ckpt.save_checkpoint(model, int(winner["best_step"]))


def train_signal_seeds(
    total_steps: int,
    seeds: Sequence[int] = DEFAULT_SEEDS,
    *,
    device: str = "cpu",
    save_every: int = 10_000,
    max_steps: int = EVAL_STEPS,
    learning_rate: float = 3e-4,
    gamma: float = DEFAULT_GAMMA,
    gae_lambda: float = DEFAULT_GAE_LAMBDA,
    ent_coef: float = 0.0,
    n_steps: int = 2048,
    batch_size: int = 64,
    eval_every: int = 10_000,
    workers: int = 1,
) -> dict[str, Any]:
    """Train several seeds and keep the best one (Plan 074 T10).

    The recipe of Plan 074 S3b is not seed-proof: of the four seeds that
    were measured, two beat the fixed cycle and two collapsed back onto it.
    This function makes the outcome a procedure instead of a lucky draw:
    every seed is trained, every seed is **scored on the held-out
    evaluation condition**, and the seed with the best measured return is
    the one that is kept.

    Every seed's result is recorded — in the returned summary, in the run
    metadata (`<backend>/.data/signal_training_run.json`) and in the status
    document. A seed that collapsed onto the baseline is reported as such;
    it is never hidden.

    `workers > 1` trains the seeds in parallel processes (one seed per
    process). The seeds are independent, and each worker keeps its
    checkpoint in its own directory, so nothing is shared but the CPU.
    """
    from . import capabilities as caps
    from . import control as ctl
    from . import status as st

    seed_list = [int(s) for s in seeds]
    if not seed_list:
        raise ValueError("no seeds to train")

    resolved_device, reason = caps.resolve_device(device)
    if resolved_device == "dry_run":
        summary = train_signal_policy(total_steps, device=device, own_status=True)
        summary["seeds"] = seed_list
        return summary

    ctl.clear_control()
    st.init_status(total_steps * len(seed_list))
    s = st.read_status()
    s["device"] = resolved_device
    s["device_reason"] = reason
    s["scene_kind"] = "cross"
    s["policy_kind"] = "signal"
    s["action_space"] = "discrete"
    s["action_dim"] = len(SIGNAL_ACTION_NAMES)
    s["obs_dim"] = 6
    s["latest_checkpoint"] = ""
    s["signal_seeds"] = seed_list
    s["signal_seed_count"] = len(seed_list)
    st.write_status(s)

    # The fixed cycle on every condition — the bar a policy has to clear
    # **on that very condition**.
    baselines = {
        condition.name: evaluate_schedule(
            NO_OP_INDEX,
            steps=max_steps,
            seed=EVAL_CONDITION_SEED,
            condition=condition,
        )["return"]
        for condition in (TRAIN_CONDITION, EVAL_CONDITION, HOLDOUT_CONDITION)
    }

    records: list[dict[str, Any]] = []
    if workers > 1 and len(seed_list) > 1:
        from concurrent.futures import ProcessPoolExecutor

        payloads = [
            {
                "total_steps": total_steps,
                "device": resolved_device,
                "save_every": save_every,
                "max_steps": max_steps,
                "seed": seed,
                "learning_rate": learning_rate,
                "gamma": gamma,
                "gae_lambda": gae_lambda,
                "ent_coef": ent_coef,
                "n_steps": n_steps,
                "batch_size": batch_size,
                "eval_every": eval_every,
                "eval_baseline": baselines[EVAL_CONDITION.name],
                "train_baseline": baselines[TRAIN_CONDITION.name],
            }
            for seed in seed_list
        ]
        with ProcessPoolExecutor(max_workers=min(workers, len(payloads))) as pool:
            results = list(pool.map(_train_seed_worker, payloads))
        for result in results:
            if "eval_return" not in result:
                # A seed that did not finish (e.g. a terminate request).
                st.finalize_status(str(result.get("reason") or "signal_ppo_failed"))
                return {
                    "trained": False,
                    "reason": result.get("reason"),
                    "seeds": seed_list,
                    "seed_results": records,
                }
            records.append(result)
    else:
        for index, seed in enumerate(seed_list):
            ss = st.read_status()
            ss["signal_seed"] = seed
            ss["signal_seed_index"] = index + 1
            st.write_status(ss)
            summary = train_signal_policy(
                total_steps,
                device=resolved_device,
                save_every=save_every,
                max_steps=max_steps,
                seed=seed,
                learning_rate=learning_rate,
                gamma=gamma,
                gae_lambda=gae_lambda,
                ent_coef=ent_coef,
                n_steps=n_steps,
                batch_size=batch_size,
                eval_every=eval_every,
                own_status=False,
                checkpoint_prefix=f"signal_seed{seed}",
                eval_baseline=baselines[EVAL_CONDITION.name],
                train_baseline=baselines[TRAIN_CONDITION.name],
            )
            if not summary.get("trained"):
                st.finalize_status(str(summary.get("reason") or "signal_ppo_failed"))
                return {
                    "trained": False,
                    "reason": summary.get("reason"),
                    "seeds": seed_list,
                    "seed_results": records,
                }
            records.append(_seed_record(summary))
            ss = st.read_status()
            ss["signal_seed_results"] = records
            st.write_status(ss)

    winner = select_best_seed(records)
    final_path = _publish_winner(winner)

    from stable_baselines3 import PPO

    model = PPO.load(str(final_path), device="cpu")
    holdout = evaluate_policy(
        model,
        steps=max_steps,
        seed=EVAL_CONDITION_SEED,
        episodes=1,
        condition=HOLDOUT_CONDITION,
    )

    metadata = {
        "generated_at_ms": int(time.time() * 1000),
        "total_steps_per_seed": total_steps,
        "seeds": seed_list,
        "best_seed": winner["seed"],
        "conditions": {
            "train": TRAIN_CONDITION.describe(),
            "eval": EVAL_CONDITION.describe(),
            "holdout": HOLDOUT_CONDITION.describe(),
        },
        "baselines": baselines,
        "per_seed": records,
        "winner": winner,
        "checkpoint": str(final_path),
        "holdout_return": holdout["return"],
        "holdout_actions": holdout["actions"],
    }
    metadata_path = _write_run_metadata(metadata)

    s = st.read_status()
    s["latest_checkpoint"] = final_path.name
    s["best_checkpoint"] = final_path.name
    s["best_return"] = winner["eval_return"]
    s["best_step"] = winner["best_step"]
    s["best_seed"] = winner["seed"]
    s["baseline_no_op_return"] = baselines[TRAIN_CONDITION.name]
    s["signal_eval_return"] = winner["eval_return"]
    s["signal_eval_baseline"] = baselines[EVAL_CONDITION.name]
    s["signal_holdout_return"] = holdout["return"]
    s["signal_seed_results"] = records
    s["signal_run_metadata"] = str(metadata_path)
    st.write_status(s)
    st.finalize_status(f"signal_ppo_completed on {resolved_device} ({len(seed_list)} seeds)")

    return {
        "trained": True,
        "seeds": seed_list,
        "seed_results": records,
        "best_seed": winner["seed"],
        "winner": winner,
        "checkpoint": str(final_path),
        "best_checkpoint": str(final_path),
        "best_step": winner["best_step"],
        "best_return": winner["eval_return"],
        "best_actions": winner["eval_actions"],
        "baseline_return": baselines[TRAIN_CONDITION.name],
        "eval_baseline": baselines[EVAL_CONDITION.name],
        "baselines": baselines,
        "holdout_return": holdout["return"],
        "holdout_actions": holdout["actions"],
        "metadata": str(metadata_path),
        "device": resolved_device,
    }


def _print_baselines(steps: int = EVAL_STEPS) -> dict[str, Any]:
    """Measure every constant-action schedule (the fixed-cycle baseline)."""
    results: dict[str, Any] = {}
    for index, name in enumerate(SIGNAL_ACTION_NAMES):
        result = evaluate_schedule(index, steps=steps)
        results[name] = result
        print(f"{name:>14}  return {result['return']:9.1f}  steps {result['steps']}")
    return results


def _print_seed_results(records: Sequence[dict[str, Any]], baselines: dict[str, float]) -> None:
    """Print every seed's measured return — the failures included.

    Two "beats baseline" columns: the one on the **training** condition
    (where the policy was fitted) and the one on the **held-out**
    evaluation condition (where it is selected). A seed can win the first
    and lose the second — that gap is the point of the separation, so it
    is printed rather than hidden.
    """
    print("")
    print("seed   train return   eval return   beats train   beats eval   best step")
    for record in records:
        print(
            f"{record['seed']:>4}   {record['train_return']:>12.1f}"
            f"   {record['eval_return']:>11.1f}"
            f"   {str(record.get('beats_train_baseline', '?')):>11}"
            f"   {str(record['beats_baseline']):>10}"
            f"   {record['best_step']:>9}"
        )
    print(
        f"fixed cycle: train {baselines.get('train', 0.0):.1f}"
        f"  eval {baselines.get('eval', 0.0):.1f}"
        f"  holdout {baselines.get('holdout', 0.0):.1f}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Train the traffic-signal policy (Plan 074 T5/T10)."
    )
    parser.add_argument("steps", nargs="?", type=int, default=200_000)
    parser.add_argument("--device", choices=["auto", "gpu", "cpu"], default="cpu")
    parser.add_argument("--save-every", type=int, default=10_000)
    parser.add_argument("--max-steps", type=int, default=EVAL_STEPS)
    parser.add_argument(
        "--seed", type=int, default=EVAL_SEED, help="The seed of a single-seed run."
    )
    parser.add_argument(
        "--seeds",
        type=str,
        default="",
        help="Comma-separated seeds of a multi-seed run, e.g. '0,1,2,3'. The best of them is kept.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=1,
        help="How many seeds to train in parallel (one process per seed).",
    )
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--gamma", type=float, default=DEFAULT_GAMMA)
    parser.add_argument("--gae-lambda", type=float, default=DEFAULT_GAE_LAMBDA)
    parser.add_argument("--ent-coef", type=float, default=0.0)
    parser.add_argument("--n-steps", type=int, default=2048, help="PPO's rollout length.")
    parser.add_argument("--batch-size", type=int, default=64, help="PPO's minibatch size.")
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
    parser.add_argument(
        "--condition",
        choices=["train", "eval", "holdout"],
        default="train",
        help="The condition the checkpoint is scored on (--eval only).",
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
        condition = {
            "train": TRAIN_CONDITION,
            "eval": EVAL_CONDITION,
            "holdout": HOLDOUT_CONDITION,
        }[args.condition]
        result = evaluate_policy(
            model,
            steps=args.max_steps,
            seed=EVAL_CONDITION_SEED,
            condition=condition,
        )
        print(
            f"condition {condition.name}  return {result['return']:.1f}  (episodes {result['returns']})"
        )
        print(f"actions {result['actions']}")
        return

    if args.seeds:
        seeds = [int(part) for part in args.seeds.replace(" ", "").split(",") if part != ""]
        summary = train_signal_seeds(
            args.steps,
            seeds,
            device=args.device,
            save_every=args.save_every,
            max_steps=args.max_steps,
            learning_rate=args.learning_rate,
            gamma=args.gamma,
            gae_lambda=args.gae_lambda,
            ent_coef=args.ent_coef,
            n_steps=args.n_steps,
            batch_size=args.batch_size,
            eval_every=args.eval_every,
            workers=args.workers,
        )
        if not summary.get("trained"):
            print(f"not trained: {summary.get('reason')}")
            return
        _print_seed_results(summary["seed_results"], summary["baselines"])
        winner = summary["winner"]
        print(
            f"best seed {summary['best_seed']}  eval return {winner['eval_return']:.1f}"
            f"  (fixed cycle on the eval condition: {summary['baselines']['eval']:.1f})"
        )
        print(f"holdout return {summary['holdout_return']:.1f} (never used for selection)")
        print(f"checkpoint {summary['checkpoint']}")
        print(f"run metadata {summary['metadata']}")
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
        n_steps=args.n_steps,
        batch_size=args.batch_size,
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
