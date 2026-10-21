"""Plan 076 (T11 follow-up): score a trained ego policy against the
constant-throttle baselines.

The signal agent's gate (`signal_train.evaluate_policy` /
`signal_train.evaluate_schedule`) is the model here: a **trained policy** is
scored deterministically (argmax / the Gaussian mean), and a **constant
schedule** is scored on the *same* env, the *same* horizon and the *same*
initial state, so the two numbers are comparable.

Why the ego needs its own harness
----------------------------------
The ego's action space is a `Box(-1, 1, 2)`: `action[0]` is the throttle
command and `action[1]` is the steering command. The baselines are therefore
"always command X on the throttle channel" — the same shape as the signal
agent's "always apply action K".

The ego scenes are **deterministic**: `SimCore._reset_*` hard-codes the NPC
placement and never draws from a random source, so the seed changes nothing
and one episode *is* the population. `EVAL_EPISODES` is therefore 1 by
default, and `evaluate_*` still runs the episode loop so a future
stochastic scene only has to change this constant.

What the ego's policy actually controls
---------------------------------------
`SimCore.step` reads `action[0]` — the throttle — and computes the steering
itself, with Pure Pursuit: `action[1]` never reaches the sim. A policy
trained in this environment therefore modulates the **throttle**, and the
harness measures the throttle channel. The steer channel is still reported
(`steer_mean`), so a change to that becomes visible.
"""

from __future__ import annotations

import argparse
from collections import Counter
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

#: The horizon the ego env runs on (`sim_core.MAX_STEPS_DEFAULT`).
EVAL_STEPS = 200
#: The seed every evaluation starts from.
EVAL_SEED = 0
#: The ego scenes are deterministic, so one episode is the whole population.
EVAL_EPISODES = 1
#: The scene the ego is trained and scored in.
DEFAULT_SCENE = "cross"

#: The throttle commands the baselines use.
FULL_THROTTLE = 1.0
ZERO_THROTTLE = 0.0


def make_env(scene_kind: str = DEFAULT_SCENE, steps: int = EVAL_STEPS) -> Any:
    """A fresh ego env on the horizon the baselines are measured on."""
    from .env import TrafficEnv

    return TrafficEnv(max_steps=steps, scene_kind=scene_kind)


def run_episode(
    env: Any,
    action_for: Callable[[np.ndarray], np.ndarray],
    seed: int = EVAL_SEED,
) -> dict[str, Any]:
    """Run one episode, returning its return, its length and the trace of
    the commands the driver issued.

    `action_for(obs)` returns the 2-vector the env is stepped with. It is a
    callable so the same driver serves both the constant schedules (a
    constant throttle) and a trained policy (the deterministic mean).
    """
    obs, _ = env.reset(seed=seed)
    total = 0.0
    steps = 0
    throttles: list[float] = []
    steers: list[float] = []
    reason = ""
    terminated = truncated = False
    while not (terminated or truncated):
        action = np.asarray(action_for(obs), dtype=np.float32).reshape(2)
        obs, reward, terminated, truncated, info = env.step(action)
        total += float(reward)
        steps += 1
        throttles.append(float(action[0]))
        steers.append(float(action[1]))
        reason = str(info.get("reason", ""))
    return {
        "return": total,
        "steps": steps,
        "reason": reason,
        "throttle_mean": sum(throttles) / len(throttles) if throttles else 0.0,
        "throttle_min": min(throttles) if throttles else 0.0,
        "throttle_max": max(throttles) if throttles else 0.0,
        "throttle_full_share": (
            sum(1 for t in throttles if t >= 0.9) / len(throttles) if throttles else 0.0
        ),
        "steer_mean": sum(steers) / len(steers) if steers else 0.0,
        "throttle_histogram": _histogram(throttles),
        "final_z": float(env.core.ego.z),
        "final_x": float(env.core.ego.x),
    }


def _histogram(values: list[float], buckets: int = 10) -> dict[str, int]:
    """A coarse histogram of the commanded throttle, for the report."""
    counter: Counter[str] = Counter()
    for value in values:
        index = min(buckets - 1, max(0, int((value + 1.0) / 2.0 * buckets)))
        counter[f"[{index * 2 / buckets - 1.0:+.1f},{(index + 1) * 2 / buckets - 1.0:+.1f})"] += 1
    return dict(sorted(counter.items()))


