"""Plan 044: API endpoint tests for /api/v1/rl/*.

Uses httpx2 + ASGITransport (in-process, no subprocess overhead).
`status.get_status_path()` is bound at module-import time, so we
use a shared file path and clear it per test (simpler than reloading
modules).
"""
from __future__ import annotations

import pytest
from httpx2 import ASGITransport, AsyncClient

from app.apps.rl import status as rl_status
from app.main import app

STATUS_PATH = rl_status.get_status_path()


@pytest.fixture
async def client():
    # Clean slate per test
    if STATUS_PATH.exists():
        STATUS_PATH.unlink()
    rl_status.write_status({})  # ensure fresh empty status
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c
    if STATUS_PATH.exists():
        STATUS_PATH.unlink()


@pytest.mark.asyncio
async def test_dry_run_train_writes_status(client: AsyncClient) -> None:
    r0 = await client.get("/api/v1/rl/status")
    assert r0.status_code == 200
    assert r0.json()["step"] == 0

    r1 = await client.post(
        "/api/v1/rl/train",
        json={"steps": 200, "dry_run": True},
    )
    assert r1.status_code == 200
    assert "ok" in r1.text

    r2 = await client.get("/api/v1/rl/status")
    s2 = r2.json()
    assert s2["running"] is False
    assert s2["episode_count"] == 1
    assert len(s2["reward_history"]) == 1


@pytest.mark.asyncio
async def test_status_returns_empty_when_no_training(client: AsyncClient) -> None:
    r = await client.get("/api/v1/rl/status")
    assert r.status_code == 200
    s = r.json()
    for key in ("running", "step", "episode_count", "last_reward", "reward_history"):
        assert key in s