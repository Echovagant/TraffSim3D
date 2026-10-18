"""Unit tests for `app.apps.rl.weights` (Plan 049 checkpoint → JSON export).

`export_weights` lazily does `from stable_baselines3 import PPO` inside the
function body, so a stand-in module placed in `sys.modules` is exactly what
that import resolves against — the production code path stays intact and we
only substitute the checkpoint loader. Hiding SB3 with
`sys.modules["stable_baselines3"] = None` makes the import raise
`ImportError` deterministically, with or without the real package installed.

The fake `state_dict()` tensors are tiny and hand-written on purpose: every
returned list can then be asserted literally, and the derived `obs_dim` /
`action_dim` / `hidden_sizes` are obviously *not* the hardcoded 14 / 2 / 64
triple from `sim_core.OBS_DIM` — a regression to hardcoded dims fails loudly.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest

from app.apps.rl import weights as rl_weights
from app.apps.rl.weights import WeightsUnavailableError

# Default MlpPolicy layout, deliberately tiny and with non-repeating dims:
#   policy_net.0.weight  (2, 3)  -> hidden[0]=2, obs_dim=3
#   policy_net.2.weight  (4, 2)  -> hidden[1]=4
#   action_net.weight    (2, 4)  -> action_dim=2
TINY_STATE_VALUES: dict[str, Any] = {
    "mlp_extractor.policy_net.0.weight": [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]],
    "mlp_extractor.policy_net.0.bias": [0.5, -0.5],
    "mlp_extractor.policy_net.2.weight": [[1.0, 2.0], [3.0, 4.0], [5.0, 6.0], [7.0, 8.0]],
    "mlp_extractor.policy_net.2.bias": [0.1, 0.2, 0.3, 0.4],
    "action_net.weight": [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0]],
    "action_net.bias": [-1.0, 1.0],
    "log_std": [-0.5, 0.25],
}

TINY_SHAPES: dict[str, tuple[int, ...]] = {
    "mlp_extractor.policy_net.0.weight": (2, 3),
    "mlp_extractor.policy_net.0.bias": (2,),
    "mlp_extractor.policy_net.2.weight": (4, 2),
    "mlp_extractor.policy_net.2.bias": (4,),
    "action_net.weight": (2, 4),
    "action_net.bias": (2,),
    "log_std": (2,),
}


class _FakeTensor:
    """Minimal tensor stand-in: `.shape` + the `.detach().cpu().tolist()` chain."""

    def __init__(self, shape: tuple[int, ...], data: Any) -> None:
        self.shape = shape
        self._data = data

    def detach(self) -> _FakeTensor:
        return self

    def cpu(self) -> _FakeTensor:
        return self

    def tolist(self) -> Any:
        return self._data


def _make_state_dict(spec: dict[str, tuple[tuple[int, ...], Any]]) -> dict[str, Any]:
    return {k: _FakeTensor(shape, value) for k, (shape, value) in spec.items()}


def _zeros_like(shape: tuple[int, ...]) -> _FakeTensor:
    """A tensor of the right shape whose values are all 0.0."""
    if len(shape) == 2:
        rows, cols = shape
        return _FakeTensor(shape, [[0.0] * cols] * rows)
    return _FakeTensor(shape, [0.0] * shape[0])


def _tiny_state_dict() -> dict[str, Any]:
    return _make_state_dict({k: (TINY_SHAPES[k], TINY_STATE_VALUES[k]) for k in TINY_SHAPES})


def _checkpoint(tmp_path) -> Path:
    """A file that only has to *exist* — PPO is faked, contents are unused."""
    path = tmp_path / "ppo_step_0000064.zip"
    path.write_bytes(b"PK\x03\x04-not-a-real-archive")
    return path


def _install_fake_sb3(
    monkeypatch: pytest.MonkeyPatch,
    *,
    state_dict: dict[str, Any] | None = None,
    load_error: BaseException | None = None,
    load_calls: list[str] | None = None,
) -> None:
    """Put a fake `stable_baselines3.PPO` on the import path."""
    inner_sd = state_dict if state_dict is not None else _tiny_state_dict()

    class _FakePPO:
        @staticmethod
        def load(path: str) -> Any:
            if load_calls is not None:
                load_calls.append(path)
            if load_error is not None:
                raise load_error
            return SimpleNamespace(policy=SimpleNamespace(state_dict=lambda: inner_sd))

    sb3_mod = ModuleType("stable_baselines3")
    sb3_mod.PPO = _FakePPO  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "stable_baselines3", sb3_mod)


def _hide_sb3(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "stable_baselines3", None)


# --------------------------------------------------------------------------
# happy path
# --------------------------------------------------------------------------


def test_export_weights_returns_architecture_and_layers(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _checkpoint(tmp_path)
    _install_fake_sb3(monkeypatch)

    result = rl_weights.export_weights(path)

    assert result["name"] == "ppo_step_0000064.zip"
    # Dims are read out of the state_dict, not hardcoded to OBS_DIM=14 / 2 / 64.
    assert result["obs_dim"] == 3
    assert result["action_dim"] == 2
    assert result["hidden_sizes"] == [2, 4]
    assert result["layers"] == {
        "policy_net.0.weight": [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]],
        "policy_net.0.bias": [0.5, -0.5],
        "policy_net.2.weight": [[1.0, 2.0], [3.0, 4.0], [5.0, 6.0], [7.0, 8.0]],
        "policy_net.2.bias": [0.1, 0.2, 0.3, 0.4],
        "action_net.weight": [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0]],
        "action_net.bias": [-1.0, 1.0],
        "log_std": [-0.5, 0.25],
    }


def test_export_weights_output_is_json_serializable(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The endpoint feeds this straight to `JSONResponse`."""
    _install_fake_sb3(monkeypatch)

    result = rl_weights.export_weights(_checkpoint(tmp_path))

    assert json.loads(json.dumps(result)) == result


