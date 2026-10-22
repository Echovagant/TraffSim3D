"""Unit tests for `app.apps.rl.weights` (checkpoint → JSON export).

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
import os
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import numpy as np
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

# A **discrete** policy: SB3's `CategoricalPolicy` has an action head but
# **no** `log_std` — it produces logits, not a Gaussian mean. The action
# head has one row per action (here the five signal actions).
DISCRETE_STATE_VALUES: dict[str, Any] = {
    "mlp_extractor.policy_net.0.weight": [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]],
    "mlp_extractor.policy_net.0.bias": [0.5, -0.5],
    "mlp_extractor.policy_net.2.weight": [[1.0, 2.0], [3.0, 4.0], [5.0, 6.0], [7.0, 8.0]],
    "mlp_extractor.policy_net.2.bias": [0.1, 0.2, 0.3, 0.4],
    "action_net.weight": [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
        [1.0, 1.0, 1.0, 1.0],
    ],
    "action_net.bias": [-1.0, -0.5, 0.0, 0.5, 1.0],
}

DISCRETE_SHAPES: dict[str, tuple[int, ...]] = {
    "mlp_extractor.policy_net.0.weight": (2, 3),
    "mlp_extractor.policy_net.0.bias": (2,),
    "mlp_extractor.policy_net.2.weight": (4, 2),
    "mlp_extractor.policy_net.2.bias": (4,),
    "action_net.weight": (5, 4),
    "action_net.bias": (5,),
}


class _FakeDiscrete:
    """A stand-in for `gymnasium.spaces.Discrete`.

    `n` is a **numpy** integer in the real space (gymnasium stores it as
    `np.int64`), which is exactly the detail the export's action-space
    detection has to survive.
    """

    def __init__(self, n: int) -> None:
        self.n = np.int64(n)


class _FakeBox:
    """A stand-in for `gymnasium.spaces.Box` — a `shape`, and no `n`."""

    def __init__(self, shape: tuple[int, ...]) -> None:
        self.shape = shape


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
    load_kwargs: list[dict[str, Any]] | None = None,
    action_space: Any = None,
) -> None:
    """Put a fake `stable_baselines3.PPO` on the import path.

    `action_space` mirrors the real algorithm's Gymnasium space. It is
    left unset by default — a stand-in loader that does not expose one
    makes the export fall back to the legacy, strict "continuous" reading.
    """
    inner_sd = state_dict if state_dict is not None else _tiny_state_dict()

    class _FakePPO:
        @staticmethod
        def load(path: str, **kwargs: Any) -> Any:
            if load_calls is not None:
                load_calls.append(path)
            if load_kwargs is not None:
                load_kwargs.append(kwargs)
            if load_error is not None:
                raise load_error
            model = SimpleNamespace(policy=SimpleNamespace(state_dict=lambda: inner_sd))
            if action_space is not None:
                model.action_space = action_space
            return model

    sb3_mod = ModuleType("stable_baselines3")
    sb3_mod.PPO = _FakePPO  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "stable_baselines3", sb3_mod)


def _hide_sb3(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "stable_baselines3", None)


@pytest.fixture(autouse=True)
def _clear_export_cache():
    """Every test starts with an empty export cache.

    The cache is keyed on the checkpoint file's identity, and tests share
    the same fixture bytes — so without this, a later test could be served
    an earlier test's export.
    """
    rl_weights.clear_weights_cache()
    yield
    rl_weights.clear_weights_cache()


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


# --------------------------------------------------------------------------
# The action space — discrete vs continuous
# --------------------------------------------------------------------------


def test_export_weights_reports_a_continuous_action_space(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A Box action space → `action_space: "continuous"`, `log_std` exported."""
    _install_fake_sb3(monkeypatch, action_space=_FakeBox((2,)))

    result = rl_weights.export_weights(_checkpoint(tmp_path))

    assert result["action_space"] == "continuous"
    assert result["layers"]["log_std"] == [-0.5, 0.25]


