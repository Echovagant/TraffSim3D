"""Plan 074 (T4): generate the discrete-policy forward-pass fixture.

The **forward-pass contract**: for the same weights and the same
observations, the Python forward pass and the TypeScript forward pass must
produce the **same action index**. The backend owns the training side, so
the backend produces the fixture; the frontend unit test
(`TraffSim3D-frontend/src/infrastructure/rl/mlpInference.discrete.spec.ts`)
asserts that `mlpForwardDiscrete` returns the committed actions.

What this script does:

1. Builds a **real** SB3 PPO with a `Discrete(5)` action space (the signal
   agent's action space, `sim_core.SIGNAL_ACTION_NAMES`). It is *not*
   trained — only the policy's layout has to be a realistic
   `CategoricalPolicy`, which is what the export and the forward pass
   consume.
2. Exports it through `app.apps.rl.weights.export_weights` — the code path
   under test: a discrete policy has **no** `log_std`, and the export says
   so with `action_space: "discrete"`.
3. Computes the expected action for every observation **twice** and
   requires them to agree:
   - with SB3's own policy forward (`policy.predict(..., deterministic=True)`,
     i.e. the distribution's mode = the argmax of the logits), and
   - with the pure-Python reference forward below, run on the *exported*
     weights (float64 — the same arithmetic the TypeScript side does).
4. Writes the fixture into the frontend's fixtures folder.

Regenerate (from `TraffSim3D-backend`):

    .\\.venv\\Scripts\\python.exe scripts\\gen_discrete_policy_fixture.py

The result is deterministic: the same seed always produces the same
weights, so re-running the script is a no-op in git.
"""

from __future__ import annotations

import json
import math
import sys
import warnings
from pathlib import Path
from typing import Any

# The signal agent's observation dimension (Plan 074 §2 D1: two queue
# lengths + two phase bits + the all-red bit + the phase remainder).
OBS_DIM = 6
# The five signal actions — `sim_core.SIGNAL_ACTION_NAMES`.
N_ACTIONS = 5
# The seed that makes the generated weights reproducible.
SEED = 20261021
# SB3 initialises a policy's action layer with a gain of 0.01, so an
# *untrained* policy's logits are nearly uniform: the top-2 margin of a
# random observation is ~1e-3, which is far too small for a float32 (SB3)
# vs float64 (Python / TypeScript) comparison to mean anything.
#
# Scaling the action layer by a positive constant leaves the **argmax
# unchanged** (it scales every logit by the same factor) and multiplies the
# margin by the same factor — so the fixture stays a sharp test without
# changing which action any observation selects.
ACTION_LOGIT_SCALE = 1000.0

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
    / "discrete-policy-fixture.json"
)
CHECKPOINT_PATH = BACKEND_ROOT / ".data" / "discrete-policy-fixture" / "ppo_discrete_fixture.zip"

