"""Plan 044 + 045: /api/v1/rl/* endpoints (train + status + capabilities + checkpoints)."""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.apps.rl import capabilities as rl_caps
from app.apps.rl import checkpoint as rl_ckpt
from app.apps.rl import status as rl_status

router = APIRouter()


class TrainRequest(BaseModel):
    steps: int = 1000
    dry_run: bool = True
    device: str = "auto"  # 'auto' | 'gpu' | 'cpu' — Plan 044 GPU extension
    n_agents: int = 2     # Plan 045: stacked TrafficEnvs sharing PPO
    save_every: int = 5000  # Plan 045: checkpoint save interval
    independent_agents: bool = False  # Plan 047: per-agent PPO policies
    scene_kind: str = "cross"  # Plan 048: 'cross' | 'corridor' | 't_junction' | 'roundabout'
    curriculum: bool = False  # Curriculum learning: progressive scene difficulty


@router.post("/rl/train", tags=["rl"])
async def train(req: TrainRequest) -> dict[str, Any]:
    """Start a training run (subprocess) and return immediately."""
    if req.curriculum:
        # Curriculum learning mode
        if req.dry_run:
            from app.apps.rl.train import dry_run
            dry_run(req.steps, 1, False, "cross")
            return {"ok": True, "dry_run": True, "steps": req.steps,
                    "device": req.device, "curriculum": True}

        import subprocess
        backend_root = Path(__file__).resolve().parents[3]  # noqa: ASYNC240
        args = [sys.executable, "-m", "app.apps.rl.train",
                str(req.steps), "--device", req.device,
                "--save-every", str(req.save_every),
                "--curriculum"]
        proc = subprocess.Popen(  # noqa: ASYNC220
            args, cwd=str(backend_root),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        return {"ok": True, "dry_run": False, "pid": proc.pid,
                "steps": req.steps, "device": req.device,
                "save_every": req.save_every, "curriculum": True}

    if req.dry_run:
        # Synchronous dry-run — write fake status immediately.
        from app.apps.rl.train import dry_run
        dry_run(req.steps, req.n_agents, req.independent_agents, req.scene_kind)
        return {"ok": True, "dry_run": True, "steps": req.steps,
                "device": req.device, "n_agents": req.n_agents,
                "independent_agents": req.independent_agents,
                "scene_kind": req.scene_kind}

    # Real training — spawn subprocess, return PID.
    # noqa: ASYNC240 (fire-and-forget Path is OK in endpoint), ASYNC220 (Popen is OK here)
    import subprocess
    backend_root = Path(__file__).resolve().parents[3]  # noqa: ASYNC240
    args = [sys.executable, "-m", "app.apps.rl.train",
            str(req.steps), "--device", req.device,
            "--n-agents", str(req.n_agents),
            "--save-every", str(req.save_every),
            "--scene-kind", req.scene_kind]
    if req.independent_agents:
        args.append("--independent")
    proc = subprocess.Popen(  # noqa: ASYNC220
        args, cwd=str(backend_root),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return {"ok": True, "dry_run": False, "pid": proc.pid,
            "steps": req.steps, "device": req.device,
            "n_agents": req.n_agents,
            "independent_agents": req.independent_agents,
            "save_every": req.save_every,
            "scene_kind": req.scene_kind}


@router.get("/rl/status", tags=["rl"])
async def status() -> dict[str, Any]:
    """Read training status from status.json. Empty dict if no run yet."""
    s = rl_status.read_status()
    if not s:
        return {"running": False, "step": 0, "episode_count": 0,
                "last_reward": 0.0, "reward_history": [],
                "started_at_ms": 0, "finished_at_ms": None,
                "latest_checkpoint": "",
                "n_agents": 0, "independent_agents": False}
    return s


@router.get("/rl/capabilities", tags=["rl"])
async def capabilities() -> dict[str, Any]:
    """Runtime-detected torch / CUDA / SB3 / VRAM state."""
    return rl_caps.detect_capabilities()


@router.get("/rl/checkpoints", tags=["rl"])
async def list_checkpoints() -> dict[str, Any]:
    """List saved PPO checkpoints across all processes, newest first."""
    return {"checkpoints": rl_ckpt.list_checkpoints()}


@router.delete("/rl/checkpoints", tags=["rl"])
async def prune_checkpoints() -> dict[str, Any]:
    """Delete old checkpoints, keeping only the newest 5 overall."""
    deleted = rl_ckpt.prune_all_checkpoints()
    return {"deleted": deleted, "remaining": len(rl_ckpt.list_checkpoints())}


@router.get("/rl/scenes", tags=["rl"])
async def list_scenes() -> dict[str, Any]:
    """List supported sim scene kinds (Plan 048)."""
    return {"scenes": ["cross", "corridor", "t_junction", "roundabout"]}


@router.get("/rl/checkpoints/{name}/weights", tags=["rl"])
async def get_checkpoint_weights(name: str) -> dict[str, Any]:
    """Plan 049: export a saved PPO checkpoint as JSON-serializable weights.

    The frontend uses this to instantiate an in-browser MlpPolicy for
    replay (see `src/infrastructure/rl/mlpInference.ts`). Returns the
    policy `state_dict()` flattened to nested lists + architecture
    metadata (`obs_dim`, `action_dim`, `hidden_sizes`).

    Errors:
      - 404: checkpoint file not found
      - 503: SB3 / torch not installed (run `uv sync --extra rl`)
    """
    from app.apps.rl.weights import WeightsUnavailableError, export_weights

    # Look up the checkpoint across all per-process subdirs.
    matches = [c for c in rl_ckpt.list_checkpoints() if c["name"] == name]
    if not matches:
        raise HTTPException(status_code=404, detail=f"checkpoint not found: {name}")
    ckpt_dir = rl_ckpt.get_checkpoint_dir()
    path = ckpt_dir / matches[0]["process"] / name
    if not path.exists():
        # list_checkpoints returned stale metadata — surface 404 rather than 500.
        raise HTTPException(status_code=404, detail=f"checkpoint file missing: {name}")
    try:
        return export_weights(path)
    except WeightsUnavailableError as e:
        raise HTTPException(status_code=503, detail=f"weights unavailable: {e}") from e