def test_export_weights_exports_a_discrete_policy_without_log_std(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """SB3's `CategoricalPolicy` has **no** `log_std` — it must still export.

    This is the case that blocked the signal agent: the browser needs a
    discrete forward pass, and the export used to demand the diagonal
    Gaussian log-std that only a Box policy has.
    """
    _install_fake_sb3(
        monkeypatch,
        state_dict=_make_state_dict(
            {k: (DISCRETE_SHAPES[k], DISCRETE_STATE_VALUES[k]) for k in DISCRETE_SHAPES}
        ),
        action_space=_FakeDiscrete(5),
    )

    result = rl_weights.export_weights(_checkpoint(tmp_path))

    assert result["action_space"] == "discrete"
    assert result["action_dim"] == 5
    assert "log_std" not in result["layers"]
    assert set(result["layers"]) == {
        "policy_net.0.weight",
        "policy_net.0.bias",
        "policy_net.2.weight",
        "policy_net.2.bias",
        "action_net.weight",
        "action_net.bias",
    }


def test_export_weights_detects_a_numpy_backed_discrete_space(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Gymnasium's `Discrete.n` is a numpy integer, not a Python `int`.

    The first implementation of the action-space detection compared against
    `int` and therefore read a real SB3 `Discrete` checkpoint as
    continuous — which then demanded the `log_std` the checkpoint does not
    have. This test pins the numpy shape of the check.
    """
    _install_fake_sb3(
        monkeypatch,
        state_dict=_make_state_dict(
            {k: (DISCRETE_SHAPES[k], DISCRETE_STATE_VALUES[k]) for k in DISCRETE_SHAPES}
        ),
        action_space=_FakeDiscrete(5),
    )

    result = rl_weights.export_weights(_checkpoint(tmp_path))

    assert result["action_space"] == "discrete"


def test_export_weights_of_an_unknown_action_space_stays_strict(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A loader that does not expose an action space → the legacy reading.

    Without an action space there is nothing to tell a discrete policy
    from a continuous one, so the export stays strict and demands the
    `log_std` — the same behaviour as before the action-space split.
    """
    _install_fake_sb3(
        monkeypatch,
        state_dict=_make_state_dict(
            {k: (DISCRETE_SHAPES[k], DISCRETE_STATE_VALUES[k]) for k in DISCRETE_SHAPES}
        ),
    )

    with pytest.raises(WeightsUnavailableError) as excinfo:
        rl_weights.export_weights(_checkpoint(tmp_path))

    assert "'log_std'" in str(excinfo.value)


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
    kwargs: list[dict[str, Any]] = []
    _install_fake_sb3(monkeypatch, load_calls=calls, load_kwargs=kwargs)

    rl_weights.export_weights(path)

    assert calls == [str(path)]
    # The export only reads the state_dict — it must not initialise a
    # CUDA context (that cost 4.2 s per cold load on this machine).
    assert kwargs == [{"device": "cpu"}]


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
    """A checkpoint whose action space is unknown is rejected by name.

    Since the action-space split a `Discrete` policy legitimately has no `log_std` — but
    the export can only tell the two apart from the checkpoint's *action
    space*. A loader that does not expose one leaves the export strict,
    exactly as it was before.
    """
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


# --------------------------------------------------------------------------
# export cache
# --------------------------------------------------------------------------


def _install_content_dependent_sb3(monkeypatch: pytest.MonkeyPatch, load_calls: list[str]) -> None:
    """A fake SB3 whose exported weights depend on the checkpoint's bytes.

    Makes "the file changed" observable *in the payload*, so a test can
    prove the cache did not serve a stale export.
    """

    class _FakePPO:
        @staticmethod
        def load(path: str, **kwargs: Any) -> Any:
            load_calls.append(path)
            content_sum = float(sum(Path(path).read_bytes()))
            sd = _make_state_dict({k: (TINY_SHAPES[k], TINY_STATE_VALUES[k]) for k in TINY_SHAPES})
            sd["action_net.bias"] = _FakeTensor((2,), [content_sum, 1.0])
            return SimpleNamespace(policy=SimpleNamespace(state_dict=lambda: sd))

    sb3_mod = ModuleType("stable_baselines3")
    sb3_mod.PPO = _FakePPO  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "stable_baselines3", sb3_mod)


def test_export_weights_loads_the_checkpoint_only_once_per_file(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two exports of an unchanged checkpoint must not load the model twice.

    Loading a PPO checkpoint and re-serialising it cost 0.5–8 s per call —
    that is exactly what the cache removes.
    """
    calls: list[str] = []
    _install_fake_sb3(monkeypatch, load_calls=calls)
    path = _checkpoint(tmp_path)

    first = rl_weights.export_weights(path)
    second = rl_weights.export_weights(path)

    assert calls == [str(path)]
    assert first == second


def test_export_weights_re_exports_a_rewritten_checkpoint(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A checkpoint whose bytes changed must not be served from the cache."""
    calls: list[str] = []
    _install_content_dependent_sb3(monkeypatch, calls)
    path = _checkpoint(tmp_path)

    first = rl_weights.export_weights(path)
    path.write_bytes(b"PK\x03\x04-a-different-archive")
    second = rl_weights.export_weights(path)

    assert len(calls) == 2
    assert first["layers"]["action_net.bias"][0] != second["layers"]["action_net.bias"][0]
    assert first != second


def test_export_weights_re_exports_when_size_and_mtime_are_unchanged(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same size, same mtime, different bytes → still not stale.

    The cache key carries a content digest, so a checkpoint re-saved with
    the same length inside the filesystem's timestamp granularity cannot
    be served from the previous export.
    """
    calls: list[str] = []
    _install_content_dependent_sb3(monkeypatch, calls)
    path = _checkpoint(tmp_path)
    stat = path.stat()

    first = rl_weights.export_weights(path)
    path.write_bytes(b"PK\x03\x04-not-a-real-archivX")  # same length
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))  # same mtime
    second = rl_weights.export_weights(path)

    assert path.stat().st_size == stat.st_size
    assert path.stat().st_mtime_ns == stat.st_mtime_ns
    assert len(calls) == 2
    assert first["layers"]["action_net.bias"][0] != second["layers"]["action_net.bias"][0]


def test_export_weights_does_not_cache_a_failure(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A failed export must not be memoised as a payload.

    The endpoint maps `WeightsUnavailableError` to a 503 — a cached
    failure would keep reporting 503 even after the backend is repaired.
    """
    calls: list[str] = []
    _install_fake_sb3(monkeypatch, load_error=ValueError("corrupt archive"), load_calls=calls)

    with pytest.raises(WeightsUnavailableError):
        rl_weights.export_weights(_checkpoint(tmp_path))

    # SB3 is healthy again → the next call must succeed, not replay the error.
    _install_fake_sb3(monkeypatch, load_calls=calls)
    result = rl_weights.export_weights(_checkpoint(tmp_path))

    assert result["obs_dim"] == 3
    assert len(calls) == 2


def test_export_weights_hands_out_an_independent_copy(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A caller mutating the payload must not corrupt the cached export."""
    _install_fake_sb3(monkeypatch)
    path = _checkpoint(tmp_path)

    first = rl_weights.export_weights(path)
    first["layers"]["action_net.bias"][0] = 999.0
    first["obs_dim"] = 4242
    second = rl_weights.export_weights(path)

    assert second["layers"]["action_net.bias"][0] == -1.0
    assert second["obs_dim"] == 3
