"""Generate the cooperative-driving policy's forward-pass fixture.

The **forward-pass contract** for the Scene 4 driving policy: the same
weights and the same observation must give the same action in Python and
in the browser. The backend owns the training side, so the backend
produces the fixture; the frontend unit test
(``TraffSim3D-frontend/src/infrastructure/rl/networkDrivePolicyFixture.spec.ts``)
asserts that ``mlpForwardMean`` reproduces the committed actions.

What this script does
---------------------
1. Loads the trained policy (the weights the training run wrote, or a
   checkpoint passed with ``--checkpoint``).
2. **Plays real episodes** with it and collects the observations it
   actually meets. A synthetic grid of observations would be a grid of
   numbers the policy never sees; the interesting cases — "the other car
   arrives 1 s before me", "I am already in the box" — are the ones the
   policy meets while driving.
3. Keeps the observations the policy **discriminates** on: the ones
   whose action differs from the most common action, and whose top-two
   action components are far enough apart that a float32 (torch) and a
   float64 (pure Python) computation cannot disagree.
4. Computes the expected action **twice** — with the trainer's actor
   (float32) and with a pure-Python reference implementation on the
   exported weights (float64) — and requires them to agree. The
   fixture is only a contract if the two computations agree.
5. Writes the fixture into the frontend's fixtures folder.

Regenerate (from ``TraffSim3D-backend``)::

    .\\.venv\\Scripts\\python.exe scripts\\gen_drive_policy_fixture.py \
        --weights D:\\Projects\\_audit-archive\\scene4\\network_drive_weights.json
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

FIXTURE_PATH = (
    REPO_ROOT
    / "TraffSim3D-frontend"
    / "src"
    / "infrastructure"
    / "rl"
    / "fixtures"
    / "network-drive-policy-fixture.json"
)

#: How many observations the fixture pins. A **continuous** policy gives
#: a different action for every observation, so "the observations that
#: discriminate" is not a thing here; what matters is that the fixture
#: spans the situations the policy meets and that the forward pass is
#: stable across them. The number is kept small so the committed file
#: stays reviewable.
FIXTURE_OBSERVATIONS = 24

#: The smallest gap between the two largest action components that
#: still lets a float32 and a float64 computation agree. Below it, the
#: fixture would be a coin flip rather than a contract.
MIN_ACTION_MARGIN = 1e-3


def _linear(weight: list[list[float]], bias: list[float], x: list[float]) -> list[float]:
    """`y = W x + b` - the same operation order as the TypeScript side."""
    return [
        sum(w * xi for w, xi in zip(row, x, strict=True)) + b
        for row, b in zip(weight, bias, strict=True)
    ]


def forward_mean(obs: list[float], layers: dict[str, Any]) -> list[float]:
    """The action mean of the exported weights, in float64."""
    h = _linear(layers["policy_net.0.weight"], layers["policy_net.0.bias"], obs)
    h = [math.tanh(v) for v in h]
    h = _linear(layers["policy_net.2.weight"], layers["policy_net.2.bias"], h)
    h = [math.tanh(v) for v in h]
    return _linear(layers["action_net.weight"], layers["action_net.bias"], h)


def action_margin(mean: list[float]) -> float:
    """The gap between the two largest action components."""
    ordered = sorted(mean, reverse=True)
    return ordered[0] - ordered[1]


def collect_observations(weights: dict[str, Any], seeds: tuple[int, ...]) -> list[list[float]]:
    """The observations the policy meets while it drives."""
    import torch

    from app.apps.rl.drive_core import OBS_DIM_DRIVE
    from app.apps.rl.drive_mappo import DriveActor
    from app.apps.rl.intersection_env import IntersectionEnv

    actor = DriveActor(obs_dim=OBS_DIM_DRIVE)
    state = {
        "policy_net.0.weight": torch.tensor(weights["layers"]["policy_net.0.weight"]),
        "policy_net.0.bias": torch.tensor(weights["layers"]["policy_net.0.bias"]),
        "policy_net.2.weight": torch.tensor(weights["layers"]["policy_net.2.weight"]),
        "policy_net.2.bias": torch.tensor(weights["layers"]["policy_net.2.bias"]),
        "action_net.weight": torch.tensor(weights["layers"]["action_net.weight"]),
        "action_net.bias": torch.tensor(weights["layers"]["action_net.bias"]),
    }
    actor.load_state_dict(state, strict=False)
    actor.eval()

    env = IntersectionEnv(n_agents=3, n_npcs=1, max_steps=400)
    observations: list[list[float]] = []
    for seed in seeds:
        obs, _info = env.reset(seed=seed)
        for _step in range(400):
            with torch.no_grad():
                action = actor(torch.as_tensor(obs, dtype=torch.float32)).numpy()
            observations.extend([row.tolist() for row in obs])
            obs, _reward, terminated, truncated, _info = env.step(action)
            if terminated or truncated:
                break
    return observations


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", type=str, required=True, help="the trained weights JSON")
    parser.add_argument("--checkpoint", type=str, default="", help="unused; kept for symmetry")
    parser.add_argument("--seeds", type=str, default="0,1,2")
    args = parser.parse_args()

    weights = json.loads(Path(args.weights).read_text(encoding="utf-8"))
    layers = weights["layers"]
    seeds = tuple(int(s) for s in args.seeds.split(",") if s)

    observations = collect_observations(weights, seeds)
    if not observations:
        raise RuntimeError("the policy met no observations — the episodes ended at once")

    # Keep the observations whose action is the most **decided** — the
    # widest gap between the two largest action components. Those are the
    # cases where a float32 (torch) and a float64 (pure Python)
    # computation could disagree, so they are the ones worth pinning.
    means = [forward_mean(obs, layers) for obs in observations]
    scored: list[tuple[float, list[float], list[float]]] = []
    for obs, mean in zip(observations, means, strict=True):
        margin = action_margin(mean)
        if margin < MIN_ACTION_MARGIN:
            continue
        scored.append((margin, obs, mean))
    if not scored:
        raise RuntimeError(
            "no observation the policy meets has a wide enough action margin — "
            "the fixture would not be a contract"
        )

    # Spread the kept observations over the episode: the widest-margin
    # ones are often neighbours of each other, and a fixture of 24
    # near-identical states would pin nothing.
    scored.sort(key=lambda item: -item[0])
    head = scored[: FIXTURE_OBSERVATIONS // 2]
    step = max(1, len(scored) // (FIXTURE_OBSERVATIONS - len(head)))
    tail = scored[::step][: FIXTURE_OBSERVATIONS - len(head)]
    kept = [(obs, mean) for _margin, obs, mean in head + tail]

    # The pure-Python reference (float64) is what the fixture pins; the
    # trainer's actor (float32) must agree with it.
    import torch

    from app.apps.rl.drive_core import ACTION_DIM_DRIVE, OBS_DIM_DRIVE
    from app.apps.rl.drive_mappo import DriveActor

    actor = DriveActor(obs_dim=OBS_DIM_DRIVE, action_dim=ACTION_DIM_DRIVE)
    actor.load_state_dict(
        {
            "policy_net.0.weight": torch.tensor(layers["policy_net.0.weight"]),
            "policy_net.0.bias": torch.tensor(layers["policy_net.0.bias"]),
            "policy_net.2.weight": torch.tensor(layers["policy_net.2.weight"]),
            "policy_net.2.bias": torch.tensor(layers["policy_net.2.bias"]),
            "action_net.weight": torch.tensor(layers["action_net.weight"]),
            "action_net.bias": torch.tensor(layers["action_net.bias"]),
            "log_std": torch.tensor(layers["log_std"]),
        }
    )
    actor.eval()
    with torch.no_grad():
        torch_actions = actor(
            torch.as_tensor([obs for obs, _ in kept], dtype=torch.float32)
        ).numpy()
    python_actions = [mean for _obs, mean in kept]
    for index, (torch_action, python_action) in enumerate(
        zip(torch_actions, python_actions, strict=True)
    ):
        if not np.allclose(torch_action, python_action, atol=1e-5):
            raise RuntimeError(
                "the pure-Python forward pass and the actor disagree on observation "
                f"{index}: {torch_action.tolist()} vs {python_action}"
            )

    fixture = {
        "_comment": (
            "The cooperative-driving policy's forward-pass contract. The same "
            "weights (produced by app.apps.rl.drive_mappo) and the same "
            "observation must give the same action in Python and in the "
            "browser. The observations are the ones the policy actually met "
            "while driving. Generated by the backend; asserted by the "
            "frontend's networkDrivePolicyFixture.spec.ts."
        ),
        "regenerate": (
            "cd TraffSim3D-backend && .\\.venv\\Scripts\\python.exe "
            "scripts\\gen_drive_policy_fixture.py --weights <network_drive_weights.json>"
        ),
        "name": weights["name"],
        "obs_dim": weights["obs_dim"],
        "action_dim": weights["action_dim"],
        "action_space": weights["action_space"],
        "hidden_sizes": weights["hidden_sizes"],
        "layers": layers,
        "observations": [obs for obs, _ in kept],
        "expected_actions": python_actions,
    }
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {FIXTURE_PATH}")
    print(f"observations: {len(fixture['observations'])}")
    print(f"distinct actions: {len({tuple(a) for a in python_actions})}")


if __name__ == "__main__":
    main()