# The observations the fixture pins — the signal agent's observation
# schema, normalised to [0, 1]:
#   [ns_queue, ew_queue, ns_green, ew_green, all_red, phase_remaining]
OBSERVATIONS: list[list[float]] = [
    [0.0, 0.0, 1.0, 0.0, 0.0, 0.0],
    [0.0, 0.0, 1.0, 0.0, 0.0, 0.25],
    [0.0, 0.0, 1.0, 0.0, 0.0, 0.5],
    [0.0, 0.0, 1.0, 0.0, 0.0, 0.75],
    [0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
    [0.5, 0.0, 1.0, 0.0, 0.0, 0.0],
    [0.0, 0.5, 0.0, 1.0, 0.0, 0.0],
    [1.0, 0.0, 1.0, 0.0, 0.0, 0.0],
    [0.0, 1.0, 0.0, 1.0, 0.0, 0.0],
    [0.5, 0.5, 0.0, 0.0, 1.0, 0.0],
    [0.25, 0.75, 0.0, 1.0, 0.0, 0.5],
    [1.0, 1.0, 0.0, 0.0, 1.0, 0.25],
]


# --------------------------------------------------------------------------
# The pure-Python reference forward pass
# --------------------------------------------------------------------------
#
# This is the Python half of the forward-pass contract. It is deliberately
# a *second* implementation next to SB3's own forward pass: the fixture
# is only meaningful if two independent computations agree.


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


# --------------------------------------------------------------------------
# The generator
# --------------------------------------------------------------------------


def _build_checkpoint(path: Path, seed: int) -> None:
    """Create a real SB3 PPO with a `Discrete(5)` action space and save it."""
    import gymnasium as gym
    import numpy as np
    import torch
    from stable_baselines3 import PPO

    class _SignalEnv(gym.Env):
        """A do-nothing environment — only the policy's layout matters."""

        def __init__(self) -> None:
            self.observation_space = gym.spaces.Box(-1.0, 1.0, (OBS_DIM,), dtype=np.float32)
            self.action_space = gym.spaces.Discrete(N_ACTIONS)

        def reset(self, *, seed: int | None = None, options: dict[str, Any] | None = None):
            super().reset(seed=seed)
            return np.zeros(OBS_DIM, dtype=np.float32), {}

        def step(self, action: int):
            return np.zeros(OBS_DIM, dtype=np.float32), 0.0, False, False, {}

    torch.manual_seed(seed)
    np.random.seed(seed)
    model = PPO(
        "MlpPolicy",
        _SignalEnv(),
        n_steps=16,
        batch_size=16,
        seed=seed,
        verbose=0,
        device="cpu",
    )
    # See `ACTION_LOGIT_SCALE`: make the logits numerically unambiguous
    # without changing which action any observation selects.
    with torch.no_grad():
        model.policy.action_net.weight.mul_(ACTION_LOGIT_SCALE)
        model.policy.action_net.bias.mul_(ACTION_LOGIT_SCALE)
    path.parent.mkdir(parents=True, exist_ok=True)
    model.save(str(path))


def main() -> None:
    import numpy as np
    import torch
    from stable_baselines3 import PPO

    from app.apps.rl.weights import export_weights

    _build_checkpoint(CHECKPOINT_PATH, SEED)

    # The export path under test: a discrete policy has no `log_std`.
    # (SB3 warns about the GPU because `PPO.load` picks the device
    # automatically — the export only reads the state_dict.)
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message=".*GPU.*")
        weights = export_weights(CHECKPOINT_PATH)
    assert weights["action_space"] == "discrete", weights["action_space"]
    assert "log_std" not in weights["layers"], "a discrete policy has no log_std"
    assert weights["action_dim"] == N_ACTIONS, weights["action_dim"]
    assert weights["obs_dim"] == OBS_DIM, weights["obs_dim"]

    # SB3's own forward pass — the ground truth.
    model = PPO.load(str(CHECKPOINT_PATH), device="cpu")
    obs_batch = np.asarray(OBSERVATIONS, dtype=np.float32)
    with torch.no_grad():
        actions, _ = model.policy.predict(obs_batch, deterministic=True)
    sb3_actions = [int(a) for a in actions]

    # The pure-Python reference on the *exported* weights.
    layers = weights["layers"]
    py_actions = [forward_discrete(obs, layers) for obs in OBSERVATIONS]
    assert (
        py_actions == sb3_actions
    ), f"the pure-Python forward pass and SB3 disagree: {py_actions} != {sb3_actions}"

    # The margin must be wide enough that the float32 (SB3) and the
    # float64 (Python / TypeScript) computations cannot flip the argmax.
    for obs in OBSERVATIONS:
        logits = forward_logits(obs, layers)
        ordered = sorted(logits, reverse=True)
        margin = ordered[0] - ordered[1]
        assert margin > 1e-3, f"observation {obs} has a logit margin of only {margin}"

    fixture = {
        "_comment": (
            "Plan 074 (T4) — the discrete forward-pass contract. The same weights "
            "and the same observations must give the same action index in Python "
            "and in the browser. Generated by the backend; asserted by the "
            "frontend's mlpInference.discrete.spec.ts."
        ),
        "regenerate": (
            "cd TraffSim3D-backend && "
            ".\\.venv\\Scripts\\python.exe scripts\\gen_discrete_policy_fixture.py"
        ),
        "name": weights["name"],
        "obs_dim": weights["obs_dim"],
        "action_dim": weights["action_dim"],
        "action_space": weights["action_space"],
        "hidden_sizes": weights["hidden_sizes"],
        "layers": layers,
        "observations": OBSERVATIONS,
        "expected_actions": sb3_actions,
    }
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {FIXTURE_PATH}")
    print(f"expected_actions: {sb3_actions}")


if __name__ == "__main__":
    main()
