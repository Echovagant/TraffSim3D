"""/api/v1/rl/* endpoints (train + status + capabilities + checkpoints)."""

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
    # A real PPO run is the default: `dry_run` fabricates an ascending reward
    # curve and must be asked for explicitly.
    dry_run: bool = False
    device: str = "auto"  # 'auto' | 'gpu' | 'cpu' — GPU support
    n_agents: int = 2  # stacked TrafficEnvs sharing PPO
    save_every: int = 5000  # checkpoint save interval
    independent_agents: bool = False  # per-agent PPO policies
    scene_kind: str = (
        "cross"  # 'cross' | 'corridor' | 't_junction' | 'roundabout' | 'cross_signalled'
    )
    curriculum: bool = False  # Curriculum learning: progressive scene difficulty


@router.post("/rl/train", tags=["rl"])
async def train(req: TrainRequest) -> dict[str, Any]:
    """Start a training run (subprocess) and return immediately."""
    from app.apps.rl import control as rl_control

    # Drop any pause/terminate left over from a previous run, so a fresh
    # start is never immediately paused or killed by a stale request.
    rl_control.clear_control()

    if req.curriculum:
        # Curriculum learning mode
        if req.dry_run:
            from app.apps.rl.train import dry_run

            dry_run(req.steps, 1, False, "cross")
            return {
                "ok": True,
                "dry_run": True,
                "steps": req.steps,
                "device": req.device,
                "curriculum": True,
            }

        import subprocess

        backend_root = Path(__file__).resolve().parents[3]  # noqa: ASYNC240
        args = [
            sys.executable,
            "-m",
            "app.apps.rl.train",
            str(req.steps),
            "--device",
            req.device,
            "--save-every",
            str(req.save_every),
            "--curriculum",
        ]
        proc = subprocess.Popen(  # noqa: ASYNC220
            args,
            cwd=str(backend_root),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return {
            "ok": True,
            "dry_run": False,
            "pid": proc.pid,
            "steps": req.steps,
            "device": req.device,
            "save_every": req.save_every,
            "curriculum": True,
        }

    if req.dry_run:
        # Synchronous dry-run — write fake status immediately.
        from app.apps.rl.train import dry_run

        dry_run(req.steps, req.n_agents, req.independent_agents, req.scene_kind)
        return {
            "ok": True,
            "dry_run": True,
            "steps": req.steps,
            "device": req.device,
            "n_agents": req.n_agents,
            "independent_agents": req.independent_agents,
            "scene_kind": req.scene_kind,
        }

    # Real training — spawn subprocess, return PID.
    # noqa: ASYNC240 (fire-and-forget Path is OK in endpoint), ASYNC220 (Popen is OK here)
    import subprocess

    backend_root = Path(__file__).resolve().parents[3]  # noqa: ASYNC240
    args = [
        sys.executable,
        "-m",
        "app.apps.rl.train",
        str(req.steps),
        "--device",
        req.device,
        "--n-agents",
        str(req.n_agents),
        "--save-every",
        str(req.save_every),
        "--scene-kind",
        req.scene_kind,
    ]
    if req.independent_agents:
        args.append("--independent")
    proc = subprocess.Popen(  # noqa: ASYNC220
        args,
        cwd=str(backend_root),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return {
        "ok": True,
        "dry_run": False,
        "pid": proc.pid,
        "steps": req.steps,
        "device": req.device,
        "n_agents": req.n_agents,
        "independent_agents": req.independent_agents,
        "save_every": req.save_every,
        "scene_kind": req.scene_kind,
    }


@router.get("/rl/status", tags=["rl"])
async def status() -> dict[str, Any]:
    """Read training status from status.json. Empty dict if no run yet."""
    s = rl_status.read_status()
    if not s:
        return {
            "running": False,
            "paused": False,
            "step": 0,
            "episode_count": 0,
            "last_reward": 0.0,
            "reward_history": [],
            "started_at_ms": 0,
            "finished_at_ms": None,
            "latest_checkpoint": "",
            "n_agents": 0,
            "independent_agents": False,
        }
    return s


@router.get("/rl/capabilities", tags=["rl"])
async def capabilities() -> dict[str, Any]:
    """Runtime-detected torch / CUDA / SB3 / VRAM state."""
    return rl_caps.detect_capabilities()


# --- Training task control (启动/暂停/恢复/终止) ----------------------------
#
# Training is a detached subprocess, so these endpoints do not poke a live
# object — they write a control request that the trainer polls from its step
# callback. See `app/apps/rl/control.py` for why this is a file rather than a
# signal.


def _control(action: str) -> dict[str, Any]:
    """Record a control request; 409 when no training run is live."""
    from app.apps.rl import control as rl_control

    s = rl_status.read_status()
    if not s or not s.get("running"):
        raise HTTPException(
            status_code=409,
            detail="no active training run to control",
        )
    payload = rl_control.request(action)
    return {
        "ok": True,
        "action": action,
        "state": payload["state"],
        "epoch": payload["epoch"],
        "requested_at_ms": payload["requested_at_ms"],
    }


@router.post("/rl/train/pause", tags=["rl"])
async def pause_training() -> dict[str, Any]:
    """Pause the running training task. Resumable with zero state loss."""
    return _control("pause")


@router.post("/rl/train/resume", tags=["rl"])
async def resume_training() -> dict[str, Any]:
    """Resume a paused training task from its in-memory state."""
    return _control("resume")


@router.post("/rl/train/terminate", tags=["rl"])
async def terminate_training() -> dict[str, Any]:
    """Stop the running training task. Works while paused."""
    return _control("terminate")


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
    """List supported sim scene kinds."""
    return {"scenes": ["cross", "corridor", "t_junction", "roundabout", "cross_signalled"]}


@router.get("/rl/training-config", tags=["rl"])
async def training_config() -> dict[str, Any]:
    """Default training configuration for the AI Playground form.

    Returns hyperparameter defaults + ranges, available algorithms,
    scenes, and device options. The frontend uses this to pre-populate
    the training configuration panel.
    """
    return {
        "algorithms": ["PPO", "SAC", "TD3"],
        "scenes": ["cross", "corridor", "t_junction", "roundabout", "cross_signalled"],
        "devices": ["auto", "gpu", "cpu"],
        "hyperparameters": {
            "learning_rate": {"default": 3e-4, "min": 1e-6, "max": 1e-2, "step": 1e-5},
            "gamma": {"default": 0.99, "min": 0.9, "max": 0.999, "step": 0.001},
            "batch_size": {"default": 64, "min": 16, "max": 512, "step": 16},
            "n_steps": {"default": 2048, "min": 128, "max": 8192, "step": 128},
            "ent_coef": {"default": 0.01, "min": 0.0, "max": 1.0, "step": 0.001},
        },
        "training": {
            "total_timesteps": {"default": 50000, "min": 1000, "max": 1000000, "step": 1000},
            "eval_freq": {"default": 10, "min": 1, "max": 100, "step": 1},
            "save_every": {"default": 5000, "min": 1000, "max": 50000, "step": 1000},
        },
        "agents": {
            "n_agents": {"default": 2, "min": 1, "max": 8, "step": 1},
            "independent": {"default": False},
        },
    }


@router.get("/rl/checkpoints/{name}/weights", tags=["rl"])
def get_checkpoint_weights(name: str) -> dict[str, Any]:
    """Export a saved PPO checkpoint as JSON-serializable weights.

    The frontend uses this to instantiate an in-browser MlpPolicy for
    replay (see `src/infrastructure/rl/mlpInference.ts`). Returns the
    policy `state_dict()` flattened to nested lists + architecture
    metadata (`obs_dim`, `action_dim`, `hidden_sizes`).

    Deliberately a **sync** endpoint: the export loads a PPO checkpoint
    (cold: seconds), and FastAPI runs sync endpoints in the threadpool.
    As an `async def` it would block the whole event loop for the
    duration of the load, stalling every other request.

    The export itself is memoised per checkpoint file by
    `app.apps.rl.weights.export_weights`, so only the first request per
    checkpoint pays the load cost.

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
    except FileNotFoundError as e:
        # TOCTOU: `path.exists()` above and `export_weights()`'s own check can
        # straddle a deletion, in which case the library raises FileNotFoundError
        # rather than WeightsUnavailableError. Map it to the same 404 the
        # up-front check produces instead of letting it surface as a 500.
        raise HTTPException(status_code=404, detail=f"checkpoint file missing: {name}") from e
    except WeightsUnavailableError as e:
        raise HTTPException(status_code=503, detail=f"weights unavailable: {e}") from e
