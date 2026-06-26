"""Plan 044: /api/v1/rl/* endpoints (train + status)."""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from app.apps.rl import status as rl_status

router = APIRouter()


class TrainRequest(BaseModel):
    steps: int = 1000
    dry_run: bool = True


@router.post("/rl/train", tags=["rl"])
async def train(req: TrainRequest) -> dict[str, Any]:
    """Start a training run (subprocess) and return immediately.

    With `dry_run: true` (default), writes a synthetic reward history
    synchronously — used by the e2e test and the AI Playground demo.
    With `dry_run: false`, spawns a real PPO subprocess (requires
    `uv sync --extra rl` for stable-baselines3 + torch).
    """
    if req.dry_run:
        # Synchronous dry-run — write fake status immediately.
        from app.apps.rl.train import dry_run
        dry_run(req.steps)
        return {"ok": True, "dry_run": True, "steps": req.steps}

    # Real training — spawn subprocess, return PID.
    # noqa: ASYNC240 (fire-and-forget Path is OK in endpoint), ASYNC220 (Popen is OK here)
    import subprocess
    backend_root = Path(__file__).resolve().parents[3]  # noqa: ASYNC240
    proc = subprocess.Popen(  # noqa: ASYNC220
        [sys.executable, "-m", "app.apps.rl.train", str(req.steps)],
        cwd=str(backend_root),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return {"ok": True, "dry_run": False, "pid": proc.pid, "steps": req.steps}


@router.get("/rl/status", tags=["rl"])
async def status() -> dict[str, Any]:
    """Read training status from status.json. Empty dict if no run yet."""
    s = rl_status.read_status()
    if not s:
        return {"running": False, "step": 0, "episode_count": 0,
                "last_reward": 0.0, "reward_history": [],
                "started_at_ms": 0, "finished_at_ms": None}
    return s