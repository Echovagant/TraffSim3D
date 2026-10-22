"""Unit tests for `app.apps.rl.capabilities` (GPU extension).

Strategy
--------
`capabilities` probes two *optional* dependencies (torch, stable-baselines3)
and this venv has neither installed, so the real code path on this machine is
the "missing" branch only. To exercise the installed branches as well we
install fake modules into `sys.modules`:

* `_torch_info()` / `_sb3_available()` / `export_weights`-style lookups do
  `import torch` / `import stable_baselines3` *inside* the function body, so
  a `sys.modules` entry is exactly what those imports resolve against. The
  production code under test is therefore untouched — we only change which
  module the import machinery hands back.
* "Not installed" is simulated with `sys.modules[name] = None`, which makes
  `import name` raise `ImportError` even on a machine where the package is
  genuinely installed. (Using `delitem` instead would silently fall through
  to the real package and make the test environment-dependent.)

`detect_capabilities()` / `resolve_device()` call their helpers through the
module namespace (`_torch_info()`), so they are driven end-to-end through the
real logic rather than having the capability dict stubbed out.
"""

from __future__ import annotations

import sys
from types import ModuleType, SimpleNamespace

import pytest

from app.apps.rl import capabilities as rl_caps

BYTES_PER_GB = 1024**3


def _fake_torch(
    *,
    cuda: bool,
    device_count: int,
    device_name: str,
    total_memory: int,
    version: str = "2.5.1+fake",
) -> ModuleType:
    """Build a stand-in `torch` exposing only what `_torch_info()` touches."""
    props = SimpleNamespace(total_memory=total_memory)
    torch_mod = ModuleType("torch")
    torch_mod.__version__ = version  # type: ignore[attr-defined]
    torch_mod.cuda = SimpleNamespace(  # type: ignore[attr-defined]
        is_available=lambda: cuda,
        device_count=lambda: device_count,
        get_device_name=lambda index: device_name if index == 0 else f"{device_name}-{index}",
        get_device_properties=lambda index: props,
    )
    return torch_mod


def _install_runtime(
    monkeypatch: pytest.MonkeyPatch,
    *,
    torch_installed: bool = True,
    sb3_installed: bool = True,
    cuda: bool = False,
    vram_gb: float = 0.0,
    device_name: str = "",
    device_count: int | None = None,
    total_memory: int | None = None,
    torch_version: str = "2.5.1+fake",
) -> None:
    """Install (or hide) the optional deps that `capabilities` probes."""
    if torch_installed:
        count = device_count if device_count is not None else (1 if cuda else 0)
        memory = total_memory if total_memory is not None else int(vram_gb * BYTES_PER_GB)
        monkeypatch.setitem(
            sys.modules,
            "torch",
            _fake_torch(
                cuda=cuda,
                device_count=count,
                device_name=device_name,
                total_memory=memory,
                version=torch_version,
            ),
        )
    else:
        monkeypatch.setitem(sys.modules, "torch", None)

    if sb3_installed:
        monkeypatch.setitem(sys.modules, "stable_baselines3", ModuleType("stable_baselines3"))
    else:
        monkeypatch.setitem(sys.modules, "stable_baselines3", None)


def _gpu(monkeypatch: pytest.MonkeyPatch, *, vram_gb: float, name: str = "FakeGPU") -> None:
    """Healthy GPU box: torch + SB3 installed, CUDA visible with enough VRAM."""
    _install_runtime(
        monkeypatch,
        cuda=True,
        vram_gb=vram_gb,
        device_name=name,
    )


# --------------------------------------------------------------------------
# _torch_info
# --------------------------------------------------------------------------


