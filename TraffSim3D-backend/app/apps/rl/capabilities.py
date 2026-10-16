"""Plan 044 GPU extension: detect runtime capabilities.

Returns a snapshot of torch / CUDA / SB3 / VRAM state so the frontend
can make informed UI decisions (e.g. grey out "GPU" when not available)
and the trainer can auto-fallback gracefully.
"""
from __future__ import annotations

from typing import Any

# Minimum VRAM (GB) required for the small obs/action network in this
# project. Below this threshold we fall back to CPU because a GPU with
# less than ~2GB is usually an integrated/old card that can't reliably
# host even SB3's MlpPolicy + 14-dim obs.
MIN_VRAM_GB = 2.0


def _torch_info() -> dict[str, Any]:
    """Return torch info dict, or empty dict if torch is unavailable."""
    try:
        import torch
        return {
            "torch_version": torch.__version__,
            "cuda_available": bool(torch.cuda.is_available()),
            "device_count": int(torch.cuda.device_count()) if torch.cuda.is_available() else 0,
            "device_name": (
                torch.cuda.get_device_name(0)
                if torch.cuda.is_available() and torch.cuda.device_count() > 0
                else ""
            ),
            "vram_gb": (
                round(torch.cuda.get_device_properties(0).total_memory / (1024 ** 3), 2)
                if torch.cuda.is_available() and torch.cuda.device_count() > 0
                else 0.0
            ),
        }
    except ImportError:
        return {
            "torch_version": "",
            "cuda_available": False,
            "device_count": 0,
            "device_name": "",
            "vram_gb": 0.0,
        }


def _sb3_available() -> bool:
    try:
        import stable_baselines3  # noqa: F401
        return True
    except ImportError:
        return False


def detect_capabilities() -> dict[str, Any]:
    """Snapshot of runtime capabilities. Stable shape — frontend depends on it."""
    torch_info = _torch_info()
    sb3_ok = _sb3_available()

    fallback_reasons: list[str] = []
    if not sb3_ok:
        fallback_reasons.append("stable_baselines3_not_installed")
    if not torch_info["cuda_available"]:
        fallback_reasons.append("cuda_not_available")
    elif torch_info["vram_gb"] < MIN_VRAM_GB:
        fallback_reasons.append(
            f"vram_below_{MIN_VRAM_GB}gb ({torch_info['vram_gb']}gb)",
        )

    return {
        **torch_info,
        "sb3_available": sb3_ok,
        "min_vram_gb": MIN_VRAM_GB,
        "device_fallback_reason": "; ".join(fallback_reasons),
    }


def resolve_device(requested: str) -> tuple[str, str]:
    """Decide which torch device the trainer should use.

    Args:
        requested: 'auto' | 'gpu' | 'cpu'

    Returns:
        (device, reason) — device is one of {'cuda', 'cpu', 'dry_run'}.
        reason is human-readable explanation for status.json.
    """
    cap = detect_capabilities()

    if requested == "cpu":
        if cap["sb3_available"]:
            return "cpu", "user_requested_cpu"
        return "dry_run", "cpu_requested_but_sb3_missing"

    if requested == "gpu":
        if not cap["sb3_available"]:
            return "dry_run", "gpu_requested_but_sb3_missing"
        if not cap["cuda_available"]:
            return "dry_run", "gpu_requested_but_no_cuda"
        if cap["vram_gb"] < MIN_VRAM_GB:
            return "dry_run", f"gpu_requested_but_vram_only_{cap['vram_gb']}gb"
        return "cuda", "user_requested_gpu"

    # auto
    if not cap["sb3_available"]:
        return "dry_run", "auto_fallback_no_sb3"
    if cap["cuda_available"] and cap["vram_gb"] >= MIN_VRAM_GB:
        return "cuda", f"auto_selected_gpu ({cap['device_name']})"
    if cap["cuda_available"]:
        return "cpu", f"auto_fallback_vram_only_{cap['vram_gb']}gb"
    return "cpu", "auto_fallback_no_cuda"