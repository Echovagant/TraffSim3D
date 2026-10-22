"""Generate the **signal** policy's forward-pass fixture.

The **forward-pass contract** for the signal agent: for the same weights and
the same observation, the Python forward pass and the TypeScript forward pass
must produce the **same action index**. The backend owns the training side,
so the backend produces the fixture; the frontend unit test
(`TraffSim3D-frontend/src/infrastructure/rl/signalPolicyFixture.spec.ts`)
asserts that `mlpForwardDiscrete` returns the committed actions.

What this script does:

1. **Trains** a signal policy with the real training entry point
   (`app.apps.rl.signal_train.train_signal_policy`) — the same code path the
   project ships, so the fixture holds the weights the project actually
   produces. Pass `--checkpoint <path>` to use an existing checkpoint
   instead of training one.
2. Exports it through `app.apps.rl.weights.export_weights` — the code path
   under test: a discrete policy has **no** `log_std`, and the export says so
   with `action_space: "discrete"` and `action_dim: 5`.
3. Computes the expected action for every observation **twice** and requires
   them to agree:
   - with SB3's own policy forward (`policy.predict(..., deterministic=True)`,
     i.e. the distribution's mode = the argmax of the logits), and
   - with the pure-Python reference forward below, run on the *exported*
     weights (float64 — the same arithmetic the TypeScript side does).
4. Writes the fixture into the frontend's fixtures folder.

The logit margin is checked as well: a margin so small that the float32
(SB3) and float64 (Python / TypeScript) computations could disagree would
make the fixture a coin flip rather than a contract.

Regenerate (from `TraffSim3D-backend`):

    .\\.venv\\Scripts\\python.exe scripts\\gen_signal_policy_fixture.py

The result is deterministic: the same seed always produces the same
weights, so re-running the script is a no-op in git.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import warnings
from pathlib import Path
from typing import Any

# The signal agent's observation dimension (two queue
# lengths + two phase bits + the all-red bit + the phase clock).
OBS_DIM = 6
# The five signal actions — `sim_core.SIGNAL_ACTION_NAMES`.
N_ACTIONS = 5
# The seed that makes the generated weights reproducible.
SEED = 20261021
# The smallest top-1/top-2 logit margin the fixture accepts: below it the
# float32 (SB3) and float64 (Python / TypeScript) computations could pick
# different actions and the fixture would stop being a contract.
MIN_MARGIN = 1e-3
# How many steps the fixture's policy is trained for. Short enough to keep
# the regeneration quick, long enough to be a real (trained) policy.
TRAIN_STEPS = 60_000

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
    / "signal-policy-fixture.json"
)


# --------------------------------------------------------------------------
# The pure-Python reference forward pass
# --------------------------------------------------------------------------
#
# This is the Python half of the forward-pass contract. It is deliberately
# a *second* implementation next to SB3's own forward pass: the fixture is
# only meaningful if two independent computations agree.


def _linear(weight: list[list[float]], bias: list[float], x: list[float]) -> list[float]:
    """`y = W x + b` — the same operation order as the TypeScript side."""
    return [
        sum(w * xi for w, xi in zip(row, x, strict=True)) + b
        for row, b in zip(weight, bias, strict=True)
    ]


def forward_logits(obs: list[float], layers: dict[str, Any]) -> list[float]:
    """The action logits: `policy_net.0 → Tanh → policy_net.2 → Tanh → action_net`."""
    h = _linear(layers["policy_net.0.weight"], layers["policy_net.0.bias"], obs)
    h = [math.tanh(v) for v in h]
    h = _linear(layers["policy_net.2.weight"], layers["policy_net.2.bias"], h)
    h = [math.tanh(v) for v in h]
    return _linear(layers["action_net.weight"], layers["action_net.bias"], h)


def forward_discrete(obs: list[float], layers: dict[str, Any]) -> int:
    """The argmax of the action logits — the discrete policy's action.

    Ties are broken towards the lowest index, like `numpy.argmax` and like
    the TypeScript side's `mlpForwardDiscrete`.
    """
    logits = forward_logits(obs, layers)
    best = 0
    for i in range(1, len(logits)):
        if logits[i] > logits[best]:
            best = i
    return best


def logit_margin(obs: list[float], layers: dict[str, Any]) -> float:
    """The gap between the best and the second-best logit."""
    logits = sorted(forward_logits(obs, layers), reverse=True)
    return logits[0] - logits[1]


# --------------------------------------------------------------------------
# The observations the fixture pins
# --------------------------------------------------------------------------
#
# The signal agent's observation schema, normalised to [0, 1] (index 5 may
# be negative — `extend_green` pushes the phase clock below zero):
#   [ns_queue, ew_queue, ns_green, ew_green, all_red, phase_elapsed]
#
# The generator does not take a hand-written list: it **searches** a grid of
# schema-valid observations and keeps the ones the policy actually
# discriminates on (a wide logit margin *and* a different action from the
# most common one). A fixture whose observations all select the same action
# would be satisfied by a forward pass that always returns that index — it
# would not be a contract.
QUEUE_LEVELS = (0.0, 0.5, 1.0)
PHASE_BITS = (
    (1.0, 0.0, 0.0),  # NS has the right of way
    (0.0, 1.0, 0.0),  # EW has the right of way
    (0.0, 0.0, 1.0),  # all red
)
ELAPSED_LEVELS = (0.0, 0.25, 0.5, 0.75, 1.0, -0.5)

#: How many observations the fixture pins per action.
OBSERVATIONS_PER_ACTION = 3


def candidate_observations() -> list[list[float]]:
    """Every schema-valid observation on the grid."""
    out: list[list[float]] = []
    for ns_queue in QUEUE_LEVELS:
        for ew_queue in QUEUE_LEVELS:
            for ns_green, ew_green, all_red in PHASE_BITS:
                for elapsed in ELAPSED_LEVELS:
                    out.append(
                        [
                            ns_queue,
                            ew_queue,
                            ns_green,
                            ew_green,
                            all_red,
                            elapsed,
                        ]
                    )
    return out


# --------------------------------------------------------------------------
# The generator
# --------------------------------------------------------------------------


def _train_checkpoint(steps: int) -> Path:
    """Train a signal policy with the shipped training entry point."""
    from app.apps.rl.signal_train import train_signal_policy

    summary = train_signal_policy(
        steps,
        device="cpu",
        save_every=max(1, steps // 2),
        seed=SEED,
    )
    if not summary.get("trained"):
        raise RuntimeError(f"training did not finish: {summary}")
    checkpoint = summary.get("best_checkpoint") or summary.get("checkpoint")
    if not checkpoint:
        raise RuntimeError("the training run produced no checkpoint")
    return Path(checkpoint)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--steps", type=int, default=TRAIN_STEPS)
    parser.add_argument("--checkpoint", type=str, default="")
    args = parser.parse_args()

    import numpy as np
    import torch
    from stable_baselines3 import PPO

    from app.apps.rl.sim_core import SIGNAL_ACTION_NAMES
    from app.apps.rl.weights import export_weights

    if args.checkpoint:
        checkpoint_path = Path(args.checkpoint)
    else:
        checkpoint_path = _train_checkpoint(args.steps)

    # The export path under test: a discrete policy has no `log_std`.
    # (SB3 warns about the GPU because `PPO.load` picks the device
    # automatically — the export only reads the state_dict.)
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message=".*GPU.*")
        weights = export_weights(checkpoint_path)
    assert weights["action_space"] == "discrete", weights["action_space"]
    assert "log_std" not in weights["layers"], "a discrete policy has no log_std"
    assert weights["action_dim"] == N_ACTIONS, weights["action_dim"]
    assert weights["obs_dim"] == OBS_DIM, weights["obs_dim"]

    layers = weights["layers"]

    # Pick the observations the fixture pins: schema-valid ones the policy
    # **discriminates** on — a wide logit margin, and (where the policy
    # discriminates at all) a spread over more than one action.
    candidates = candidate_observations()
    scored: list[tuple[float, list[float], int]] = []
    for obs in candidates:
        margin = logit_margin(obs, layers)
        if margin < MIN_MARGIN:
            continue
        scored.append((margin, obs, forward_discrete(obs, layers)))
    if not scored:
        raise RuntimeError(
            "no schema-valid observation has a logit margin wide enough "
            f"(> {MIN_MARGIN}) — the fixture would not be a contract"
        )

    by_action: dict[int, list[tuple[float, list[float]]]] = {}
    for margin, obs, action in scored:
        by_action.setdefault(action, []).append((margin, obs))

    # Keep the widest-margin observations of every action the policy picks
    # (a few per action, so the fixture is more than one observation deep).
    kept: list[list[float]] = []
    for _action, entries in sorted(by_action.items()):
        entries.sort(key=lambda item: -item[0])
        kept.extend(obs for _margin, obs in entries[:OBSERVATIONS_PER_ACTION])
    if len(by_action) < 2:
        raise RuntimeError(
            "the policy selects a single action for every schema-valid "
            "observation — a fixture built from it would be satisfied by a "
            "forward pass that always returns that index. Train a policy "
            "that discriminates first."
        )

    # SB3's own forward pass — the ground truth.
    model = PPO.load(str(checkpoint_path), device="cpu")
    obs_batch = np.asarray(kept, dtype=np.float32)
    with torch.no_grad():
        actions, _ = model.policy.predict(obs_batch, deterministic=True)
    sb3_actions = [int(a) for a in actions]

    # The pure-Python reference on the *exported* weights.
    py_actions = [forward_discrete(obs, layers) for obs in kept]
    assert (
        py_actions == sb3_actions
    ), f"the pure-Python forward pass and SB3 disagree: {py_actions} != {sb3_actions}"

    fixture = {
        "_comment": (
            "The signal policy's forward-pass contract. The same "
            "weights (produced by app.apps.rl.signal_train) and the same "
            "observations must give the same action index in Python and in the "
            "browser. Generated by the backend; asserted by the frontend's "
            "signalPolicyFixture.spec.ts."
        ),
        "regenerate": (
            "cd TraffSim3D-backend && "
            ".\\.venv\\Scripts\\python.exe scripts\\gen_signal_policy_fixture.py"
        ),
        "name": weights["name"],
        "obs_dim": weights["obs_dim"],
        "action_dim": weights["action_dim"],
        "action_space": weights["action_space"],
        "hidden_sizes": weights["hidden_sizes"],
        "layers": layers,
        "action_names": list(SIGNAL_ACTION_NAMES),
        "observations": kept,
        "expected_actions": sb3_actions,
        "expected_action_names": [SIGNAL_ACTION_NAMES[a] for a in sb3_actions],
    }
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {FIXTURE_PATH}")
    print(f"expected_actions: {sb3_actions}")
    print(f"expected_action_names: {fixture['expected_action_names']}")


if __name__ == "__main__":
    main()