def test_torch_info_is_empty_sentinel_when_torch_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ImportError -> the fixed zeroed dict the frontend treats as 'no torch'."""
    _install_runtime(monkeypatch, torch_installed=False)

    assert rl_caps._torch_info() == {  # noqa: SLF001
        "torch_version": "",
        "cuda_available": False,
        "device_count": 0,
        "device_name": "",
        "vram_gb": 0.0,
    }


def test_torch_info_reports_version_but_no_gpu_when_cpu_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """torch present, CUDA absent -> version known, every GPU field zeroed."""
    _install_runtime(monkeypatch, cuda=False, torch_version="2.5.1+cpu")

    info = rl_caps._torch_info()  # noqa: SLF001

    assert info["torch_version"] == "2.5.1+cpu"
    assert info["cuda_available"] is False
    assert info["device_count"] == 0
    assert info["device_name"] == ""
    assert info["vram_gb"] == 0.0


def test_torch_info_reports_gpu_details_and_rounds_vram(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """CUDA visible -> name of device 0 and VRAM in GiB rounded to 2 decimals.

    `total_memory` is deliberately not a whole number of GiB so that a
    missing `round(..., 2)` or a wrong `1024**3` divisor is visible.
    """
    raw_bytes = 1_500_000_000
    _install_runtime(
        monkeypatch,
        cuda=True,
        device_count=2,
        device_name="NVIDIA Fake RTX 4070",
        total_memory=raw_bytes,
    )

    info = rl_caps._torch_info()  # noqa: SLF001

    assert info["cuda_available"] is True
    assert info["device_count"] == 2
    assert info["device_name"] == "NVIDIA Fake RTX 4070"
    assert info["vram_gb"] == 1.4  # round(1_500_000_000 / 1024**3, 2)
    assert info["vram_gb"] == round(raw_bytes / BYTES_PER_GB, 2)


def test_torch_info_skips_gpu_query_when_device_count_is_zero(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`is_available()` True but no devices -> name/VRAM stay empty.

    Guards the `and torch.cuda.device_count() > 0` half of the condition: the
    zero-device case must not call `get_device_name` / `get_device_properties`.
    """
    _install_runtime(
        monkeypatch,
        cuda=True,
        device_count=0,
        device_name="SHOULD-NOT-BE-READ",
        total_memory=8 * BYTES_PER_GB,
    )

    info = rl_caps._torch_info()  # noqa: SLF001

    assert info["cuda_available"] is True
    assert info["device_count"] == 0
    assert info["device_name"] == ""
    assert info["vram_gb"] == 0.0


# --------------------------------------------------------------------------
# _sb3_available
# --------------------------------------------------------------------------


def test_sb3_available_is_false_when_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_runtime(monkeypatch, sb3_installed=False)
    assert rl_caps._sb3_available() is False  # noqa: SLF001


