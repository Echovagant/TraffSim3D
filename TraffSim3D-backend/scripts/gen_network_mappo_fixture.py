"""Generate the **network signal** policy's forward-pass fixture.

The **forward-pass contract** for the multi-junction signal agent: for the
same weights and the same observation, the Python forward pass and the
TypeScript forward pass must produce the **same action index**. The backend
owns the training side, so the backend produces the fixture; the frontend
unit test
(`TraffSim3D-frontend/src/infrastructure/rl/networkMappoPolicyFixture.spec.ts`)
asserts that `mlpForwardDiscrete` returns the committed actions.

This is the sibling of `gen_signal_policy_fixture.py`, and it differs from it
in two ways:

1. the policy is a **MAPPO** policy over the 5 x 5 grid
   (`app.apps.rl.network_mappo`), not a single-junction SB3 policy - so the
   export is the trainer's own `export_weights`, not `weights.export_weights`;
2. the policy is **parameter-shared** - one actor serves every junction - so
   the same observation gives the same action at every junction, which is
   exactly what the browser's per-junction policy source does.

What this script does:

1. **Trains** the policy with the shipped training entry point
   (`app.apps.rl.network_mappo.train_network_mappo`) at the settings the 5 x 5
   level uses - the calibrated demand, the dense evaluation - so the fixture
   holds the weights the project actually produces. Pass
   `--checkpoint <path>` to use an existing checkpoint instead of training one.
2. Exports it through `app.apps.rl.network_mappo.export_weights` - the code
   path under test: a discrete policy has **no** `log_std`, and the export
   says so with `action_space: "discrete"` and `action_dim: 5`.
3. Computes the expected action for every observation **twice** and requires
   them to agree:
   - with the trainer's own actor (`torch`, the float32 forward pass), and
   - with the pure-Python reference forward below, run on the *exported*
     weights (float64 - the same arithmetic the TypeScript side does).
4. Writes the fixture into the frontend's fixtures folder.

The logit margin is checked as well: a margin so small that the float32
(torch) and float64 (Python / TypeScript) computations could disagree would
make the fixture a coin flip rather than a contract.

Regenerate (from `TraffSim3D-backend`):

    .\\.venv\\Scripts\\python.exe scripts\\gen_network_mappo_fixture.py

The result is deterministic: the same seed always produces the same
weights, so re-running the script is a no-op in git.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

# The signal agent's observation dimension (two queue
# lengths + two phase bits + the all-red bit + the phase clock).
OBS_DIM = 6
# The five signal actions - `sim_core.SIGNAL_ACTION_NAMES`.
N_ACTIONS = 5
#: The seed that makes the generated weights reproducible.
SEED = 0
#: The smallest top-1/top-2 logit margin the fixture accepts: below it the
#: float32 (torch) and float64 (Python / TypeScript) computations could pick
#: different actions and the fixture would stop being a contract.
MIN_MARGIN = 1e-3
#: How many env steps the policy is trained for. The policy oscillates
#: between single-action regimes while it trains, and the good regime is
#: transient, so the run has to be long enough to pass through it - and the
#: evaluation dense enough to land inside it (see `EVAL_EVERY`).
TRAIN_STEPS = 20_000
#: How many env steps one rollout collects. The rollout length is not a
#: free parameter: at 1000 the run ends in the all-`no_op` regime (measured
#: on the 5 x 5 grid), and at 500 it passes through the regime that beats
#: the fixed cycle. The same number of env steps, the same seed and the
#: same evaluations produce a different policy.
ROLLOUT_STEPS = 500
#: How often the policy is evaluated while it trains. The default of the
#: trainer (5000) steps straight over the good regime: the policy is only
#: briefly the mixture of `no_op` and a few per cent of `shorten_red` that
#: beats the fixed cycle, and a run that never samples inside it ends at the
#: baseline.
EVAL_EVERY = 500
#: The evaluation window, in env steps (1000 = 100 s) - and the window the
#: final measurement uses as well. **The selection window and the reporting
#: window have to be the same**: over 400 s the network's queue has grown far
#: enough that the accumulated delay drowns the policy's marginal effect,
#: and a policy that is clearly ahead on 100 s looks behind on 400 s.
EVAL_STEPS = 1000

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
    / "network-mappo-policy-fixture.json"
)


# --------------------------------------------------------------------------
# The pure-Python reference forward pass
# --------------------------------------------------------------------------
#
# This is the Python half of the forward-pass contract. It is deliberately
# a *second* implementation next to the trainer's own forward pass: the
# fixture is only meaningful if two independent computations agree.


def _linear(weight: list[list[float]], bias: list[float], x: list[float]) -> list[float]:
    """`y = W x + b` - the same operation order as the TypeScript side."""
    return [
        sum(w * xi for w, xi in zip(row, x, strict=True)) + b
        for row, b in zip(weight, bias, strict=True)
    ]


def forward_logits(obs: list[float], layers: dict[str, Any]) -> list[float]:
    """The action logits: `policy_net.0 -> Tanh -> policy_net.2 -> Tanh -> action_net`."""
    h = _linear(layers["policy_net.0.weight"], layers["policy_net.0.bias"], obs)
    h = [math.tanh(v) for v in h]
    h = _linear(layers["policy_net.2.weight"], layers["policy_net.2.bias"], h)
    h = [math.tanh(v) for v in h]
    return _linear(layers["action_net.weight"], layers["action_net.bias"], h)


def forward_discrete(obs: list[float], layers: dict[str, Any]) -> int:
    """The argmax of the action logits - the discrete policy's action.

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
# be negative - `extend_green` pushes the phase clock below zero):
#   [ns_queue, ew_queue, ns_green, ew_green, all_red, phase_elapsed]
#
# The generator does not take a hand-written list: it **searches** a grid of
# schema-valid observations and keeps the ones the policy actually
# discriminates on (a wide logit margin *and* a different action from the
# most common one). A fixture whose observations all select the same action
# would be satisfied by a forward pass that always returns that index - it
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