def evaluate_constant_throttle(
    throttle: float,
    *,
    scene_kind: str = DEFAULT_SCENE,
    steps: int = EVAL_STEPS,
    seed: int = EVAL_SEED,
) -> dict[str, Any]:
    """Score a **constant-throttle** schedule — the baseline.

    The throttle is clipped into the action space's range, so a command of
    `2.0` is the same command as `1.0` (the sim clips it) — the baseline is
    therefore reported on the *clipped* value.
    """
    env = make_env(scene_kind, steps)
    command = float(np.clip(throttle, -1.0, 1.0))
    result = run_episode(env, lambda _obs: np.array([command, 0.0], dtype=np.float32), seed)
    result["throttle"] = command
    result["scene_kind"] = scene_kind
    return result


def _predict(policy: Any, obs: np.ndarray) -> np.ndarray:
    """The policy's deterministic action for one observation.

    The observation is reshaped to the shape the **policy's own** observation
    space expects: a policy trained on `MultiTrafficEnv` has a
    `Box(shape=(1, OBS_DIM))` space (one row per agent) and SB3 refuses a
    flat observation, while a policy trained on a plain `TrafficEnv` has a
    `Box(shape=(OBS_DIM,))` space. The action is flattened back to 2.
    """
    shape = getattr(getattr(policy, "observation_space", None), "shape", None)
    if shape is not None and len(shape) > 1:
        obs = obs.reshape(shape)
    action, _ = policy.predict(obs, deterministic=True)
    return np.asarray(action).reshape(-1)


def evaluate_policy(
    policy: Any,
    *,
    scene_kind: str = DEFAULT_SCENE,
    steps: int = EVAL_STEPS,
    seed: int = EVAL_SEED,
    episodes: int = EVAL_EPISODES,
) -> dict[str, Any]:
    """Score a **trained policy** deterministically (the Gaussian mean).

    `policy` is anything with SB3's `predict(obs, deterministic=True)`
    signature — a live `PPO` model or a loaded checkpoint's model.
    """
    env = make_env(scene_kind, steps)
    returns: list[float] = []
    last: dict[str, Any] = {}
    for episode in range(episodes):
        last = run_episode(
            env,
            lambda obs: _predict(policy, obs),
            seed + episode,
        )
        returns.append(last["return"])
    mean = sum(returns) / len(returns) if returns else 0.0
    return {
        "return": mean,
        "returns": returns,
        "episodes": episodes,
        "steps": last.get("steps", 0),
        "reason": last.get("reason", ""),
        "throttle_mean": last.get("throttle_mean", 0.0),
        "throttle_min": last.get("throttle_min", 0.0),
        "throttle_max": last.get("throttle_max", 0.0),
        "throttle_full_share": last.get("throttle_full_share", 0.0),
        "steer_mean": last.get("steer_mean", 0.0),
        "throttle_histogram": last.get("throttle_histogram", {}),
        "final_z": last.get("final_z", 0.0),
        "final_x": last.get("final_x", 0.0),
        "scene_kind": scene_kind,
    }


def evaluate_sweep(
    *,
    scene_kind: str = DEFAULT_SCENE,
    steps: int = EVAL_STEPS,
    seed: int = EVAL_SEED,
    resolution: int = 40,
) -> list[dict[str, Any]]:
    """Every constant throttle on a `1 / resolution` grid — the strongest
    baseline the gate has to beat, not just full throttle."""
    results: list[dict[str, Any]] = []
    for index in range(resolution + 1):
        throttle = index / resolution
        result = evaluate_constant_throttle(throttle, scene_kind=scene_kind, steps=steps, seed=seed)
        results.append(result)
    return results


def load_policy(checkpoint_path: Path) -> Any:
    """Load a saved PPO checkpoint as a deterministic policy."""
    from stable_baselines3 import PPO

    return PPO.load(str(checkpoint_path), device="cpu")


def _is_single_ego(policy: Any) -> bool:
    """Is this policy the **single-ego** one (a 14-dim observation)?

    A policy trained on the multi-agent env has a `(n_agents, OBS_DIM)`
    observation space — `n_agents * 14` inputs — and cannot be scored
    against the single-ego env, nor loaded by the browser.
    """
    shape = getattr(getattr(policy, "observation_space", None), "shape", None)
    if shape is None:
        return True
    return tuple(shape) in {(14,), (1, 14)}


def scan_checkpoints(
    directory: Path,
    *,
    scene_kind: str = DEFAULT_SCENE,
    steps: int = EVAL_STEPS,
    seed: int = EVAL_SEED,
) -> list[dict[str, Any]]:
    """Score **every** checkpoint in a directory.

    A PPO run on this env is **not monotone**: the policy drifts towards
    full throttle as training goes on, and the best-scoring checkpoint is
    often not the last one. The signal agent keeps the best-scoring policy
    state for the same reason (`signal_train.train_signal_policy`); this is
    the ego's equivalent — score every checkpoint, keep the best.

    A multi-agent checkpoint (a `(n_agents, OBS_DIM)` observation space) is
    skipped: it is not a single-ego policy.
    """
    results: list[dict[str, Any]] = []
    for path in sorted(directory.rglob("ppo_step_*.zip")):
        policy = load_policy(path)
        if not _is_single_ego(policy):
            continue
        result = evaluate_policy(policy, scene_kind=scene_kind, steps=steps, seed=seed)
        result["checkpoint"] = str(path)
        results.append(result)
    return results


