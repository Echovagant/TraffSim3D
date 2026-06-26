"""Plan 044: training entry. Subprocess-driven for the API endpoint.

Default: dry-run path. Writes a synthetic reward history to status.json
without invoking PPO — used by the e2e test and by users who want a UI
preview without the PyTorch + SB3 cost.

If PPO is available (stable-baselines3 + torch installed via
`uv sync --extra rl`), the user can call:
    python -m app.apps.rl.train 1000
to do real training.
"""
from __future__ import annotations

import argparse
import math
from typing import Any


def dry_run(total_steps: int = 1000) -> None:
    """Write synthetic training status (no PPO)."""
    from . import status as st

    st.init_status(total_steps)
    n_episodes = max(1, total_steps // 200)
    for i in range(n_episodes):
        # Fake reward trending up (linear + noise)
        reward = 0.5 + 0.5 * i + 0.1 * math.sin(i)
        st.append_reward(reward)
    st.finalize_status("dry_run_completed")


def real_train(total_steps: int) -> None:
    """Real PPO training via stable-baselines3."""
    from stable_baselines3 import PPO

    from . import status as st
    from .env import TrafficEnv

    st.init_status(total_steps)
    env = TrafficEnv()

    def on_step(_locals: dict[str, Any], _globals: dict[str, Any]) -> None:  # SB3 callback
        # Every ~200 steps, count as one episode and log reward
        if _locals["self"].num_timesteps % 200 == 0:
            st.append_reward(_locals["self"].ep_info_buffer[-1]["r"]
                             if _locals["self"].ep_info_buffer else 0.0)

    model = PPO("MlpPolicy", env, verbose=0)
    model.learn(total_timesteps=total_steps, callback=on_step)
    model.save("/tmp/traffic_ppo.zip")
    st.finalize_status("ppo_completed")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("steps", nargs="?", type=int, default=1000)
    parser.add_argument("--dry-run", action="store_true", help="Skip PPO, write fake history")
    args = parser.parse_args()

    if args.dry_run:
        dry_run(args.steps)
        return

    try:
        real_train(args.steps)
    except ImportError as e:
        # Fallback: stable-baselines3 / torch not installed.
        print(f"SB3 unavailable ({e}); falling back to dry-run path.")
        dry_run(args.steps)


if __name__ == "__main__":
    main()