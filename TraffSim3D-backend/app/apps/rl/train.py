"""Training entry. Subprocess-driven for the API endpoint.

Default: dry-run path. Writes a synthetic reward history to status.json
without invoking PPO — used by the e2e test and by users who want a UI
preview without the PyTorch + SB3 cost.

If PPO is available (stable-baselines3 + torch installed via
`uv sync --extra rl`), the user can call:
    python -m app.apps.rl.train 1000
to do real training.

GPU support:
- `--device {auto,gpu,cpu}` picks the torch device.
- `auto` selects GPU if CUDA available AND VRAM ≥ MIN_VRAM_GB (2.0),
  else CPU; falls back to dry_run if SB3 is missing entirely.
- The resolved device is recorded in status.json `device` field.

Multi-agent + checkpoints:
- `--n-agents INT` (default 2): stack N TrafficEnvs in lockstep,
  share one PPO policy (parameter sharing).

True independent multi-agent:
- `--independent`: each agent trains with its own PPO policy
  (no parameter sharing). Per-agent checkpoints + per-agent reward
  history written to status.json under `agent_rewards: {0: [...], ...}`.

Curriculum learning:
- `--curriculum`: progressive scene difficulty (cross → t_junction →
  roundabout → corridor). Agent advances when mastering current scene.
"""

from __future__ import annotations

import argparse
import math
from typing import Any

# How long a pause may block the training loop before we give up on it and
# let training continue. A forgotten pause must not wedge the process; the
# pause is then treated as abandoned and recorded in status.json.
PAUSE_WATCHDOG_S = 3600.0

#: Epoch seen so far; shared by every callback in this process so a pause
#: issued between two different loops is still observed exactly once.
_SEEN_CONTROL_EPOCH = 0


def _control_gate() -> tuple[bool, int]:
    """Honour pause / terminate. Returns ``(should_stop, epoch)``.

    Blocks inside this call while paused, so no environment step executes in
    the meantime and the model stays in memory for a lossless resume.
    """
    global _SEEN_CONTROL_EPOCH
    from . import control as ctl
    from . import status as st

    state, epoch = ctl.poll(_SEEN_CONTROL_EPOCH)
    if state == ctl.STATE_PAUSED:
        st.set_paused(True)
        state, epoch = ctl.wait_while_paused(epoch, timeout_s=PAUSE_WATCHDOG_S)
        if state == ctl.STATE_PAUSED:
            # Watchdog fired: abandon the pause rather than oscillate.
            ctl.request("resume")
            s = st.read_status()
            s["pause_abandoned"] = True
            st.write_status(s)
            st.set_paused(False)
            return False, epoch
        st.set_paused(False)
    _SEEN_CONTROL_EPOCH = epoch
    return state == ctl.STATE_TERMINATED, epoch