def _train(steps: int) -> tuple[dict[str, Any], Any, dict[str, Any]]:
    """Train the network policy.

    Returns the exported weights, the actor they came from and the run's
    summary. The training's own artefacts (the checkpoint) live in a
    directory that goes away with the run - the fixture needs the weights,
    not the checkpoint.
    """
    import tempfile

    from app.apps.rl.network_mappo import (
        TrainingConfig,
        export_weights,
        load_checkpoint,
        train_network_mappo,
    )

    config = TrainingConfig(
        seed=SEED,
        rollout_steps=ROLLOUT_STEPS,
        eval_every=EVAL_EVERY,
        eval_steps=EVAL_STEPS,
        final_eval_steps=EVAL_STEPS,
        final_eval_seeds=(0, 1, 2),
    )
    with tempfile.TemporaryDirectory(prefix="traffsim3d-mappo-") as tmp:
        summary = train_network_mappo(steps, config=config, out_dir=Path(tmp))
        artefacts = summary.get("artifacts")
        if not artefacts:
            raise RuntimeError(f"the training run produced no artefacts: {summary}")
        loaded = load_checkpoint(Path(artefacts["checkpoint"]), device="cpu")
        weights = export_weights(loaded["actor"], name=Path(artefacts["weights"]).name)
    return weights, loaded["actor"], summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--steps", type=int, default=TRAIN_STEPS)
    parser.add_argument("--checkpoint", type=str, default="")
    args = parser.parse_args()

    import torch

    from app.apps.rl.network_mappo import export_weights, load_checkpoint
    from app.apps.rl.sim_core import SIGNAL_ACTION_NAMES

    summary: dict[str, Any] = {}
    if args.checkpoint:
        checkpoint_path = Path(args.checkpoint)
        loaded = load_checkpoint(checkpoint_path, device="cpu")
        weights = export_weights(loaded["actor"], name=checkpoint_path.name)
        actor = loaded["actor"]
    else:
        weights, actor, summary = _train(args.steps)

    assert weights["action_space"] == "discrete", weights["action_space"]
    assert "log_std" not in weights["layers"], "a discrete policy has no log_std"
    assert weights["action_dim"] == N_ACTIONS, weights["action_dim"]
    assert weights["obs_dim"] == OBS_DIM, weights["obs_dim"]

    layers = weights["layers"]

    # Pick the observations the fixture pins: schema-valid ones the policy
    # **discriminates** on - a wide logit margin, and (where the policy
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
            f"(> {MIN_MARGIN}) - the fixture would not be a contract"
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
            "observation - a fixture built from it would be satisfied by a "
            "forward pass that always returns that index. Train a policy "
            "that discriminates first."
        )

    # The trainer's own forward pass - the ground truth.
    with torch.no_grad():
        logits = actor(torch.tensor(kept, dtype=torch.float32))
    torch_actions = [int(index) for index in logits.argmax(dim=-1)]

    # The pure-Python reference on the *exported* weights.
    py_actions = [forward_discrete(obs, layers) for obs in kept]
    assert (
        py_actions == torch_actions
    ), f"the pure-Python forward pass and the actor disagree: {py_actions} != {torch_actions}"

    fixture = {
        "_comment": (
            "The network signal policy's forward-pass contract. The same "
            "weights (produced by app.apps.rl.network_mappo) and the same "
            "observations must give the same action index in Python and in the "
            "browser. Generated by the backend; asserted by the frontend's "
            "networkMappoPolicyFixture.spec.ts."
        ),
        "regenerate": (
            "cd TraffSim3D-backend && "
            ".\\.venv\\Scripts\\python.exe scripts\\gen_network_mappo_fixture.py"
        ),
        "name": weights["name"],
        "obs_dim": weights["obs_dim"],
        "action_dim": weights["action_dim"],
        "action_space": weights["action_space"],
        "hidden_sizes": weights["hidden_sizes"],
        "layers": layers,
        "action_names": list(SIGNAL_ACTION_NAMES),
        "observations": kept,
        "expected_actions": torch_actions,
        "expected_action_names": [SIGNAL_ACTION_NAMES[a] for a in torch_actions],
    }
    if summary.get("final"):
        fixture["training"] = {
            "grid": f"{summary['junctions']} junctions",
            "demand_scale": summary["config"]["demand_scale"],
            "env_steps": summary["env_steps"],
            "best_step": summary["best_step"],
            "margin": summary["final"]["margin"],
            "beats_baseline": summary["final"]["beats_baseline"],
            "actions": summary["final"]["policy"]["actions"],
        }
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {FIXTURE_PATH}")
    print(f"expected_actions: {torch_actions}")
    print(f"expected_action_names: {fixture['expected_action_names']}")


if __name__ == "__main__":
    main()
