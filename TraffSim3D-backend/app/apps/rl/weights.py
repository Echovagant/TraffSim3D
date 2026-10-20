"""Plan 049: SB3 PPO checkpoint weights → JSON serialization.

Loads a `.zip` checkpoint produced by `app.apps.rl.checkpoint.save_checkpoint()`
and extracts the policy `state_dict()` to a JSON-serializable dict. The
frontend uses this to instantiate an in-browser MlpPolicy (see
`src/infrastructure/rl/mlpInference.ts`) for replay.

Why JSON instead of ONNX:
- ONNX export needs `onnx` + `onnxruntime-web` (heavy, +5MB bundle).
- JSON is ~10x smaller than ONNX for a 14→64→64→2 MlpPolicy (~30KB
  vs ~300KB) and the TS forward pass is <30 lines.
  The input dim (14) is authoritative in `sim_core.OBS_DIM` — do not
  hardcode it here; read it from the checkpoint's state_dict shape.
- Mvp scope: single architecture (MlpPolicy, default net_arch=[]). When
  policy_kwargs support lands (M5+), we'll add ONNX as the fallback.

This module is lazy-loaded by the API endpoint — `stable_baselines3` is
NOT imported at module scope so test environments without SB3 installed
can still import the rest of the package.
"""

from __future__ import annotations

from numbers import Integral
from pathlib import Path
from typing import Any


class WeightsUnavailableError(RuntimeError):
    """Raised when weights cannot be exported (SB3 not installed, file
    unreadable, or layer shape unexpected)."""


def _action_space_kind(model: Any) -> str:
    """The checkpoint's action space: `"discrete"` or `"continuous"`.

    `model.action_space` is the SB3 algorithm's Gymnasium space:

    - `Discrete` carries an integer `n` → a **discrete** policy. SB3's
      `CategoricalPolicy` produces action *logits* and has **no**
      `log_std`. (Gymnasium's `Discrete.n` is a `numpy.int64`, so the
      check accepts any `numbers.Integral`, not just a Python `int`.)
    - `Box` carries a `shape` and no `n` → a **continuous** policy: a
      diagonal Gaussian, whose `log_std` is a learnable parameter.

    A checkpoint whose action space cannot be determined (e.g. a stand-in
    loader that does not expose one) is treated as **continuous** — the
    legacy, strict behaviour, where `log_std` is required.
    """
    space = getattr(model, "action_space", None)
    if space is not None:
        n = getattr(space, "n", None)
        if isinstance(n, Integral) and not isinstance(n, bool):
            return "discrete"
        if hasattr(space, "shape") and not hasattr(space, "n"):
            return "continuous"
    return "continuous"


def export_weights(checkpoint_path: Path) -> dict[str, Any]:
    """Load SB3 PPO `.zip` and return JSON-friendly weights.

    Returns a dict with architecture metadata (`obs_dim`, `action_dim`,
    `action_space`, `hidden_sizes`) and a `layers` sub-dict containing each
    Linear layer's weight matrix + bias vector — plus the diagonal
    Gaussian `log_std` **for a continuous policy only**.

    The action space decides the shape of the export:

    - `"continuous"` (a Box action space): the policy is a diagonal
      Gaussian, so `log_std` exists and is exported.
    - `"discrete"` (a `Discrete` action space): SB3's `CategoricalPolicy`
      has **no** `log_std` — it produces action logits instead. The key is
      omitted, and the consumer runs the discrete forward pass (the
      TypeScript side's `mlpForwardDiscrete`).

    Raises:
        FileNotFoundError: if `checkpoint_path` doesn't exist.
        WeightsUnavailableError: if SB3 is missing or the policy layout is
            unrecognized (e.g. user set non-default policy_kwargs).
    """
    if not checkpoint_path.exists():
        raise FileNotFoundError(f"checkpoint not found: {checkpoint_path}")

    try:
        from stable_baselines3 import PPO
    except ImportError as e:
        raise WeightsUnavailableError(
            f"stable-baselines3 + torch required for weights export: {e}",
        ) from e

    try:
        model = PPO.load(str(checkpoint_path))
    except Exception as e:
        raise WeightsUnavailableError(
            f"failed to load checkpoint {checkpoint_path.name}: {e}",
        ) from e

    sd = model.policy.state_dict()

    # The action space decides whether `log_std` exists at all: only a
    # continuous (Box) policy carries the diagonal Gaussian log-std, while
    # SB3's discrete (Categorical) policy has none.
    action_space = _action_space_kind(model)

    # Default MlpPolicy layout (verified against SB3 2.x):
    #   mlp_extractor.policy_net.0.{weight,bias}  Linear(input, hidden[0])
    #   mlp_extractor.policy_net.2.{weight,bias}  Linear(hidden[0], hidden[1])
    #                                            (index 2 = after nn.Tanh at index 1)
    #   action_net.{weight,bias}                  Linear(hidden[-1], action_dim)
    #   log_std                                  (action_dim,) — diagonal Gaussian,
    #                                            continuous policies only
    required_keys = (
        "mlp_extractor.policy_net.0.weight",
        "mlp_extractor.policy_net.0.bias",
        "mlp_extractor.policy_net.2.weight",
        "mlp_extractor.policy_net.2.bias",
        "action_net.weight",
        "action_net.bias",
    )
    for k in required_keys:
        if k not in sd:
            raise WeightsUnavailableError(
                f"checkpoint {checkpoint_path.name} has no key '{k}'; "
                "only default MlpPolicy (net_arch=[]) is supported",
            )
    if action_space == "continuous" and "log_std" not in sd:
        raise WeightsUnavailableError(
            f"checkpoint {checkpoint_path.name} has no key 'log_std'; "
            "only default MlpPolicy (net_arch=[]) is supported",
        )

    def to_list(t: Any) -> Any:
        return t.detach().cpu().tolist()

    w0 = sd["mlp_extractor.policy_net.0.weight"]
    w2 = sd["mlp_extractor.policy_net.2.weight"]
    aw = sd["action_net.weight"]
    # PyTorch nn.Linear stores weight as (out_features, in_features)
    obs_dim = int(w0.shape[1])
    action_dim = int(aw.shape[0])
    hidden_sizes = [int(w0.shape[0]), int(w2.shape[0])]

    layers: dict[str, Any] = {
        "policy_net.0.weight": to_list(w0),
        "policy_net.0.bias": to_list(sd["mlp_extractor.policy_net.0.bias"]),
        "policy_net.2.weight": to_list(w2),
        "policy_net.2.bias": to_list(sd["mlp_extractor.policy_net.2.bias"]),
        "action_net.weight": to_list(aw),
        "action_net.bias": to_list(sd["action_net.bias"]),
    }
    if action_space == "continuous":
        # The diagonal Gaussian log-std exists only for a Box action space.
        layers["log_std"] = to_list(sd["log_std"])

    return {
        "name": checkpoint_path.name,
        "obs_dim": obs_dim,
        "action_dim": action_dim,
        "action_space": action_space,
        "hidden_sizes": hidden_sizes,
        "layers": layers,
    }