def select_best(candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The candidate with the highest measured return (ties: the earlier)."""
    if not candidates:
        return None
    return max(candidates, key=lambda item: item["return"])


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Score a trained ego policy against the constant-throttle baselines."
    )
    parser.add_argument(
        "checkpoint",
        type=Path,
        nargs="?",
        help="The PPO .zip to score. Omit it and pass --scan to score a directory.",
    )
    parser.add_argument(
        "--scan",
        type=Path,
        help="Score every checkpoint under this directory and report the best.",
    )
    parser.add_argument("--scene-kind", default=DEFAULT_SCENE)
    parser.add_argument("--steps", type=int, default=EVAL_STEPS)
    parser.add_argument("--seed", type=int, default=EVAL_SEED)
    parser.add_argument("--episodes", type=int, default=EVAL_EPISODES)
    parser.add_argument(
        "--sweep-resolution",
        type=int,
        default=40,
        help="The constant-throttle grid: 40 => every 0.025.",
    )
    args = parser.parse_args()

    if args.scan is not None:
        candidates = scan_checkpoints(
            args.scan, scene_kind=args.scene_kind, steps=args.steps, seed=args.seed
        )
        if not candidates:
            print(f"no checkpoint under {args.scan}")
            return
        print(f"scene: {args.scene_kind}   horizon: {args.steps} steps   seed: {args.seed}")
        print("")
        print(f"{'checkpoint':>52} {'return':>9} {'steps':>6} {'thr mean':>9}  reason")
        for candidate in candidates:
            print(
                f"{candidate['checkpoint'][-52:]:>52} {candidate['return']:>9.3f} "
                f"{candidate['steps']:>6} {candidate['throttle_mean']:>9.3f}  {candidate['reason']}"
            )
        best = select_best(candidates)
        print("")
        print(f"best: {best['checkpoint']}  return {best['return']:.3f}")
        return

    if args.checkpoint is None:
        parser.error("a checkpoint or --scan is required")

    policy = load_policy(args.checkpoint)
    trained = evaluate_policy(
        policy,
        scene_kind=args.scene_kind,
        steps=args.steps,
        seed=args.seed,
        episodes=args.episodes,
    )
    full = evaluate_constant_throttle(
        FULL_THROTTLE, scene_kind=args.scene_kind, steps=args.steps, seed=args.seed
    )
    zero = evaluate_constant_throttle(
        ZERO_THROTTLE, scene_kind=args.scene_kind, steps=args.steps, seed=args.seed
    )
    sweep = evaluate_sweep(
        scene_kind=args.scene_kind,
        steps=args.steps,
        seed=args.seed,
        resolution=args.sweep_resolution,
    )
    best = max(sweep, key=lambda item: item["return"])

    print(f"scene: {args.scene_kind}   horizon: {args.steps} steps   seed: {args.seed}")
    print("")
    print(f"{'policy':>28}   {'return':>9}  {'steps':>6}  reason")
    print(
        f"{'trained (deterministic)':>28}   {trained['return']:>9.3f}  {trained['steps']:>6}  "
        f"{trained['reason']}"
    )
    print(
        f"{'constant full throttle':>28}   {full['return']:>9.3f}  {full['steps']:>6}  {full['reason']}"
    )
    print(
        f"{'constant zero throttle':>28}   {zero['return']:>9.3f}  {zero['steps']:>6}  {zero['reason']}"
    )
    print(
        f"{'best constant (sweep)':>28}   {best['return']:>9.3f}  {best['steps']:>6}  "
        f"{best['reason']}  (throttle {best['throttle']:.3f})"
    )
    print("")
    print(f"margin over full throttle : {trained['return'] - full['return']:+.3f}")
    print(f"margin over best constant : {trained['return'] - best['return']:+.3f}")
    print("")
    print(
        f"throttle: mean {trained['throttle_mean']:.3f}  "
        f"min {trained['throttle_min']:.3f}  max {trained['throttle_max']:.3f}  "
        f"share >= 0.9: {trained['throttle_full_share']:.2%}"
    )
    print(f"steer channel (discarded by the sim): mean {trained['steer_mean']:.3f}")
    print(f"throttle histogram: {trained['throttle_histogram']}")
    print(f"final pose: x {trained['final_x']:.3f}  z {trained['final_z']:.3f}")


if __name__ == "__main__":
    main()