def test_export_weights_reads_obs_dim_from_checkpoint(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A realistic 14 -> 64 -> 64 -> 2 policy reports 14 / 64 / 64 / 2.

    Guards the module docstring's "do not hardcode it here" note.
    """
    real_shapes = {
        "mlp_extractor.policy_net.0.weight": (64, 14),
        "mlp_extractor.policy_net.0.bias": (64,),
        "mlp_extractor.policy_net.2.weight": (64, 64),
        "mlp_extractor.policy_net.2.bias": (64,),
        "action_net.weight": (2, 64),
        "action_net.bias": (2,),
        "log_std": (2,),
    }
    _install_fake_sb3(
        monkeypatch,
        state_dict={key: _zeros_like(shape) for key, shape in real_shapes.items()},
    )

    result = rl_weights.export_weights(_checkpoint(tmp_path))

    assert result["obs_dim"] == 14
    assert result["action_dim"] == 2
    assert result["hidden_sizes"] == [64, 64]
    assert len(result["layers"]["log_std"]) == 2


def test_export_weights_passes_str_path_to_ppo_load(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _checkpoint(tmp_path)
    calls: list[str] = []
    _install_fake_sb3(monkeypatch, load_calls=calls)

    rl_weights.export_weights(path)

    assert calls == [str(path)]


# --------------------------------------------------------------------------
# missing checkpoint file
# --------------------------------------------------------------------------


def test_export_weights_missing_file_raises_file_not_found(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A missing path is `FileNotFoundError`, NOT `WeightsUnavailableError`.

    `app/api/v1/rl.py` only catches `WeightsUnavailableError`, so this
    distinction is load-bearing for the 404 vs 503 mapping.
    """
    calls: list[str] = []
    _install_fake_sb3(monkeypatch, load_calls=calls)
    missing = tmp_path / "nope.zip"

    with pytest.raises(FileNotFoundError) as excinfo:
        rl_weights.export_weights(missing)

    assert not isinstance(excinfo.value, WeightsUnavailableError)
    assert "checkpoint not found" in str(excinfo.value)
    assert "nope.zip" in str(excinfo.value)
    assert calls == []  # never reached the loader


def test_export_weights_checks_existence_before_importing_sb3(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Order matters: no-SB3 venv must still report 'missing', not 'unavailable'."""
    _hide_sb3(monkeypatch)
    missing = tmp_path / "absent.zip"

    with pytest.raises(FileNotFoundError):
        rl_weights.export_weights(missing)


# --------------------------------------------------------------------------
# SB3 missing / loader failure
# --------------------------------------------------------------------------


def test_export_weights_raises_unavailable_when_sb3_missing(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _hide_sb3(monkeypatch)

    with pytest.raises(WeightsUnavailableError) as excinfo:
        rl_weights.export_weights(_checkpoint(tmp_path))

    assert isinstance(excinfo.value, RuntimeError)
    assert "stable-baselines3" in str(excinfo.value)
    assert isinstance(excinfo.value.__cause__, ImportError)


def test_export_weights_wraps_ppo_load_failure(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A corrupt archive becomes `WeightsUnavailableError`, cause preserved."""
    _install_fake_sb3(monkeypatch, load_error=ValueError("corrupt archive"))

    with pytest.raises(WeightsUnavailableError) as excinfo:
        rl_weights.export_weights(_checkpoint(tmp_path))

    message = str(excinfo.value)
    assert "ppo_step_0000064.zip" in message
    assert "corrupt archive" in message
    assert isinstance(excinfo.value.__cause__, ValueError)
    assert str(excinfo.value.__cause__) == "corrupt archive"


# --------------------------------------------------------------------------
# unrecognized policy layout
# --------------------------------------------------------------------------


def test_export_weights_rejects_state_dict_missing_log_std(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A non-default policy (no diagonal `log_std`) is rejected by name."""
    partial = _make_state_dict(
        {
            key: (TINY_SHAPES[key], TINY_STATE_VALUES[key])
            for key in TINY_SHAPES
            if key != "log_std"
        },
    )
    _install_fake_sb3(monkeypatch, state_dict=partial)

    with pytest.raises(WeightsUnavailableError) as excinfo:
        rl_weights.export_weights(_checkpoint(tmp_path))

    message = str(excinfo.value)
    assert "'log_std'" in message
    assert "default MlpPolicy" in message


def test_export_weights_reports_the_first_missing_key(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An empty state_dict names the first key of `required_keys`."""
    _install_fake_sb3(monkeypatch, state_dict={})

    with pytest.raises(WeightsUnavailableError) as excinfo:
        rl_weights.export_weights(_checkpoint(tmp_path))

    assert "'mlp_extractor.policy_net.0.weight'" in str(excinfo.value)
