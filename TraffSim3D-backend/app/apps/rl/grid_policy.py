"""The shipped grid signal policy — the delivery surface's weights.

The MAPPO policy trained on the 5 x 5 grid (`app.apps.rl.network_mappo`,
seed 0 — the run whose browser-side delay beat the fixed cycle) ships as a
JSON asset next to this module. `GET /api/v1/rl/signal/grid-policy` serves
it, and the AI Playground loads it by default: the product shows the trained
policy commanding the grid's 25 junctions without requiring a local training
run or a checkpoint on disk.

Why an asset rather than a checkpoint:
- The checkpoint path (`weights.export_weights`) needs SB3 + torch and
  seconds of cold load. This asset is plain JSON the endpoint reads and
  validates in milliseconds, on a backend installed **without** the `rl`
  extra — which is exactly what the e2e job's backend is.
- The asset is written by the same generator run as the frontend's
  forward-pass fixture (`scripts/gen_network_mappo_fixture.py`), and
  `tests/test_rl_grid_policy.py` pins the two together: the shipped weights
  must reproduce the fixture's expected actions. The two cannot drift.

The shape is the export shape `app.apps.rl.network_mappo.export_weights`
produces: architecture metadata + a `layers` dict, with
`action_space: "discrete"` and **no** `log_std` — the browser runs the
discrete forward pass (`mlpForwardDiscrete`), and the observation it feeds
in is the six-dimensional signal observation the browser rebuilds in
`signalPolicySource.ts` against Python's `SignalEnv._obs()`.

The load is validated once and cached; callers get a copy, so no consumer
can mutate the cached policy.
"""

from __future__ import annotations

import copy
import json
import threading
from pathlib import Path
from typing import Any

from app.apps.rl.sim_core import SIGNAL_ACTION_NAMES

#: The asset this module serves — written by the fixture generator, never
#: by hand.
ASSET_PATH = Path(__file__).parent / "assets" / "network_mappo_grid_policy.json"

#: The signal agent's observation dimension (two queue lengths + two phase
#: bits + the all-red bit + the phase clock). The frontend mirrors this as
#: `signalPolicySource.SIG_OBS_DIM`.
_OBS_DIM = 6
#: The five signal actions (`sim_core.SIGNAL_ACTION_NAMES`).
_ACTION_DIM = 5
#: The hidden width of both policy layers — the architecture the browser's
#: forward pass and the fixture contract were both built against.
_HIDDEN = 64

_REQUIRED_LAYERS = (
    "policy_net.0.weight",
    "policy_net.0.bias",
    "policy_net.2.weight",
    "policy_net.2.bias",
    "action_net.weight",
    "action_net.bias",
)


class GridPolicyUnavailableError(RuntimeError):
    """Raised when the shipped asset is missing, unreadable or malformed."""


_lock = threading.Lock()
_cache: dict[str, Any] | None = None


def load_grid_policy() -> dict[str, Any]:
    """Read, validate and return the shipped grid policy.

    The payload is the asset plus two delivery markers the browser keys on:
    `policy_kind: "signal"` (the same tag the checkpoint list uses to tell
    the signal agent from the ego agent) and `source: "shipped"` (it came
    with the product, not from a local training run).

    Raises:
        GridPolicyUnavailableError: if the asset is missing or fails
            validation. The asset ships with the repository, so this only
            fires on a broken install.
    """
    global _cache
    with _lock:
        if _cache is None:
            _cache = _load_uncached()
        return copy.deepcopy(_cache)


def _load_uncached() -> dict[str, Any]:
    if not ASSET_PATH.exists():
        raise GridPolicyUnavailableError(f"asset missing: {ASSET_PATH}")
    try:
        policy = json.loads(ASSET_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise GridPolicyUnavailableError(f"asset unreadable: {e}") from e
    _validate(policy)
    policy["policy_kind"] = "signal"
    policy["source"] = "shipped"
    return policy


def _validate(policy: dict[str, Any]) -> None:
    """Reject anything the browser's discrete forward pass cannot run.

    The declared metadata and the actual matrices must agree: a payload
    that says `obs_dim: 6` while its first matrix consumes 14 inputs would
    produce a live TypeError in the browser — or worse, a silently wrong
    forward pass. Everything is checked here, once, at load.
    """

    def require(condition: bool, message: str) -> None:
        if not condition:
            raise GridPolicyUnavailableError(message)

    require(
        policy.get("action_space") == "discrete",
        f"grid policy must be discrete, got {policy.get('action_space')!r}",
    )
    require(
        policy.get("obs_dim") == _OBS_DIM,
        f"grid policy must take {_OBS_DIM} observations, got {policy.get('obs_dim')!r}",
    )
    require(
        policy.get("action_dim") == _ACTION_DIM,
        f"grid policy must have {_ACTION_DIM} actions, got {policy.get('action_dim')!r}",
    )
    require(
        policy.get("hidden_sizes") == [_HIDDEN, _HIDDEN],
        f"grid policy hidden sizes must be [{_HIDDEN}, {_HIDDEN}], "
        f"got {policy.get('hidden_sizes')!r}",
    )
    require(policy.get("action_names") == list(SIGNAL_ACTION_NAMES), "action_names mismatch")
    layers = policy.get("layers")
    if not isinstance(layers, dict):
        raise GridPolicyUnavailableError("grid policy has no layers dict")
    for key in _REQUIRED_LAYERS:
        require(key in layers, f"grid policy has no layer {key!r}")
    require(
        "log_std" not in layers,
        "a discrete policy has no log_std — this asset was not produced by "
        "the shipped generator",
    )
    _require_matrix(layers, "policy_net.0", (_HIDDEN, _OBS_DIM))
    _require_matrix(layers, "policy_net.2", (_HIDDEN, _HIDDEN))
    _require_matrix(layers, "action_net", (_ACTION_DIM, _HIDDEN))


def _require_matrix(layers: dict[str, Any], prefix: str, shape: tuple[int, int]) -> None:
    """One Linear layer's weight (rows, cols) and bias (rows), checked."""
    weight = layers[f"{prefix}.weight"]
    bias = layers[f"{prefix}.bias"]
    rows, cols = shape
    ok = (
        isinstance(weight, list)
        and len(weight) == rows
        and all(isinstance(row, list) and len(row) == cols for row in weight)
        and isinstance(bias, list)
        and len(bias) == rows
    )
    if not ok:
        raise GridPolicyUnavailableError(f"layer {prefix!r} is not a {rows}x{cols} Linear")