def dry_run(
    total_steps: int = 1000,
    n_agents: int = 2,
    independent: bool = False,
    scene_kind: str = "cross",
) -> None:
    """Write synthetic training status (no PPO)."""
    from . import status as st

    st.init_status(total_steps)
    s = st.read_status()
    s["independent_agents"] = independent
    s["n_agents"] = n_agents
    s["scene_kind"] = scene_kind
    st.write_status(s)

    n_episodes = max(1, total_steps // 200)
    if independent:
        # Per-agent reward histories.
        agent_rewards: dict[str, list[float]] = {str(i): [] for i in range(n_agents)}
        for ep in range(n_episodes):
            for i in range(n_agents):
                # Each agent has a slightly different reward curve.
                reward = (0.5 + 0.5 * ep + 0.1 * math.sin(ep)) * (1.0 + 0.1 * i)
                agent_rewards[str(i)].append(reward)
        s = st.read_status()
        s["agent_rewards"] = agent_rewards
        # Top-level reward_history = mean across agents (UI back-compat).
        s["reward_history"] = [
            float(sum(agent_rewards[str(i)][ep] for i in range(n_agents)) / n_agents)
            for ep in range(n_episodes)
        ]
        s["step"] = total_steps
        s["episode_count"] = n_episodes
        s["last_reward"] = float(s["reward_history"][-1]) if s["reward_history"] else 0.0
        s["latest_checkpoint"] = ", ".join(
            f"ppo_agent{i}_step_{total_steps:07d}.zip" for i in range(n_agents)
        )
        st.write_status(s)
        st.finalize_status(
            "dry_run_independent_completed" if independent else "dry_run_completed",
        )
    else:
        for i in range(n_episodes):
            reward = (0.5 + 0.5 * i + 0.1 * math.sin(i)) * n_agents
            st.append_reward(reward)
        s = st.read_status()
        s["latest_checkpoint"] = f"ppo_step_{total_steps:07d}.zip (dry_run)"
        st.write_status(s)
        st.finalize_status("dry_run_completed")


#: The **light curriculum** for the signalled scene.
#:
#: (the red's length in seconds, the env steps spent on that stage).
#:
#: Why it exists (measured): PPO cannot learn the compliant
#: behaviour in the shipped 12 s red on its own — the compliant branch is
#: "brake while `obs[6] == 0`" for **120 consecutive steps**, which a
#: Gaussian policy with a mean near zero almost never samples, so the
#: policy only ever sees "run the red" (+11) and "stand still" (-10) and
#: settles on the former. In a **6 s** red the same branch is sampled
#: often enough (measured: the policy learns it in 25k steps) — but at
#: that length the strongest constant throttle slips through on the green
#: and the scene's gate is a tie (measured -0.100).
#:
#: The stages therefore walk the red from 6 s up to the shipped length.
#: What transfers is the **light-state condition**, not a step count: the
#: observation is memoryless, so the policy can only learn "brake while
#: red, go while green" — which holds for any red length.
#:
#: The budgets are the **measured** ones (two seeds, the same score
#: at the 8 s and the 12 s stages).
LIGHT_CURRICULUM_STAGES = (
    (6.0, 60_000),
    (8.0, 40_000),
    (10.0, 40_000),
    (12.0, 90_000),
)


def light_curriculum_stages(total_steps: int) -> list[tuple[float, int]]:
    """The curriculum's stages, scaled to `total_steps`.

    The budgets are the measured ones; a different `total_steps` scales
    them proportionally, so `--steps 230000` reproduces the measurement
    exactly and `--steps 460000` doubles every stage.
    """
    from .sim_core import CROSS_SIGNALLED_CYCLE_SECONDS

    if LIGHT_CURRICULUM_STAGES[-1][0] != CROSS_SIGNALLED_CYCLE_SECONDS:
        raise ValueError(
            "the light curriculum was measured for a "
            f"{LIGHT_CURRICULUM_STAGES[-1][0]} s red, but the signalled "
            f"scene's cycle is now {CROSS_SIGNALLED_CYCLE_SECONDS} s - "
            "re-measure the curriculum before using it"
        )
    measured = sum(budget for _cycle, budget in LIGHT_CURRICULUM_STAGES)
    return [
        (cycle, max(1, round(total_steps * budget / measured)))
        for cycle, budget in LIGHT_CURRICULUM_STAGES
    ]


def real_train(
    total_steps: int,
    device: str,
    n_agents: int,
    save_every: int,
    independent: bool = False,
    scene_kind: str = "cross",
    seed: int | None = None,
    light_curriculum: bool = False,
) -> None:
    """Real PPO training via stable-baselines3 on the resolved device.

    `independent=True`: each agent trains with its own PPO policy
    (true multi-agent). Otherwise, one PPO on MultiTrafficEnv
    (parameter sharing).

    `scene_kind='corridor'`: ego drives through 2
    4-way intersections. Default 'cross' = the plain single-intersection scene.

    `seed` makes the run reproducible. SB3 draws its own seed from numpy
    when it is given none, so two runs of the same command differ; the
    signal trainer takes a seed for the same reason
    (`signal_train.train_signal_policy`).

    `light_curriculum=True`: walk the **signalled** scene's
    red from short to long, so the policy learns the light-state condition
    ("brake while red, go while green") on a red short enough for the
    exploration to reach it, and then carries that condition over to the
    shipped red length. It only makes sense for `cross_signalled` and on
    the shared-policy path.
    """
    from . import capabilities as caps
    from . import checkpoint as ckpt
    from . import control as ctl
    from . import status as st

    resolved_device, reason = caps.resolve_device(device)

    if light_curriculum:
        if scene_kind != "cross_signalled":
            raise ValueError(
                "the light curriculum only applies to the 'cross_signalled' "
                f"scene (got {scene_kind!r}) - the other scenes have no "
                "light cycle to shorten"
            )
        if independent:
            raise ValueError(
                "the light curriculum is measured on the shared-policy path "
                "(--independent is not supported with it)"
            )

    # A fresh run starts with no outstanding pause/terminate request.
    ctl.clear_control()
    st.init_status(total_steps)
    s = st.read_status()
    s["device"] = resolved_device
    s["device_reason"] = reason
    s["n_agents"] = n_agents
    s["independent_agents"] = independent
    s["scene_kind"] = scene_kind
    s["light_curriculum"] = light_curriculum
    s["latest_checkpoint"] = ""
    st.write_status(s)

    if resolved_device == "dry_run":
        st.append_reward(0.0)
        s = st.read_status()
        s["latest_checkpoint"] = "dry_run_fallback"
        st.write_status(s)
        st.finalize_status(f"dry_run_fallback ({reason})")
        return

    from stable_baselines3 import PPO

    from .env import TrafficEnv
    from .multi_env import MultiTrafficEnv

    latest_ckpts: list[str] = []

    def _save_and_record(
        model: Any,
        step: int,
        agent_id: int | None = None,
    ) -> None:
        path = ckpt.save_checkpoint(model, step, agent_id=agent_id)
        ckpt_name = path.name
        latest_ckpts.append(f"agent{agent_id}:{ckpt_name}" if agent_id is not None else ckpt_name)
        ss = st.read_status()
        ss["latest_checkpoint"] = ", ".join(latest_ckpts[-4:]) if latest_ckpts else ""
        ss["step"] = step
        st.write_status(ss)

    if independent:
        # Each agent trains with its own PPO. Serial (MVP);
        # GPU can run multiple models in parallel via SubprocVecEnv
        # but that's a follow-up.
        envs = [TrafficEnv(scene_kind=scene_kind) for _ in range(n_agents)]
        models = [PPO("MlpPolicy", env, verbose=0, device=resolved_device) for env in envs]
        steps_per_round = max(1, save_every // n_agents)
        rounds = max(1, total_steps // (steps_per_round * n_agents))
        agent_rewards: dict[str, list[float]] = {str(i): [] for i in range(n_agents)}
        terminated = False
        for round_idx in range(rounds):
            for i, (model, _env) in enumerate(zip(models, envs, strict=True)):
                # This branch learns in discrete rounds rather than through a
                # single SB3 callback, so the gate is checked per round.
                if _control_gate()[0]:
                    terminated = True
                    break
                model.learn(total_timesteps=steps_per_round)
                cur_step = (round_idx + 1) * steps_per_round * n_agents
                _save_and_record(model, cur_step, agent_id=i)
                ep_buf = model.ep_info_buffer
                if ep_buf:
                    agent_rewards[str(i)].append(float(ep_buf[-1]["r"]))
            if terminated:
                break
        s = st.read_status()
        s["agent_rewards"] = agent_rewards
        mean_history: list[float] = []
        n = min(len(v) for v in agent_rewards.values()) if agent_rewards else 0
        for ep in range(n):
            mean_history.append(sum(agent_rewards[str(i)][ep] for i in range(n_agents)) / n_agents)
        s["reward_history"] = mean_history
        s["last_reward"] = mean_history[-1] if mean_history else 0.0
        st.write_status(s)
        if terminated:
            st.finalize_status("terminated_by_request")
            return
        st.finalize_status(
            f"ppo_independent_completed on {resolved_device} ({n_agents} agents)",
        )
        return

    # Shared policy
    env = MultiTrafficEnv(n_agents=n_agents)
    # MultiTrafficEnv stacks obs from each sub-env; scene_kind applies to all
    for sub_env in env.envs:
        sub_env.core.scene_kind = scene_kind
    model = PPO("MlpPolicy", env, verbose=0, device=resolved_device, seed=seed)

    def on_step(_locals: dict[str, Any], _globals: dict[str, Any]) -> bool:  # SB3 callback
        if _control_gate()[0]:
            st.finalize_status("terminated_by_request")
            return False  # False tells SB3 to stop learning
        step = int(_locals["self"].num_timesteps)
        if step % save_every == 0 and step > 0:
            # `_locals["self"]` IS the SB3 model (PPO is an
            # OnPolicyAlgorithm, not a wrapper around one) — there is no
            # `.model` attribute. This bug was invisible while SB3 was
            # uninstalled, because the whole body of real_train was skipped.
            _save_and_record(_locals["self"], step)
        if step % 200 == 0:
            ep_buf = _locals["self"].ep_info_buffer
            if ep_buf:
                st.append_reward(float(ep_buf[-1]["r"]))
        return True

    if light_curriculum:
        # The light curriculum. Each stage shortens the
        # signalled scene's red, learns on it, and the next stage puts the
        # red back towards the shipped length. The scene reads the cycle
        # at `reset()`, so a stage change takes effect at the next
        # episode boundary.
        stages = light_curriculum_stages(total_steps)
        for cycle, stage_steps in stages:
            for sub_env in env.envs:
                sub_env.core.light_cycle_seconds = cycle
            model.learn(
                total_timesteps=stage_steps,
                reset_num_timesteps=False,
                callback=on_step,
            )
            if st.read_status().get("running") is False:
                return
    else:
        model.learn(total_timesteps=total_steps, callback=on_step)
    # A terminate request stops SB3 early; don't relabel it as "completed".
    if st.read_status().get("running") is False:
        return
    final_path = ckpt.save_checkpoint(model, total_steps)
    s = st.read_status()
    s["latest_checkpoint"] = final_path.name
    st.write_status(s)
    st.finalize_status(f"ppo_completed on {resolved_device} ({n_agents} agents)")


def curriculum_train(
    total_steps: int,
    device: str,
    save_every: int,
    thresholds: dict[str, dict[str, float]] | None = None,
) -> None:
    """Curriculum learning: progressive scene difficulty.

    Agent starts on easiest scene (cross) and advances through
    t_junction → roundabout → corridor as it demonstrates mastery.
    """
    from . import capabilities as caps
    from . import checkpoint as ckpt
    from . import control as ctl
    from . import status as st
    from .curriculum_env import CurriculumEnv

    resolved_device, reason = caps.resolve_device(device)

    ctl.clear_control()
    st.init_status(total_steps)
    s = st.read_status()
    s["device"] = resolved_device
    s["device_reason"] = reason
    s["curriculum"] = True
    s["scene_kind"] = "cross"  # starts on easiest
    s["latest_checkpoint"] = ""
    st.write_status(s)

    if resolved_device == "dry_run":
        st.append_reward(0.0)
        s = st.read_status()
        s["latest_checkpoint"] = "dry_run_fallback"
        st.write_status(s)
        st.finalize_status(f"dry_run_fallback ({reason})")
        return

    from stable_baselines3 import PPO

    env = CurriculumEnv(thresholds=thresholds)
    model = PPO("MlpPolicy", env, verbose=0, device=resolved_device)

    latest_ckpts: list[str] = []

    def on_step(_locals: dict[str, Any], _globals: dict[str, Any]) -> bool:
        if _control_gate()[0]:
            st.finalize_status("terminated_by_request")
            return False
        step = int(_locals["self"].num_timesteps)
        if step % save_every == 0 and step > 0:
            # Same as real_train's callback: `_locals["self"]` is the model.
            path = ckpt.save_checkpoint(_locals["self"], step)
            ckpt_name = path.name
            latest_ckpts.append(ckpt_name)
            ss = st.read_status()
            ss["latest_checkpoint"] = ", ".join(latest_ckpts[-4:])
            ss["step"] = step
            st.write_status(ss)
        if step % 200 == 0:
            ep_buf = _locals["self"].ep_info_buffer
            if ep_buf:
                st.append_reward(float(ep_buf[-1]["r"]))
            # Update curriculum status
            status = env.get_curriculum_status()
            ss = st.read_status()
            ss["scene_kind"] = status["current_scene"]
            ss["curriculum_status"] = status
            st.write_status(ss)

    model.learn(total_timesteps=total_steps, callback=on_step)
    if st.read_status().get("running") is False:
        return
    final_path = ckpt.save_checkpoint(model, total_steps)
    s = st.read_status()
    s["latest_checkpoint"] = final_path.name
    s["curriculum_status"] = env.get_curriculum_status()
    st.write_status(s)
    st.finalize_status(f"curriculum_completed on {resolved_device}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("steps", nargs="?", type=int, default=1000)
    parser.add_argument("--dry-run", action="store_true", help="Skip PPO, write fake history")
    parser.add_argument(
        "--device",
        choices=["auto", "gpu", "cpu"],
        default="auto",
        help="Training device. 'auto' picks GPU if available + ≥2GB VRAM, else CPU.",
    )
    parser.add_argument(
        "--n-agents",
        type=int,
        default=2,
        help="Number of parallel agents sharing the PPO policy.",
    )
    parser.add_argument(
        "--save-every",
        type=int,
        default=5000,
        help="Save checkpoint every N env steps.",
    )
    parser.add_argument(
        "--independent",
        action="store_true",
        help="Train each agent with its own PPO policy (true multi-agent).",
    )
    parser.add_argument(
        "--scene-kind",
        choices=["cross", "corridor", "t_junction", "roundabout", "cross_signalled"],
        default="cross",
        help=(
            "Sim topology. 'corridor' = 2 4-way intersections + 60m "
            "corridor. 't_junction' = 3-way T intersection. 'roundabout' = "
            "circular intersection. 'cross_signalled' = the "
            "cross scene with the ego's own axis starting RED on a 12 s "
            "cycle - the scene in which a scripted baseline is provably not "
            "optimal."
        ),
    )
    parser.add_argument(
        "--light-curriculum",
        action="store_true",
        help=(
            "Walk the signalled scene's red from short to long "
            "while training, so the policy learns the light-state condition "
            "('brake while red, go while green') on a red the exploration can "
            "reach, and then carries it over to the shipped 12 s red. Only "
            "valid with --scene-kind cross_signalled."
        ),
    )
    parser.add_argument(
        "--curriculum",
        action="store_true",
        help="Curriculum learning: progressive scene difficulty (cross → t_junction → roundabout → corridor).",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=None,
        help="Make the run reproducible. Without it SB3 draws its own seed, "
        "so two runs of the same command differ.",
    )
    args = parser.parse_args()

    if args.curriculum:
        if args.dry_run:
            dry_run(args.steps, 1, False, "cross")
            return
        try:
            curriculum_train(args.steps, args.device, args.save_every)
        except ImportError as e:
            print(f"SB3 unavailable ({e}); falling back to dry-run path.")
            dry_run(args.steps, 1, False, "cross")
        return

    if args.dry_run:
        dry_run(args.steps, args.n_agents, args.independent, args.scene_kind)
        return

    try:
        real_train(
            args.steps,
            args.device,
            args.n_agents,
            args.save_every,
            args.independent,
            args.scene_kind,
            args.seed,
            args.light_curriculum,
        )
    except ImportError as e:
        print(f"SB3 unavailable ({e}); falling back to dry-run path.")
        dry_run(args.steps, args.n_agents, args.independent, args.scene_kind)


if __name__ == "__main__":
    main()
