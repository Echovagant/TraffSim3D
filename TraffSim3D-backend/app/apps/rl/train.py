"""Plan 044: training entry. Subprocess-driven for the API endpoint.

Default: dry-run path. Writes a synthetic reward history to status.json
without invoking PPO — used by the e2e test and by users who want a UI
preview without the PyTorch + SB3 cost.

If PPO is available (stable-baselines3 + torch installed via
`uv sync --extra rl`), the user can call:
    python -m app.apps.rl.train 1000
to do real training.

GPU support (Plan 044 extension):
- `--device {auto,gpu,cpu}` picks the torch device.
- `auto` selects GPU if CUDA available AND VRAM ≥ MIN_VRAM_GB (2.0),
  else CPU; falls back to dry_run if SB3 is missing entirely.
- The resolved device is recorded in status.json `device` field.

Multi-agent + checkpoints (Plan 045 extension):
- `--n-agents INT` (default 2): stack N TrafficEnvs in lockstep,
  share one PPO policy (parameter sharing).

True independent multi-agent (Plan 047 extension):
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
    total_steps: int = 1000, n_agents: int = 2, independent: bool = False,
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
        # Plan 047: per-agent reward histories.
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
        s["latest_checkpoint"] = (
            ", ".join(f"ppo_agent{i}_step_{total_steps:07d}.zip"
                      for i in range(n_agents))
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


def real_train(
    total_steps: int, device: str, n_agents: int, save_every: int,
    independent: bool = False, scene_kind: str = "cross",
) -> None:
    """Real PPO training via stable-baselines3 on the resolved device.

    `independent=True`: each agent trains with its own PPO policy
    (Plan 047 true multi-agent). Otherwise, one PPO on MultiTrafficEnv
    (Plan 045 parameter sharing).

    `scene_kind='corridor'` (Plan 048): ego drives through 2
    4-way intersections. Default 'cross' = 044 single-intersection.
    """
    from . import capabilities as caps
    from . import checkpoint as ckpt
    from . import control as ctl
    from . import status as st

    resolved_device, reason = caps.resolve_device(device)

    # A fresh run starts with no outstanding pause/terminate request.
    ctl.clear_control()
    st.init_status(total_steps)
    s = st.read_status()
    s["device"] = resolved_device
    s["device_reason"] = reason
    s["n_agents"] = n_agents
    s["independent_agents"] = independent
    s["scene_kind"] = scene_kind
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
        model: Any, step: int, agent_id: int | None = None,
    ) -> None:
        path = ckpt.save_checkpoint(model, step, agent_id=agent_id)
        ckpt_name = path.name
        latest_ckpts.append(f"agent{agent_id}:{ckpt_name}" if agent_id is not None else ckpt_name)
        ss = st.read_status()
        ss["latest_checkpoint"] = ", ".join(latest_ckpts[-4:]) if latest_ckpts else ""
        ss["step"] = step
        st.write_status(ss)

    if independent:
        # Plan 047: each agent trains with its own PPO. Serial (MVP);
        # GPU can run multiple models in parallel via SubprocVecEnv
        # but that's a follow-up.
        envs = [TrafficEnv(scene_kind=scene_kind) for _ in range(n_agents)]
        models = [
            PPO("MlpPolicy", env, verbose=0, device=resolved_device)
            for env in envs
        ]
        steps_per_round = max(1, save_every // n_agents)
        rounds = max(1, total_steps // (steps_per_round * n_agents))
        agent_rewards: dict[str, list[float]] = {
            str(i): [] for i in range(n_agents)
        }
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
            mean_history.append(
                sum(agent_rewards[str(i)][ep] for i in range(n_agents)) / n_agents
            )
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

    # Shared policy (Plan 045)
    env = MultiTrafficEnv(n_agents=n_agents)
    # MultiTrafficEnv stacks obs from each sub-env; scene_kind applies to all
    for sub_env in env.envs:
        sub_env.core.scene_kind = scene_kind
    model = PPO("MlpPolicy", env, verbose=0, device=resolved_device)

    def on_step(_locals: dict[str, Any], _globals: dict[str, Any]) -> bool:  # SB3 callback
        if _control_gate()[0]:
            st.finalize_status("terminated_by_request")
            return False  # False tells SB3 to stop learning
        step = int(_locals["self"].num_timesteps)
        if step % save_every == 0 and step > 0:
            _save_and_record(_locals["self"].model, step)
        if step % 200 == 0:
            ep_buf = _locals["self"].ep_info_buffer
            if ep_buf:
                st.append_reward(float(ep_buf[-1]["r"]))
        return True

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
    total_steps: int, device: str, save_every: int,
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
            path = ckpt.save_checkpoint(_locals["self"].model, step)
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
        help="Training device (Plan 044 GPU extension). "
             "'auto' picks GPU if available + ≥2GB VRAM, else CPU.",
    )
    parser.add_argument(
        "--n-agents", type=int, default=2,
        help="Number of parallel agents sharing the PPO policy (Plan 045).",
    )
    parser.add_argument(
        "--save-every", type=int, default=5000,
        help="Save checkpoint every N env steps (Plan 045).",
    )
    parser.add_argument(
        "--independent", action="store_true",
        help="Train each agent with its own PPO policy (Plan 047 true multi-agent).",
    )
    parser.add_argument(
        "--scene-kind", choices=["cross", "corridor", "t_junction", "roundabout"], default="cross",
        help="Sim topology (Plan 048). 'corridor' = 2 4-way intersections + 60m corridor. 't_junction' = 3-way T intersection. 'roundabout' = circular intersection.",
    )
    parser.add_argument(
        "--curriculum", action="store_true",
        help="Curriculum learning: progressive scene difficulty (cross → t_junction → roundabout → corridor).",
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
            args.steps, args.device, args.n_agents, args.save_every,
            args.independent, args.scene_kind,
        )
    except ImportError as e:
        print(f"SB3 unavailable ({e}); falling back to dry-run path.")
        dry_run(args.steps, args.n_agents, args.independent, args.scene_kind)


if __name__ == "__main__":
    main()