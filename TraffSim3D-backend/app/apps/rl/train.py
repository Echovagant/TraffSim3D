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
- `--save-every INT` (default 5000): save PPO model checkpoint to
  /tmp/ppo_checkpoints/pid{os.getpid()}/ every N steps. Auto-prune
  old checkpoints per process (keep latest 5).
"""
from __future__ import annotations

import argparse
import math
from typing import Any


def dry_run(total_steps: int = 1000, n_agents: int = 2) -> None:
    """Write synthetic training status (no PPO)."""
    from . import status as st

    st.init_status(total_steps)
    n_episodes = max(1, total_steps // 200)
    for i in range(n_episodes):
        # Fake reward trending up (linear + noise), scaled by n_agents
        reward = (0.5 + 0.5 * i + 0.1 * math.sin(i)) * n_agents
        st.append_reward(reward)
    s = st.read_status()
    s["latest_checkpoint"] = f"ppo_step_{total_steps:07d}.zip (dry_run)"
    s["n_agents"] = n_agents
    st.write_status(s)
    st.finalize_status("dry_run_completed")


def real_train(total_steps: int, device: str, n_agents: int, save_every: int) -> None:
    """Real PPO training via stable-baselines3 on the resolved device."""
    from . import capabilities as caps
    from . import status as st

    resolved_device, reason = caps.resolve_device(device)

    st.init_status(total_steps)
    s = st.read_status()
    s["device"] = resolved_device
    s["device_reason"] = reason
    s["n_agents"] = n_agents
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

    from .checkpoint import save_checkpoint
    from .multi_env import MultiTrafficEnv

    env = MultiTrafficEnv(n_agents=n_agents)

    latest_ckpt = ""

    def on_step(_locals: dict[str, Any], _globals: dict[str, Any]) -> None:  # SB3 callback
        nonlocal latest_ckpt
        # SB3 calls this every n_steps env steps (default 2048 → every
        # rollout). We save on every save_every global step.
        step = int(_locals["self"].num_timesteps)
        if step % save_every == 0 and step > 0:
            path = save_checkpoint(_locals["self"].model, step)
            latest_ckpt = str(path)
            ss = st.read_status()
            ss["latest_checkpoint"] = path.name
            ss["step"] = step
            st.write_status(ss)
        # Episode reward logging
        if step % 200 == 0:
            ep_buf = _locals["self"].ep_info_buffer
            if ep_buf:
                st.append_reward(float(ep_buf[-1]["r"]))

    model = PPO("MlpPolicy", env, verbose=0, device=resolved_device)
    model.learn(total_timesteps=total_steps, callback=on_step)
    final_path = save_checkpoint(model, total_steps)
    s = st.read_status()
    s["latest_checkpoint"] = final_path.name
    st.write_status(s)
    st.finalize_status(f"ppo_completed on {resolved_device} ({n_agents} agents)")


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
    args = parser.parse_args()

    if args.dry_run:
        dry_run(args.steps, args.n_agents)
        return

    try:
        real_train(args.steps, args.device, args.n_agents, args.save_every)
    except ImportError as e:
        # Fallback: stable-baselines3 / torch not installed.
        print(f"SB3 unavailable ({e}); falling back to dry-run path.")
        dry_run(args.steps, args.n_agents)


if __name__ == "__main__":
    main()