def test_sb3_available_is_true_when_importable(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_runtime(monkeypatch, sb3_installed=True)
    assert rl_caps._sb3_available() is True  # noqa: SLF001


# --------------------------------------------------------------------------
# detect_capabilities — structural contract + each fallback branch
# --------------------------------------------------------------------------

EXPECTED_KEYS = {
    "torch_version",
    "cuda_available",
    "device_count",
    "device_name",
    "vram_gb",
    "sb3_available",
    "min_vram_gb",
    "device_fallback_reason",
}


def test_detect_capabilities_shape_on_this_machine() -> None:
    """No fakes: assert the stable *shape*, never this box's hardware.

    The frontend keys off these names, and a real GPU box would legitimately
    report different values, so only structure and self-consistency are
    asserted here.
    """
    cap = rl_caps.detect_capabilities()

    assert set(cap) == EXPECTED_KEYS
    assert isinstance(cap["torch_version"], str)
    assert isinstance(cap["cuda_available"], bool)
    assert isinstance(cap["device_count"], int)
    assert isinstance(cap["device_name"], str)
    assert isinstance(cap["vram_gb"], float)
    assert isinstance(cap["sb3_available"], bool)
    assert isinstance(cap["min_vram_gb"], float)
    assert isinstance(cap["device_fallback_reason"], str)


def test_detect_capabilities_reason_matches_the_flags_on_this_machine() -> None:
    """The reason string must be derivable from the reported flags."""
    cap = rl_caps.detect_capabilities()
    reasons = cap["device_fallback_reason"]

    assert cap["min_vram_gb"] == rl_caps.MIN_VRAM_GB
    # SB3 absent on a `--extra dev` venv -> its reason must be present.
    assert ("stable_baselines3_not_installed" in reasons) is (not cap["sb3_available"])
    assert ("cuda_not_available" in reasons) is (not cap["cuda_available"])
    # The VRAM reason only makes sense when CUDA was actually available.
    assert ("vram_below" in reasons) is (cap["cuda_available"] and cap["vram_gb"] < 2.0)
    if cap["cuda_available"] and cap["device_count"] > 0:
        assert cap["device_name"] != ""


def test_detect_capabilities_reports_no_fallback_on_healthy_gpu(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _gpu(monkeypatch, vram_gb=12.0)

    cap = rl_caps.detect_capabilities()

    assert cap["cuda_available"] is True
    assert cap["sb3_available"] is True
    assert cap["device_count"] == 1
    assert cap["device_name"] == "FakeGPU"
    assert cap["vram_gb"] == 12.0
    assert cap["min_vram_gb"] == 2.0
    assert cap["device_fallback_reason"] == ""


def test_detect_capabilities_reports_vram_shortfall_with_the_actual_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """CUDA present but VRAM under the floor -> reason interpolates the value."""
    _gpu(monkeypatch, vram_gb=1.4)

    cap = rl_caps.detect_capabilities()

    assert cap["cuda_available"] is True
    assert cap["sb3_available"] is True
    assert cap["device_fallback_reason"] == "vram_below_2.0gb (1.4gb)"


def test_detect_capabilities_joins_multiple_reasons(monkeypatch: pytest.MonkeyPatch) -> None:
    """No torch and no SB3 -> both reasons, in declaration order."""
    _install_runtime(monkeypatch, torch_installed=False, sb3_installed=False)

    cap = rl_caps.detect_capabilities()

    assert cap["device_fallback_reason"] == "stable_baselines3_not_installed; cuda_not_available"


# --------------------------------------------------------------------------
# resolve_device — every (requested, capability) combination
# --------------------------------------------------------------------------


def test_resolve_device_cpu_with_sb3(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_runtime(monkeypatch, cuda=False)
    assert rl_caps.resolve_device("cpu") == ("cpu", "user_requested_cpu")


def test_resolve_device_cpu_without_sb3_is_dry_run(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_runtime(monkeypatch, sb3_installed=False, cuda=False)
    assert rl_caps.resolve_device("cpu") == ("dry_run", "cpu_requested_but_sb3_missing")


def test_resolve_device_gpu_without_sb3(monkeypatch: pytest.MonkeyPatch) -> None:
    """A fully capable GPU still cannot train without SB3 -> dry run."""
    _install_runtime(monkeypatch, cuda=True, vram_gb=12.0, device_name="FakeGPU")
    monkeypatch.setitem(sys.modules, "stable_baselines3", None)

    assert rl_caps.resolve_device("gpu") == ("dry_run", "gpu_requested_but_sb3_missing")


def test_resolve_device_gpu_without_cuda(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_runtime(monkeypatch, cuda=False)

    assert rl_caps.resolve_device("gpu") == ("dry_run", "gpu_requested_but_no_cuda")


def test_resolve_device_gpu_rejected_on_small_vram(monkeypatch: pytest.MonkeyPatch) -> None:
    _gpu(monkeypatch, vram_gb=1.4)

    assert rl_caps.resolve_device("gpu") == ("dry_run", "gpu_requested_but_vram_only_1.4gb")


def test_resolve_device_gpu_happy_path(monkeypatch: pytest.MonkeyPatch) -> None:
    _gpu(monkeypatch, vram_gb=12.0, name="NVIDIA Fake RTX 4090")

    assert rl_caps.resolve_device("gpu") == ("cuda", "user_requested_gpu")


def test_resolve_device_auto_without_sb3(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_runtime(monkeypatch, sb3_installed=False, cuda=False)

    assert rl_caps.resolve_device("auto") == ("dry_run", "auto_fallback_no_sb3")


def test_resolve_device_auto_selects_gpu_and_names_it(monkeypatch: pytest.MonkeyPatch) -> None:
    _gpu(monkeypatch, vram_gb=12.0, name="NVIDIA Fake RTX 4090")

    assert rl_caps.resolve_device("auto") == ("cuda", "auto_selected_gpu (NVIDIA Fake RTX 4090)")


def test_resolve_device_auto_falls_back_when_vram_too_small(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """CUDA works but VRAM is under the floor -> CPU, not a dry run."""
    _gpu(monkeypatch, vram_gb=1.4)

    assert rl_caps.resolve_device("auto") == ("cpu", "auto_fallback_vram_only_1.4gb")


def test_resolve_device_auto_falls_back_without_cuda(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_runtime(monkeypatch, cuda=False)

    assert rl_caps.resolve_device("auto") == ("cpu", "auto_fallback_no_cuda")


@pytest.mark.parametrize("requested", ["", "GPU", "CPU", "bogus", "cuda", " auto", "AUTO"])
def test_resolve_device_unrecognized_request_is_treated_as_auto(
    monkeypatch: pytest.MonkeyPatch,
    requested: str,
) -> None:
    """Anything but 'cpu'/'gpu' reaches the auto branch (case-sensitively)."""
    _gpu(monkeypatch, vram_gb=12.0, name="NVIDIA Fake RTX 4090")

    assert rl_caps.resolve_device(requested) == rl_caps.resolve_device("auto")


def test_resolve_device_returned_device_is_always_a_known_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The docstring promises device ∈ {cuda, cpu, dry_run} for any input."""
    _gpu(monkeypatch, vram_gb=12.0, name="NVIDIA Fake RTX 4090")
    _install_runtime(monkeypatch, cuda=False, sb3_installed=False)

    for requested in ("auto", "cpu", "gpu", "", "nonsense"):
        device, reason = rl_caps.resolve_device(requested)
        assert device in {"cuda", "cpu", "dry_run"}
        assert reason  # every branch supplies a human-readable reason


def test_min_vram_gb_is_the_two_gigabyte_floor() -> None:
    """The constant is part of the contract `train.py` / the UI fall back on."""
    assert rl_caps.MIN_VRAM_GB == 2.0
